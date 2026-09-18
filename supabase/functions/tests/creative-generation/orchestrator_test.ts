import { assertEquals, assert } from "jsr:@std/assert@1.0.8";
import { runCreativeGeneration, type GenerationDependencies } from "../../creative-generation/orchestrator.ts";
import type { GenerationRepository, GenerationJob, StoredCreativeBrief, CreativeBriefInsert } from "../../creative-generation/repository.ts";
import type { CandidateEvidenceInput, CreativeBriefOutput, EvidenceSnapshot } from "../../creative-generation/types.ts";
import type { GenerationConfig } from "../../creative-generation/config.ts";

const config = {
  id: "config-1",
  version: "m5-v1",
  classifier_config: {
    version: "classifier-v1", model: "gpt-5.6-luna", reasoning: "low", confidence_threshold: 0.75,
    keywords: { match: ["goal"], news: ["injury"], analysis: ["tactical"] },
    phase_keywords: { PRE_MATCH: ["lineup"], LIVE: ["goal"], POST_MATCH: ["full time"] },
  },
  generation_config: { model: "gpt-5.6-terra", reasoning: "medium", max_output_tokens: 5000 },
  mode_configs: {
    NEWS_UPDATE: { evidence_policy: "STRICT", prompt_version: "news-v1" },
    ANALYSIS_CONTEXT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "analysis-v1" },
    MATCH_CONTENT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "match-v1" },
  },
  quality_gate_config: { min_slides: 4, max_slides: 7, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true },
} as unknown as GenerationConfig;

const output: CreativeBriefOutput = {
  schema_version: "1.0", content_mode: "ANALYSIS_CONTEXT", match_phase: null, generation_quality: "FULL",
  angle: "Why the moment matters", key_takeaway: "A grounded takeaway",
  hooks: [1, 2, 3].map((id) => ({ id: `hook_${id}`, text: `Hook ${id}` })),
  slides: Array.from({ length: 4 }, (_, index) => ({
    slide_number: index + 1, purpose: index === 0 ? "HOOK" : "DETAIL", headline: `Headline ${index + 1}`, body: `Body ${index + 1}`,
    claims: [{ claim_id: `claim_${index + 1}`, type: "FACT" as const, text: "Evidence-backed fact", evidence_ids: ["post:post-1"] }],
    visual_direction: { subject: "United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline"] },
  })),
  caption: { body: "Caption", cta: "Your view?" }, sources: [{ evidence_id: "post:post-1", label: "utdreport" }],
};

function evidence(overrides: Partial<CandidateEvidenceInput> = {}): CandidateEvidenceInput {
  return {
    candidate: { id: "candidate-1", story_cluster_id: "cluster-1", ranking_date: "2026-09-18", rank: 1, priority_score: 90, data_confidence: 90, first_mover_flag: true, must_cover_flag: false, korea_coverage_status: "KNOWN", score_version: "v1", score_inputs: { global_coverage: 0.8 } },
    story: { id: "cluster-1", canonical_title: "Why United struggled tactically", status: "ACTIVE", first_seen_at: "2026-09-18T08:00:00Z", last_seen_at: "2026-09-18T09:00:00Z" },
    posts: [{ raw_post_id: "post-1", source_account_id: "account-1", account_username: "utdreport", region: "GLOBAL", caption: "Why United struggled tactically", permalink: "https://test/post-1", published_at: "2026-09-18T09:00:00Z", media_type: "IMAGE" }],
    sources: [],
    ...overrides,
  };
}

class MemoryRepository implements GenerationRepository {
  candidate = evidence();
  jobs: GenerationJob[] = [];
  briefs: StoredCreativeBrief[] = [];
  leaseOwners = new Set<string>();
  config: unknown = config;
  async getCandidateEvidence() { return this.candidate; }
  async getActiveConfig() { return this.config; }
  async findReadyBrief(candidateId: string, fingerprint: string) { return this.briefs.find((brief) => brief.candidate_id === candidateId && brief.input_fingerprint === fingerprint && brief.status === "READY") ?? null; }
  async getJob(candidateId: string, fingerprint: string) { return this.jobs.find((job) => job.candidate_id === candidateId && job.input_fingerprint === fingerprint) ?? null; }
  async insertJob(input: Omit<GenerationJob, "id">) { const existing = await this.getJob(input.candidate_id, input.input_fingerprint); if (existing) return existing; const job = { ...input, id: `job-${this.jobs.length + 1}` }; this.jobs.push(job); return job; }
  async acquireLease(jobId: string) { if (this.leaseOwners.has(jobId)) return false; this.leaseOwners.add(jobId); return true; }
  async updateJob(jobId: string, patch: Partial<GenerationJob>) { const job = this.jobs.find((entry) => entry.id === jobId)!; Object.assign(job, patch); }
  async nextRevision(candidateId: string) { return Math.max(0, ...this.briefs.filter((brief) => brief.candidate_id === candidateId).map((brief) => brief.version)) + 1; }
  async insertCreativeBrief(input: CreativeBriefInsert) { const brief = { ...input, id: `brief-${this.briefs.length + 1}` }; this.briefs.push(brief); return brief; }
}

