import { assertEquals, assert } from "jsr:@std/assert@1.0.8";
import { qualityConfig, runCreativeGeneration, type GenerationDependencies } from "../../creative-generation/orchestrator.ts";
import type { GenerationRepository, GenerationJob, StoredCreativeBrief, CreativeBriefInsert } from "../../creative-generation/repository.ts";
import type { CandidateEvidenceInput, CreativeBriefOutput, EvidenceSnapshot } from "../../creative-generation/types.ts";
import type { GenerationConfig } from "../../creative-generation/config.ts";
import { DEFAULT_EXPLORATION_CONFIG } from "../../creative-generation/exploration.ts";
import { ProviderError } from "../../creative-generation/provider.ts";

const EXPLORATION_COST_CONFIG = {
  ...DEFAULT_EXPLORATION_CONFIG,
  enabled: true,
  inputCostPerMillionUsd: 1,
  outputCostPerMillionUsd: 2,
};

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

Deno.test("Exploration quality config uses mode-specific bounds while STANDARD remains configured", () => {
  const news = qualityConfig(config, "EXPLORATION", DEFAULT_EXPLORATION_CONFIG, "NEWS_UPDATE");
  const analysis = qualityConfig(config, "EXPLORATION", DEFAULT_EXPLORATION_CONFIG, "ANALYSIS_CONTEXT");
  const match = qualityConfig(config, "EXPLORATION", DEFAULT_EXPLORATION_CONFIG, "MATCH_CONTENT");
  const standard = qualityConfig(config, "STANDARD", DEFAULT_EXPLORATION_CONFIG, "ANALYSIS_CONTEXT");
  assertEquals([news.min_slides, news.max_slides], [2, 4]);
  assertEquals([analysis.min_slides, analysis.max_slides], [4, 6]);
  assertEquals([match.min_slides, match.max_slides], [3, 5]);
  assertEquals([standard.min_slides, standard.max_slides], [4, 7]);
  assertEquals(news.max_repair_attempts, 0);
  assertEquals(standard.max_repair_attempts, 1);
});

