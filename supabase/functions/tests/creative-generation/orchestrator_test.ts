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
  async insertJob(input: Omit<GenerationJob, "id">) { const existing = this.jobs.find((job) => job.candidate_id === input.candidate_id && job.input_fingerprint === input.input_fingerprint); if (existing) return existing; const job = { ...input, id: `job-${this.jobs.length + 1}` }; this.jobs.push(job); return job; }
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

Deno.test("canonical READY generation does not invoke a projection consumer", async () => {
  const repository = new MemoryRepository();
  let projectionCalls = 0;
  const deps = {
    ...dependencies(repository),
    projectReady: async () => {
      projectionCalls += 1;
    },
  } as unknown as GenerationDependencies;

  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps);

  assertEquals(result.status, "READY");
  assertEquals(projectionCalls, 0);
  assertEquals(repository.briefs[0]?.status, "READY");
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

Deno.test("stores the ManUtd Editor style identity on a canonical brief", async () => {
  const repository = new MemoryRepository();
  repository.candidate = evidence({ posts: [{ ...repository.candidate.posts[0]!, caption: "Sancho has spent 3 months training at a 10th-division facility." }] });
  repository.config = {
    ...config,
    quality_gate_config: { min_slides: 3, max_slides: 4, hook_count: 3, max_repair_attempts: 0, require_visual_direction: true, style_profile: "manutd_editor", style_version: "manutd-editor-v1", enable_style_validator: true },
  };
  const styleOutput: CreativeBriefOutput = {
    schema_version: "1.0", style_profile: "manutd_editor", style_version: "manutd-editor-v1", content_mode: "ANALYSIS_CONTEXT", match_phase: null, generation_quality: "FULL",
    angle: "산초의 현재", key_takeaway: "새 팀을 찾는 시간이 길어지고 있다.",
    hooks: [{ id: "hook_1", text: "3개월째 소속팀 없는 산초" }, { id: "hook_2", text: "산초의 다음 행선지는?" }, { id: "hook_3", text: "아직 새 팀이 없다" }],
    slides: [
      { slide_number: 1, index: 1, purpose: "HOOK", role: "HOOK", headline: "3개월째 소속팀 없는 산초", highlight: "아직 새 팀이 없다", body: "", closing_line: null, claims: [{ claim_id: "claim_1", type: "FACT", text: "산초가 새 팀을 찾고 있다.", evidence_ids: ["post:post-1"] }], visual_direction: { subject: "산초", image_type: "photo", layout_intent: "headline first", stat_emphasis: "3개월", text_hierarchy: ["headline", "highlight"] } },
      { slide_number: 2, index: 2, purpose: "CONTEXT", role: "CONTEXT", headline: "자유 계약만 3개월째", highlight: null, body: "맨유와 계약이 끝난 뒤\n아직 새 소속팀을 찾지 못하고 있다.", closing_line: null, claims: [{ claim_id: "claim_2", type: "FACT", text: "산초가 새 팀을 찾고 있다.", evidence_ids: ["post:post-1"] }], visual_direction: { subject: "산초", image_type: "photo", layout_intent: "context card", stat_emphasis: null, text_hierarchy: ["headline", "body"] } },
      { slide_number: 3, index: 3, purpose: "KEY_FACT", role: "KEY_FACT", headline: "지금은 몸을 유지하는 중", highlight: "새 팀을 찾을 때까지", body: "훈련을 이어가며\n다음 기회를 기다리고 있다.", closing_line: null, claims: [{ claim_id: "claim_3", type: "FACT", text: "산초가 새 팀을 찾고 있다.", evidence_ids: ["post:post-1"] }], visual_direction: { subject: "훈련장", image_type: "training photo", layout_intent: "fact card", stat_emphasis: null, text_hierarchy: ["headline", "highlight", "body"] } },
    ],
    caption: { body: "산초의 다음 행선지는 어디가 될까요?", cta: "이 선수 맨유에 필요하다고 봄?" },
    sources: [{ evidence_id: "post:post-1", label: "utdreport" }], editor_warning: null,
    internal_grounding: { evidence_ids: ["post:post-1"], source_caveats: [], unsupported_claims: [] },
  };
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL" }, dependencies(repository, { provider: { ...dependencies(repository).provider, generate: async () => styleOutput } }));
  assertEquals(result.status, "READY");
  assertEquals(repository.briefs[0]?.style_profile, "manutd_editor");
  assertEquals(repository.briefs[0]?.style_version, "manutd-editor-v1");
  assertEquals(repository.briefs[0]?.slide_count, 3);
});