function dependencies(repository: MemoryRepository, overrides: Partial<GenerationDependencies> = {}): GenerationDependencies {
  return {
    repository,
    provider: {
      classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }),
      generate: async () => output,
      repair: async () => output,
    },
    workerId: "worker-1",
    now: () => new Date("2026-09-18T10:00:00Z"),
    ...overrides,
  };
}

Deno.test("persists READY brief then returns NOOP for same fingerprint", async () => {
  const repository = new MemoryRepository();
  let generations = 0;
  const deps = dependencies(repository, { provider: { ...dependencies(repository).provider, generate: async () => { generations += 1; return output; } } });
  const first = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps);
  const second = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "NOTION_SELECTED" }, deps);
  assertEquals(first.status, "READY");
  assertEquals(second.status, "NOOP");
  assertEquals(generations, 1);
  assertEquals(repository.briefs[0]?.version, 1);
});

Deno.test("changed evidence creates the next revision", async () => {
  const repository = new MemoryRepository();
  const deps = dependencies(repository);
  assertEquals((await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps)).status, "READY");
  repository.candidate = evidence({ posts: [{ ...repository.candidate.posts[0]!, caption: "A changed tactical evidence" }] });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps);
  assertEquals(result.status, "READY");
  assertEquals(repository.briefs.length, 2);
  assertEquals(repository.briefs[1]?.version, 2);
});

Deno.test("concurrent triggers share one leased generation", async () => {
  const repository = new MemoryRepository();
  let generations = 0;
  const deps = dependencies(repository, { provider: { ...dependencies(repository).provider, generate: async () => { generations += 1; await new Promise((resolve) => setTimeout(resolve, 10)); return output; } } });
  const results = await Promise.all([
    runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps),
    runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "NOTION_SELECTED" }, deps),
  ]);
  assertEquals(generations, 1);
  assert(results.some((result) => result.status === "READY"));
  assert(results.some((result) => result.status === "CONCURRENT" || result.status === "NOOP"));
});

Deno.test("blocks strict NEWS_UPDATE without reliable evidence", async () => {
  const repository = new MemoryRepository();
  repository.candidate = evidence({ story: { ...repository.candidate.story, canonical_title: "Mount injury update" }, posts: [{ ...repository.candidate.posts[0]!, caption: "Mount injury update" }] });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(repository));
  assertEquals(result.status, "BLOCKED_EVIDENCE");
});

Deno.test("returns CLASSIFICATION_UNCERTAIN when fallback is below threshold", async () => {
  const repository = new MemoryRepository();
  repository.candidate = evidence({ story: { ...repository.candidate.story, canonical_title: "Big Manchester update" }, posts: [{ ...repository.candidate.posts[0]!, caption: "Big Manchester update" }] });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(repository, { provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.2, reason_code: "WEAK" }) } }));
  assertEquals(result.status, "CLASSIFICATION_UNCERTAIN");
});

Deno.test("returns FAILED_VALIDATION and FAILED_PROVIDER safely", async () => {
  const repository = new MemoryRepository();
  const invalidOutput = { ...output, hooks: [] };
  const invalid = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(repository, { provider: { ...dependencies(repository).provider, generate: async () => invalidOutput, repair: async () => invalidOutput } }));
  assertEquals(invalid.status, "FAILED_VALIDATION");
  const providerFailure = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(new MemoryRepository(), { provider: { ...dependencies(repository).provider, generate: async () => { throw new Error("provider detail"); } } }));
  assertEquals(providerFailure.status, "FAILED_PROVIDER");
});