function evidence(overrides: Partial<CandidateEvidenceInput> = {}): CandidateEvidenceInput {
  return {
    candidate: { id: "candidate-1", story_cluster_id: "cluster-1", ranking_date: "2026-09-18", rank: 1, priority_score: 90, data_confidence: 90, first_mover_flag: true, must_cover_flag: false, korea_coverage_status: "KNOWN", score_version: "v1", score_inputs: { global_coverage: 0.8 }, editorial_ranking: { story_cluster_id: "cluster-1", ranking_date: "2026-09-18", ranking_version: "m8-v1", rank: 1, editorial_score: 86, news_eligible: true } },
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
  requestedRankingDate = "";
  explorationCandidateListingCalls = 0;
  dailyExplorationLimit = 10;
  async getCandidateEvidence() { return this.candidate; }
  async getActiveConfig() { return this.config; }
  async findReadyBrief(candidateId: string, fingerprint: string) { return this.briefs.find((brief) => brief.candidate_id === candidateId && brief.input_fingerprint === fingerprint && brief.status === "READY") ?? null; }
  async findExplorationBrief(fingerprint: string) { return this.briefs.find((brief) => brief.exploration_fingerprint === fingerprint && (brief.status === "DRAFT" || brief.status === "READY")) ?? null; }
  async findExistingBriefForStory(storyClusterId: string, urls: readonly string[]) {
    const wanted = new Set(urls);
    return this.briefs.find((brief) => {
      const metadata = brief.generation_metadata && typeof brief.generation_metadata === "object"
        ? brief.generation_metadata as Record<string, unknown>
        : {};
      if (metadata.generation_intent === "EXPLORATION" || brief.exploration_fingerprint) return false;
      if (brief.status !== "DRAFT" && brief.status !== "READY") return false;
      if (brief.evidence_snapshot && typeof brief.evidence_snapshot === "object") {
        const snapshot = brief.evidence_snapshot as EvidenceSnapshot;
        if (snapshot.story.id === storyClusterId && snapshot.sources.some((source) => source.canonical_url && wanted.has(source.canonical_url))) return true;
        if (snapshot.story.id === storyClusterId && (snapshot.exploration_articles ?? []).some((article) => wanted.has(article.canonical_url))) return true;
      }
      return false;
    }) ?? null;
  }
  async getJob(candidateId: string, fingerprint: string) { return this.jobs.find((job) => job.candidate_id === candidateId && job.input_fingerprint === fingerprint) ?? null; }
  async getJobById(jobId: string) { return this.jobs.find((job) => job.id === jobId) ?? null; }
  async insertJob(input: Omit<GenerationJob, "id">) { const existing = this.jobs.find((job) => job.candidate_id === input.candidate_id && job.input_fingerprint === input.input_fingerprint); if (existing) return existing; const job = { ...input, id: `job-${this.jobs.length + 1}` }; this.jobs.push(job); return job; }
  async reserveExplorationJob(input: { candidate_id: string; exploration_fingerprint: string; trigger_type: GenerationJob["trigger_type"]; now: Date; daily_limit: number }) {
    const existing = this.jobs.find((job) => job.exploration_fingerprint === input.exploration_fingerprint);
    if (existing) {
      if (["FAILED_PROVIDER", "FAILED_VALIDATION", "BLOCKED_EVIDENCE", "CLASSIFICATION_UNCERTAIN"].includes(existing.status)) {
        Object.assign(existing, { candidate_id: input.candidate_id, trigger_type: input.trigger_type, status: "QUEUED", lease_owner: null, lease_expires_at: null, last_error_category: null, completed_at: null, created_at: input.now.toISOString() });
        return { status: "RESERVED" as const, job_id: existing.id };
      }
      return { status: "EXISTING" as const, job_id: existing.id };
    }
    const reserved = this.jobs.filter((job) => job.generation_intent === "EXPLORATION" && ["QUEUED", "GENERATING", "DRAFT", "READY"].includes(job.status)).length;
    if (reserved >= Math.min(input.daily_limit, this.dailyExplorationLimit)) return { status: "DAILY_LIMIT" as const };
    const job = await this.insertJob({ candidate_id: input.candidate_id, input_fingerprint: input.exploration_fingerprint, exploration_fingerprint: input.exploration_fingerprint, generation_intent: "EXPLORATION", trigger_type: input.trigger_type, status: "QUEUED", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: null, created_at: input.now.toISOString(), updated_at: input.now.toISOString(), completed_at: null });
    return { status: "RESERVED" as const, job_id: job.id };
  }
  async acquireLease(jobId: string) { if (this.leaseOwners.has(jobId)) return false; this.leaseOwners.add(jobId); return true; }
  async updateJob(jobId: string, patch: Partial<GenerationJob>) { const job = this.jobs.find((entry) => entry.id === jobId)!; Object.assign(job, patch); }
  async nextRevision(candidateId: string) { return Math.max(0, ...this.briefs.filter((brief) => brief.candidate_id === candidateId).map((brief) => brief.version)) + 1; }
  async insertCreativeBrief(input: CreativeBriefInsert) { const brief = { ...input, id: `brief-${this.briefs.length + 1}` }; this.briefs.push(brief); return brief; }
  async listPriorityCandidateIds(rankingDate: string) { this.requestedRankingDate = rankingDate; return []; }
  async listExplorationCandidateIds(_runAt: Date) { this.explorationCandidateListingCalls += 1; return []; }
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
  const providerHttpFailure = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(new MemoryRepository(), { provider: { ...dependencies(repository).provider, generate: async () => { throw new ProviderError("FAILED_PROVIDER", 429); } } }));
  assertEquals(providerHttpFailure.provider_failure, { category: "FAILED_PROVIDER", http_status: 429 });
});

Deno.test("AUTO_PRIORITY requires an eligible editorial ranking", async () => {
  const repository = new MemoryRepository();
  repository.candidate = evidence({ candidate: { ...repository.candidate.candidate, first_mover_flag: true, must_cover_flag: true, editorial_ranking: { ...repository.candidate.candidate.editorial_ranking!, news_eligible: false } } });
  let providerCalls = 0;
  const deps = dependencies(repository, { provider: { ...dependencies(repository).provider, classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 1, reason_code: "TEST" }; } } });
  assertEquals((await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, deps)).status, "NOT_ELIGIBLE");
  assertEquals(providerCalls, 0);
});

Deno.test("AUTO_PRIORITY does not require M4 flags when M8 rank is eligible", async () => {
  const repository = new MemoryRepository();
  repository.candidate = evidence({ candidate: { ...repository.candidate.candidate, first_mover_flag: null, must_cover_flag: null } });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, dependencies(repository));
  assertEquals(result.status, "READY");
});

function explorationCandidate(overrides: Partial<CandidateEvidenceInput> = {}): CandidateEvidenceInput {
  const body = "BBC Sport reports Manchester United are considering a move for the player, but no agreement has been reached. This remains a rumor and the club has not confirmed a transfer. " + "The article says the report is based on current interest and describes no completed negotiations. ".repeat(5);
  return evidence({
    candidate: { ...evidence().candidate, editorial_ranking: { ...evidence().candidate.editorial_ranking!, news_eligible: false } },
    story: { ...evidence().story, canonical_title: "Manchester United transfer report", status: "ACTIVE" },
    exploration_articles: [{
      source_observation_id: "observation-1",
      publisher_name: "BBC Sport",
      canonical_url: "https://bbc.test/article/1",
      published_at: "2026-09-18T09:00:00Z",
      observed_at: "2026-09-18T09:01:00Z",
      extraction_status: "EXTRACTED",
      article_text: body,
      content_fingerprint: "exploration-article-1",
      modality: "RUMOR",
      verified: false,
    }],
    ...overrides,
  });
}

function explorationOutput(mode: CreativeBriefOutput["content_mode"]): CreativeBriefOutput {
  const statements = [
    "BBC Sport 보도에 따르면 맨유의 관심은 아직 루머 단계이며 영입이 확정된 것은 아닙니다.",
    "BBC Sport 보도에 따르면 맨유의 관심설이 전해졌지만 공식 영입 발표는 없습니다.",
    "BBC Sport 보도에 따르면 현재 확인된 내용은 맨유의 관심 보도입니다.",
    "BBC Sport 보도에 따르면 관심은 루머로 분류되며 영입 여부는 확정되지 않았습니다.",
    "BBC Sport 보도에 따르면 관련 영입 발표는 아직 나오지 않았습니다.",
    "BBC Sport 보도에 따르면 관심 보도와 공식 발표는 구분해야 합니다.",
  ];
  const count = mode === "ANALYSIS_CONTEXT" ? 4 : mode === "NEWS_UPDATE" ? 3 : 3;
  const roles = ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION", "KEY_FACT", "IMPLICATION"] as const;
  return {
    ...output,
    content_mode: mode,
    match_phase: mode === "MATCH_CONTENT" ? "LIVE" : null,
    hooks: [1, 2, 3].map((id) => ({ id: `hook-${id}`, text: `BBC Sport 보도: 맨유 관심 루머 ${id}` })),
    slides: Array.from({ length: count }, (_, index) => ({
      slide_number: index + 1,
      purpose: roles[index],
      role: roles[index],
      headline: `BBC Sport 보도: 맨유 관심 루머 ${index + 1}`,
      body: `${statements[index]} https://bbc.test/article/1`,
      claims: [{ claim_id: `claim-${index + 1}`, type: "FACT" as const, text: statements[index], evidence_ids: ["article:observation-1"] }],
      visual_direction: { subject: "Manchester United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline", "body"] },
    })),
    caption: { body: `${statements[0]} https://bbc.test/article/1 #ManUtd #MUFC`, cta: "의견을 남겨주세요" },
    sources: [{ evidence_id: "article:observation-1", label: "BBC Sport", url: "https://bbc.test/article/1" }],
    editor_warning: "미승인 출처 보도입니다. 편집자가 원문과 사실을 확인해야 합니다.",
  };
}

Deno.test("Exploration is disabled unless the explicit feature flag is enabled", async () => {
  const repository = new MemoryRepository();
  let providerCalls = 0;
  const deps = {
    ...dependencies(repository),
    provider: {
      ...dependencies(repository).provider,
      classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.95, reason_code: "MODEL" }; },
      generate: async () => { providerCalls += 1; return output; },
    },
    explorationConfig: DEFAULT_EXPLORATION_CONFIG,
  } as unknown as GenerationDependencies;
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" } as never, deps);
  assertEquals(result.status, "EXPLORATION_DISABLED");
  assertEquals(providerCalls, 0);
});

Deno.test("Exploration refuses generation until both cost rates are configured", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate();
  let providerCalls = 0;
  const result = await runCreativeGeneration(
    { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" },
    dependencies(repository, {
      explorationConfig: { ...DEFAULT_EXPLORATION_CONFIG, enabled: true, inputCostPerMillionUsd: null, outputCostPerMillionUsd: null },
      provider: {
        ...dependencies(repository).provider,
        classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }; },
        generate: async () => { providerCalls += 1; return explorationOutput("ANALYSIS_CONTEXT"); },
      },
    }),
  );
  assertEquals(result.status, "EXPLORATION_COST_RATES_REQUIRED");
  assertEquals(providerCalls, 0);
  assertEquals(repository.jobs.length, 0);
});

Deno.test("Exploration gives the classifier a zero-retry request budget", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate({
    posts: [{ ...explorationCandidate().posts[0]!, caption: "Manchester United transfer report" }],
  });
  let classifierOptions: unknown;
  const result = await runCreativeGeneration(
    { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" },
    dependencies(repository, {
      explorationConfig: EXPLORATION_COST_CONFIG,
      provider: {
        ...dependencies(repository).provider,
        classify: async (_text: string, _config: unknown, options: unknown) => {
          classifierOptions = options;
          return { content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.95, reason_code: "MODEL" };
        },
        generate: async () => explorationOutput("ANALYSIS_CONTEXT"),
      },
    }),
  );
  assertEquals(result.status, "DRAFT");
  assertEquals(classifierOptions, { maxRetries: 0 });
});

Deno.test("manual analysis override requires an existing uncertain Exploration job", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate();
  let providerCalls = 0;
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION", content_mode_override: "ANALYSIS_CONTEXT" }, dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: {
      ...dependencies(repository).provider,
      classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }; },
      generate: async () => { providerCalls += 1; return explorationOutput("ANALYSIS_CONTEXT"); },
    },
  }));
  assertEquals(result.status, "FAILED_VALIDATION");
  assertEquals(result.error_codes, ["MANUAL_MODE_OVERRIDE_REQUIRES_UNCERTAIN_JOB"]);
  assertEquals(providerCalls, 0);
  assertEquals(repository.jobs.length, 0);
});

Deno.test("manual analysis override resumes an uncertain Exploration without repeating classification or losing usage", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate({ posts: [] });
  const usage = { provider_calls: 0, input_tokens: 0, output_tokens: 0, retry_count: 0 };
  let classifierCalls = 0;
  let generationCalls = 0;
  const deps = dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: {
      ...dependencies(repository).provider,
      getUsageStats: () => ({ ...usage }),
      classify: async () => {
        classifierCalls += 1;
        usage.provider_calls += 1;
        usage.input_tokens += 2_721;
        usage.output_tokens += 63;
        return { content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.2, reason_code: "WEAK" };
      },
      generate: async () => {
        generationCalls += 1;
        usage.provider_calls += 1;
        usage.input_tokens += 1_200;
        usage.output_tokens += 1_500;
        return explorationOutput("ANALYSIS_CONTEXT");
      },
    },
  });
  const first = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps);
  assertEquals(first.status, "CLASSIFICATION_UNCERTAIN");
  assertEquals(repository.jobs[0]?.provider_calls, 1);
  repository.leaseOwners.clear();

  const resumed = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION", content_mode_override: "ANALYSIS_CONTEXT" } as never, deps);

  assertEquals(resumed.status, "DRAFT");
  assertEquals(classifierCalls, 1);
  assertEquals(generationCalls, 1);
  assertEquals(repository.jobs[0]?.provider_calls, 2);
  assertEquals(repository.jobs[0]?.input_tokens, 3_921);
  assertEquals(repository.jobs[0]?.output_tokens, 1_563);
  assertEquals(repository.jobs[0]?.estimated_cost_usd, 0.007047);
  assertEquals(repository.briefs[0]?.provider_calls, 2);
  assertEquals(repository.briefs[0]?.input_tokens, 3_921);
  assertEquals(repository.briefs[0]?.output_tokens, 1_563);
  assertEquals(repository.briefs[0]?.estimated_cost_usd, 0.007047);
});

Deno.test("Exploration fails validation without a paid repair request", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate();
  let repairCalls = 0;
  const deps = dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: {
      ...dependencies(repository).provider,
      classify: async () => ({ content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.95, reason_code: "MODEL" }),
      generate: async () => ({ ...explorationOutput("ANALYSIS_CONTEXT"), hooks: [] }),
      repair: async () => { repairCalls += 1; return explorationOutput("ANALYSIS_CONTEXT"); },
    },
  });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps);
  assertEquals(result.status, "FAILED_VALIDATION");
  assertEquals(repairCalls, 0);
});

Deno.test("Exploration intent always saves all content modes as DRAFT", async () => {
  for (const mode of ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"] as const) {
    const repository = new MemoryRepository();
    repository.candidate = explorationCandidate({
      posts: [{ ...explorationCandidate().posts[0]!, caption: "Manchester United transfer update" }],
    });
    const deps = {
      ...dependencies(repository),
      explorationConfig: EXPLORATION_COST_CONFIG,
      provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: mode, match_phase: mode === "MATCH_CONTENT" ? "LIVE" as const : null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => explorationOutput(mode) },
    } as unknown as GenerationDependencies;
    const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" } as never, deps);
    assertEquals(result.status, "DRAFT", `${mode}: ${JSON.stringify(result)}`);
    assertEquals(repository.briefs[0]?.status, "DRAFT", mode);
  }
});

Deno.test("Exploration blocks missing article body and archived stories before any provider call", async () => {
  for (const candidate of [
    explorationCandidate({ exploration_articles: [{ ...explorationCandidate().exploration_articles![0]!, article_text: null }] }),
    explorationCandidate({ story: { ...explorationCandidate().story, status: "ARCHIVED" } }),
  ]) {
    const repository = new MemoryRepository();
    repository.candidate = candidate;
    let providerCalls = 0;
    const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, dependencies(repository, {
      explorationConfig: EXPLORATION_COST_CONFIG,
      provider: { ...dependencies(repository).provider, classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }; }, generate: async () => { providerCalls += 1; return explorationOutput("ANALYSIS_CONTEXT"); } },
    }));
    assertEquals(result.status, "BLOCKED_EVIDENCE");
    assertEquals(providerCalls, 0);
  }
});

Deno.test("Exploration remains DRAFT for a fresh article attached to a STALE story", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate({ story: { ...explorationCandidate().story, status: "STALE" } });
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => explorationOutput("ANALYSIS_CONTEXT") },
  }));
  assertEquals(result.status, "DRAFT");
});

Deno.test("historical Exploration is available only through one-story MANUAL review", async () => {
  const older = explorationCandidate({ exploration_articles: [{ ...explorationCandidate().exploration_articles![0]!, published_at: "2026-09-01T09:00:00Z" }] });
  const automaticRepository = new MemoryRepository();
  automaticRepository.candidate = older;
  let automaticCalls = 0;
  const autoResult = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY", generation_intent: "EXPLORATION" }, dependencies(automaticRepository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: { ...dependencies(automaticRepository).provider, classify: async () => { automaticCalls += 1; return { content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }; } },
  }));
  assertEquals(autoResult.status, "BLOCKED_EVIDENCE");
  assertEquals(automaticCalls, 0);

  const manualRepository = new MemoryRepository();
  manualRepository.candidate = older;
  const manualResult = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, dependencies(manualRepository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: { ...dependencies(manualRepository).provider, classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => explorationOutput("ANALYSIS_CONTEXT") },
  }));
  assertEquals(manualResult.status, "DRAFT");
  assertEquals((manualRepository.briefs[0]?.generation_metadata as Record<string, unknown>).trigger_type, "MANUAL");
  assertEquals((manualRepository.briefs[0]?.generation_metadata as Record<string, unknown>).historical_review, true);
  assertEquals((manualRepository.briefs[0]?.evidence_snapshot as EvidenceSnapshot).exploration_articles?.[0]?.published_at, "2026-09-01T09:00:00Z");
});

Deno.test("story-level fingerprint prevents duplicate drafts across candidate dates", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate();
  let generations = 0;
  const deps = dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => { generations += 1; return explorationOutput("ANALYSIS_CONTEXT"); } },
  });
  assertEquals((await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps)).status, "DRAFT");
  repository.candidate = explorationCandidate({ candidate: { ...explorationCandidate().candidate, id: "candidate-next-day", ranking_date: "2026-09-19" } });
  const repeated = await runCreativeGeneration({ candidate_id: "candidate-next-day", trigger_type: "AUTO_PRIORITY", generation_intent: "EXPLORATION" }, deps);
  assertEquals(repeated.status, "NOOP");
  assertEquals(generations, 1);
  assertEquals(repository.briefs[0]?.status, "DRAFT");
});

Deno.test("new facts for the same story allow a revised exploration draft", async () => {
  const repository = new MemoryRepository();
  const original = explorationCandidate();
  repository.candidate = original;
  let generations = 0;
  const deps = dependencies(repository, {
    explorationConfig: EXPLORATION_COST_CONFIG,
    provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => { generations += 1; return explorationOutput("ANALYSIS_CONTEXT"); } },
  });
  const first = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps);
  const originalArticle = original.exploration_articles![0]!;
  repository.candidate = explorationCandidate({ exploration_articles: [{
    ...originalArticle,
    article_text: `${originalArticle.article_text} A later update adds a new confirmed detail about the same report.`,
    content_fingerprint: "exploration-article-1-revised",
  }] });
  const revised = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps);

  assertEquals(first.status, "DRAFT");
  assertEquals(revised.status, "DRAFT");
  assertEquals(revised.input_fingerprint === first.input_fingerprint, false);
  assertEquals(revised.revision, 2);
  assertEquals(repository.briefs.length, 2);
  assertEquals(generations, 2);
});

Deno.test("existing READY brief for the same article is reused without demotion", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate({ sources: [{
    source_id: "verified-bbc", canonical_name: "BBC Sport", entity_type: "MEDIA_OUTLET", reliability_score: 10,
    evidence_text: "BBC Sport reported the rumor.", first_cited_post_id: null, citation_count: 1,
    claim_id: "claim-bbc", editorial_role: "FACT_INDEPENDENT", relation: "SUPPORTS", is_grounding: true,
    claim_scope: "PUBLISHER_REPORT", claim_modality: "RUMOR", canonical_url: "https://bbc.test/article/1", verified: true,
  }] });
  const readySnapshot = (await import("../../creative-generation/evidence.ts")).buildEvidenceSnapshot(repository.candidate);
  repository.briefs.push({ id: "ready-existing", candidate_id: "candidate-1", version: 1, status: "READY", evidence_snapshot: readySnapshot, input_fingerprint: "previous", slides_json: {}, design_json: {}, caption_draft: "", cta: "", headline: "", angle: "", format: "INSTAGRAM_CAROUSEL", slide_count: 3, content_mode: "NEWS_UPDATE", match_phase: null, generation_config_id: "config-1", hooks_json: [], grounding_json: {}, generation_metadata: {}, generation_quality: "FULL", model_name: "model", generated_at: "2026-09-18T09:30:00Z" } as StoredCreativeBrief);
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, dependencies(repository, { explorationConfig: { ...DEFAULT_EXPLORATION_CONFIG, enabled: true } }));
  assertEquals(result.status, "NOOP");
  assertEquals(repository.briefs[0]?.status, "READY");
  assertEquals(repository.briefs.length, 1);
});

Deno.test("daily Exploration cap is enforced before provider calls", async () => {
  const repository = new MemoryRepository();
  repository.dailyExplorationLimit = 1;
  repository.candidate = explorationCandidate();
  const deps = dependencies(repository, {
    explorationConfig: { ...EXPLORATION_COST_CONFIG, maxDraftsPerDay: 1 },
    provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.95, reason_code: "MODEL" }), generate: async () => explorationOutput("ANALYSIS_CONTEXT") },
  });
  assertEquals((await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, deps)).status, "DRAFT");
  repository.candidate = explorationCandidate({ candidate: { ...explorationCandidate().candidate, id: "candidate-2", story_cluster_id: "cluster-2" }, story: { ...explorationCandidate().story, id: "cluster-2" } });
  let calls = 0;
  const cappedDeps = { ...deps, provider: { ...deps.provider, classify: async () => { calls += 1; return { content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.95, reason_code: "MODEL" }; } } } as unknown as GenerationDependencies;
  assertEquals((await runCreativeGeneration({ candidate_id: "candidate-2", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, cappedDeps)).status, "DAILY_LIMIT");
  assertEquals(calls, 0);
});

Deno.test("provider calls and token-based cost are stored on both the brief and generation job", async () => {
  const repository = new MemoryRepository();
  repository.candidate = explorationCandidate();
  let providerCalls = 0;
  const provider = {
    classify: async () => { providerCalls += 1; return { content_mode: "ANALYSIS_CONTEXT" as const, match_phase: null, confidence: 0.95, reason_code: "MODEL" }; },
    generate: async () => { providerCalls += 1; return explorationOutput("ANALYSIS_CONTEXT"); },
    repair: async () => explorationOutput("ANALYSIS_CONTEXT"),
    getUsageStats: () => ({ provider_calls: providerCalls, input_tokens: providerCalls * 1_000, output_tokens: providerCalls * 2_000, retry_count: providerCalls > 0 ? 1 : 0 }),
  };
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }, dependencies(repository, {
    explorationConfig: { ...DEFAULT_EXPLORATION_CONFIG, enabled: true, inputCostPerMillionUsd: 1, outputCostPerMillionUsd: 2 },
    provider,
  }));
  assertEquals(result.status, "DRAFT");
  assertEquals(repository.briefs[0]?.provider_calls, 1);
  assertEquals(repository.briefs[0]?.input_tokens, 1_000);
  assertEquals(repository.briefs[0]?.output_tokens, 2_000);
  assertEquals(repository.briefs[0]?.estimated_cost_usd, 0.005);
  assertEquals(repository.jobs[0]?.retry_count, 1);
});

Deno.test("manual NEWS_UPDATE with verified report but noneligible rank saves a review draft", async () => {
  const repository = new MemoryRepository();
  const sourceId = "m8-claim:claim-bbc:observation-bbc";
  const sourceUrl = "https://www.bbc.com/sport/football/article";
  repository.candidate = evidence({
    candidate: { ...repository.candidate.candidate, first_mover_flag: null, must_cover_flag: null, editorial_ranking: { ...repository.candidate.candidate.editorial_ranking!, news_eligible: false } },
    story: { ...repository.candidate.story, canonical_title: "United injury update" },
    posts: [{ ...repository.candidate.posts[0]!, caption: "United injury update" }],
    sources: [{ source_id: sourceId, canonical_name: "BBC Sport", entity_type: "MEDIA_OUTLET", reliability_score: 9, evidence_text: "BBC Sport reports that Sancho could join another club.", first_cited_post_id: null, citation_count: 1, claim_id: "claim-bbc", editorial_role: "FACT_INDEPENDENT", relation: "SUPPORTS", is_grounding: true, claim_scope: "PUBLISHER_REPORT", claim_modality: "RUMOR", canonical_url: sourceUrl, published_at: "2026-09-18T08:00:00Z", verified: true }],
  });
  const draftOutput: CreativeBriefOutput = {
    ...output,
    content_mode: "NEWS_UPDATE",
    slides: output.slides.map((slide, index) => ({ ...slide, body: index === 0 ? `BBC Sport 보도에 따르면 산초의 이적 가능성은 아직 확정되지 않았습니다. ${sourceUrl}` : slide.body, claims: [{ claim_id: `report-${index}`, type: "FACT", text: "BBC Sport가 산초의 이적 가능성을 보도했으며 아직 확정되지 않았다.", evidence_ids: [`source:${sourceId}`] }] })),
    caption: { body: `BBC Sport 보도에 따르면 산초의 이적 가능성은 아직 확정되지 않았습니다. ${sourceUrl}`, cta: "어떻게 보시나요?" },
    sources: [{ evidence_id: `source:${sourceId}`, label: "BBC Sport", url: sourceUrl }],
  };
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL" }, dependencies(repository, { provider: { ...dependencies(repository).provider, classify: async () => ({ content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.99, reason_code: "REPORTED_NEWS" }), generate: async () => draftOutput } }));
  assertEquals(result.status, "DRAFT");
  assertEquals(repository.briefs[0]?.status, "DRAFT");
  assertEquals(repository.jobs[0]?.status, "DRAFT");
});

Deno.test("priority runner requests ranking for the Seoul business date", async () => {
  const repository = new MemoryRepository();
  const { runPriorityCreativeGeneration } = await import("../../creative-generation/orchestrator.ts");
  await runPriorityCreativeGeneration(dependencies(repository));
  assertEquals(repository.requestedRankingDate, "2026-09-18");
});

Deno.test("priority runner does not start Exploration without its separate auto-mode switch", async () => {
  const repository = new MemoryRepository();
  const { runPriorityCreativeGeneration } = await import("../../creative-generation/orchestrator.ts");
  await runPriorityCreativeGeneration(dependencies(repository, {
    explorationConfig: { ...DEFAULT_EXPLORATION_CONFIG, enabled: true },
  }));
  assertEquals(repository.explorationCandidateListingCalls, 0);
});

Deno.test("stores the ManUtd Editor style identity on a canonical brief", async () => {
  const repository = new MemoryRepository();
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
    caption: { body: "산초의 다음 행선지는 어디가 될까요?", cta: "여러분의 생각은?" },
    sources: [{ evidence_id: "post:post-1", label: "utdreport" }], editor_warning: null,
    internal_grounding: { evidence_ids: ["post:post-1"], source_caveats: [], unsupported_claims: [] },
  };
  const result = await runCreativeGeneration({ candidate_id: "candidate-1", trigger_type: "MANUAL" }, dependencies(repository, { provider: { ...dependencies(repository).provider, generate: async () => styleOutput } }));
  assertEquals(result.status, "READY");
  assertEquals(repository.briefs[0]?.style_profile, "manutd_editor");
  assertEquals(repository.briefs[0]?.style_version, "manutd-editor-v1");
  assertEquals(repository.briefs[0]?.slide_count, 3);
});
