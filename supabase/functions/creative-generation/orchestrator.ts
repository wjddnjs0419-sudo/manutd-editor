import { classifyWithFallback } from "./classifier.ts";
import { validateGenerationConfig, type GenerationConfig } from "./config.ts";
import { buildEvidenceSnapshot, verifiedNewsSources } from "./evidence.ts";
import { canonicalJson, hashGenerationInput, sha256 } from "./fingerprint.ts";
import { generateWithOneRepair } from "./quality_gate.ts";
import { businessDate } from "../_shared/m6/business_date.ts";
import { assessExplorationSnapshot, DEFAULT_EXPLORATION_CONFIG, explorationFingerprint, explorationSlideBounds, type ExplorationConfig } from "./exploration.ts";
import type { CreativeGenerationProvider, ProviderUsageStats } from "./provider.ts";
import type { GenerationRepository, GenerationJob, StoredCreativeBrief, TriggerType } from "./repository.ts";
import type { CandidateEvidenceInput, ContentMode, CreativeBriefOutput, EvidenceSnapshot, ExplorationArticleEvidenceInput, GenerationIntent } from "./types.ts";

export interface GenerationTrigger {
  readonly candidate_id: string;
  readonly trigger_type: TriggerType;
  readonly generation_intent?: GenerationIntent;
}

export type GenerationStatus = "READY" | "DRAFT" | "NOOP" | "CONCURRENT" | "DAILY_LIMIT" | "NOT_ELIGIBLE" | "EXPLORATION_DISABLED" | "EXPLORATION_COST_RATES_REQUIRED" | "BLOCKED_EVIDENCE" | "CLASSIFICATION_UNCERTAIN" | "FAILED_VALIDATION" | "FAILED_PROVIDER";

export interface GenerationResult {
  readonly status: GenerationStatus;
  readonly candidate_id: string;
  readonly creative_brief_id?: string;
  readonly revision?: number;
  readonly input_fingerprint?: string;
  readonly error_codes?: readonly string[];
}

export interface GenerationDependencies {
  readonly repository: GenerationRepository;
  readonly provider: CreativeGenerationProvider;
  readonly workerId: string;
  readonly now?: () => Date;
  readonly leaseSeconds?: number;
  readonly explorationConfig?: ExplorationConfig;
}

function evidenceText(snapshot: EvidenceSnapshot, intent: GenerationIntent): string {
  const articles = intent === "EXPLORATION" ? (snapshot.exploration_articles ?? []).map((article) => article.article_text ?? "") : [];
  return [snapshot.story.canonical_title ?? "", ...snapshot.posts.map((post) => post.caption ?? ""), ...articles].filter(Boolean).join("\n");
}

export function qualityConfig(config: GenerationConfig, intent: GenerationIntent, explorationConfig: ExplorationConfig, mode: ContentMode) {
  const value = config.quality_gate_config;
  const explorationBounds = explorationSlideBounds(mode);
  return {
    min_slides: intent === "EXPLORATION" ? explorationBounds.min : Number(value.min_slides ?? 4),
    max_slides: intent === "EXPLORATION" ? explorationBounds.max : Number(value.max_slides ?? 7), hook_count: Number(value.hook_count ?? 3),
    max_repair_attempts: intent === "EXPLORATION" ? 0 : Number(value.max_repair_attempts ?? 1), require_visual_direction: value.require_visual_direction !== false,
    style_profile: typeof value.style_profile === "string" ? value.style_profile : undefined,
    style_version: typeof value.style_version === "string" ? value.style_version : undefined,
    enable_style_validator: value.style_profile === "manutd_editor" && value.style_version === "manutd-editor-v1",
    ...(intent === "EXPLORATION" ? { exploration_config: explorationConfig, exploration_slide_bounds: explorationBounds } : {}),
  };
}

function strictNewsEvidence(snapshot: EvidenceSnapshot): boolean {
  return verifiedNewsSources(snapshot).length > 0;
}

function currentEditorialEligibility(input: CandidateEvidenceInput, now: Date): boolean {
  const ranking = input.candidate.editorial_ranking;
  const age = now.getTime() - Date.parse(input.story.last_seen_at);
  return Boolean(ranking && ranking.story_cluster_id === input.candidate.story_cluster_id && ranking.news_eligible === true &&
    ranking.ranking_date === businessDate(now, "Asia/Seoul") && ranking.ranking_date === input.candidate.ranking_date &&
    Number.isFinite(age) && age >= 0 && age <= 72 * 60 * 60 * 1000);
}

function uncertainFingerprint(candidateId: string, snapshot: EvidenceSnapshot, config: GenerationConfig): Promise<string> {
  return sha256(canonicalJson({ candidate_id: candidateId, evidence_snapshot: snapshot, generation_config_version: config.version, classification: "uncertain" }));
}

function jobInput(job: Omit<GenerationJob, "id">, now: Date): Omit<GenerationJob, "id"> {
  return { ...job, created_at: job.created_at || now.toISOString(), updated_at: job.updated_at || now.toISOString() };
}

function readProviderUsage(provider: CreativeGenerationProvider): ProviderUsageStats {
  return provider.getUsageStats?.() ?? { provider_calls: 0, input_tokens: 0, output_tokens: 0, retry_count: 0 };
}

function usageDelta(before: ProviderUsageStats, after: ProviderUsageStats, explorationConfig: ExplorationConfig) {
  const input_tokens = Math.max(0, after.input_tokens - before.input_tokens);
  const output_tokens = Math.max(0, after.output_tokens - before.output_tokens);
  const provider_calls = Math.max(0, after.provider_calls - before.provider_calls);
  const retry_count = Math.max(0, after.retry_count - before.retry_count);
  const estimated_cost_usd = explorationConfig.inputCostPerMillionUsd !== null && explorationConfig.outputCostPerMillionUsd !== null
    ? Number(((input_tokens * explorationConfig.inputCostPerMillionUsd + output_tokens * explorationConfig.outputCostPerMillionUsd) / 1_000_000).toFixed(6))
    : null;
  return { provider_calls, input_tokens, output_tokens, retry_count, estimated_cost_usd };
}

export async function runCreativeGeneration(trigger: GenerationTrigger, dependencies: GenerationDependencies): Promise<GenerationResult> {
  const now = dependencies.now ?? (() => new Date());
  const runAt = now();
  const intent = trigger.generation_intent ?? "STANDARD";
  const explorationConfig = dependencies.explorationConfig ?? DEFAULT_EXPLORATION_CONFIG;
  const reviewConfig = intent === "EXPLORATION" && trigger.trigger_type === "MANUAL"
    ? { ...explorationConfig, allowHistoricalReview: true }
    : explorationConfig;
  if (intent === "EXPLORATION" && !explorationConfig.enabled) return { status: "EXPLORATION_DISABLED", candidate_id: trigger.candidate_id };
  const evidenceInput = await dependencies.repository.getCandidateEvidence(trigger.candidate_id);
  if (!evidenceInput) return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, error_codes: ["CANDIDATE_NOT_FOUND"] };
  const rankingEligible = currentEditorialEligibility(evidenceInput, runAt);
  if (trigger.trigger_type === "AUTO_PRIORITY" && intent === "STANDARD" && !rankingEligible) return { status: "NOT_ELIGIBLE", candidate_id: trigger.candidate_id };
  const snapshot = buildEvidenceSnapshot(evidenceInput, intent === "EXPLORATION");
  let fingerprint: string | null = null;
  let job: GenerationJob | null = null;
  let leaseAcquired = false;
  let historicalReview = false;
  let eligibleExplorationArticles: readonly ExplorationArticleEvidenceInput[] = snapshot.exploration_articles ?? [];
  if (intent === "EXPLORATION") {
    const assessment = assessExplorationSnapshot(snapshot, runAt, reviewConfig);
    if (!assessment.eligible) return { status: "BLOCKED_EVIDENCE", candidate_id: trigger.candidate_id, error_codes: [assessment.reason ?? "EXPLORATION_EVIDENCE_MISSING"] };
    eligibleExplorationArticles = assessment.articles;
    historicalReview = trigger.trigger_type === "MANUAL" && assessment.articles.some((article) => {
      const publishedAt = article.published_at ? Date.parse(article.published_at) : Number.NaN;
      return Number.isFinite(publishedAt) && runAt.getTime() - publishedAt > explorationConfig.maxArticleAgeHours * 60 * 60 * 1000;
    });
    fingerprint = await explorationFingerprint(snapshot, assessment.articles);
    const existingExplorationBrief = await dependencies.repository.findExplorationBrief?.(fingerprint);
    if (existingExplorationBrief) return { status: "NOOP", candidate_id: trigger.candidate_id, creative_brief_id: existingExplorationBrief.id, revision: existingExplorationBrief.version, input_fingerprint: fingerprint };
    const existingStoryBrief = await dependencies.repository.findExistingBriefForStory?.(snapshot.story.id, assessment.articles.map((article) => article.canonical_url));
    if (existingStoryBrief) return { status: "NOOP", candidate_id: trigger.candidate_id, creative_brief_id: existingStoryBrief.id, revision: existingStoryBrief.version, input_fingerprint: fingerprint };
    if (![explorationConfig.inputCostPerMillionUsd, explorationConfig.outputCostPerMillionUsd]
      .every((rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0)) {
      return { status: "EXPLORATION_COST_RATES_REQUIRED", candidate_id: trigger.candidate_id };
    }
    if (dependencies.repository.reserveExplorationJob) {
      const reservation = await dependencies.repository.reserveExplorationJob({ candidate_id: trigger.candidate_id, exploration_fingerprint: fingerprint, trigger_type: trigger.trigger_type, now: runAt, daily_limit: explorationConfig.maxDraftsPerDay });
      if (reservation.status === "DAILY_LIMIT") return { status: "DAILY_LIMIT", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
      if (!reservation.job_id) return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: ["EXPLORATION_RESERVATION_MISSING_JOB"] };
      job = dependencies.repository.getJobById
        ? await dependencies.repository.getJobById(reservation.job_id)
        : await dependencies.repository.getJob(trigger.candidate_id, fingerprint);
      if (!job || job.id !== reservation.job_id) return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: ["EXPLORATION_RESERVATION_JOB_NOT_FOUND"] };
      if (reservation.status === "EXISTING" && job.status !== "QUEUED" && job.status !== "GENERATING") return { status: "CONCURRENT", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
      const leaseUntil = new Date(runAt.getTime() + (dependencies.leaseSeconds ?? 300) * 1000);
      if (!(await dependencies.repository.acquireLease(job.id, dependencies.workerId, runAt, leaseUntil))) return { status: "CONCURRENT", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
      leaseAcquired = true;
      await dependencies.repository.updateJob(job.id, { status: "GENERATING", attempt_count: job.attempt_count + 1, lease_owner: dependencies.workerId, lease_expires_at: leaseUntil.toISOString() });
      job = { ...job, status: "GENERATING", attempt_count: job.attempt_count + 1, lease_owner: dependencies.workerId, lease_expires_at: leaseUntil.toISOString() };
    }
  }
  const rawConfig = await dependencies.repository.getActiveConfig();
  const config = validateGenerationConfig(rawConfig);
  dependencies.provider.configure?.(config);
  const usageBefore = readProviderUsage(dependencies.provider);
  const currentUsage = () => usageDelta(usageBefore, readProviderUsage(dependencies.provider), explorationConfig);
  const classification = await classifyWithFallback(
    evidenceText(snapshot, intent),
    config.classifier_config,
    dependencies.provider,
    intent === "EXPLORATION" ? { maxRetries: 0 } : undefined,
  );
  if (classification.source === "UNCERTAIN" || !classification.content_mode) {
    fingerprint ??= await uncertainFingerprint(trigger.candidate_id, snapshot, config);
    const existing = intent === "EXPLORATION"
      ? await dependencies.repository.findExplorationBrief?.(fingerprint)
      : await dependencies.repository.findReadyBrief(trigger.candidate_id, fingerprint);
    if (existing) return { status: "NOOP", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
    job ??= await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "CLASSIFICATION_UNCERTAIN", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: "CLASSIFICATION_UNCERTAIN", created_at: "", updated_at: "", completed_at: runAt.toISOString() }, runAt));
    await dependencies.repository.updateJob(job.id, { status: "CLASSIFICATION_UNCERTAIN", completed_at: runAt.toISOString(), last_error_category: "CLASSIFICATION_UNCERTAIN", lease_owner: null, lease_expires_at: null, ...currentUsage() });
    return { status: "CLASSIFICATION_UNCERTAIN", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
  }
  const mode = classification.content_mode as ContentMode;
  if (mode === "NEWS_UPDATE" && intent === "STANDARD" && !strictNewsEvidence(snapshot)) {
    fingerprint = await hashGenerationInput({ candidate_id: trigger.candidate_id, evidence_snapshot: snapshot, content_mode: mode, match_phase: classification.match_phase, generation_config_version: config.version, classifier_config_version: config.classifier_config.version, generator_model_config: config.generation_config });
    job ??= await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "BLOCKED_EVIDENCE", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: "BLOCKED_EVIDENCE", created_at: "", updated_at: "", completed_at: runAt.toISOString() }, runAt));
    await dependencies.repository.updateJob(job.id, { status: "BLOCKED_EVIDENCE", completed_at: runAt.toISOString(), last_error_category: "BLOCKED_EVIDENCE", lease_owner: null, lease_expires_at: null, ...currentUsage() });
    return { status: "BLOCKED_EVIDENCE", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
  }
  fingerprint ??= await hashGenerationInput({ candidate_id: trigger.candidate_id, evidence_snapshot: snapshot, content_mode: mode, match_phase: classification.match_phase, generation_config_version: config.version, classifier_config_version: config.classifier_config.version, generator_model_config: config.generation_config });
  const ready = intent === "EXPLORATION"
    ? await dependencies.repository.findExplorationBrief?.(fingerprint)
    : await dependencies.repository.findReadyBrief(trigger.candidate_id, fingerprint);
  if (ready) {
    if (job) await dependencies.repository.updateJob(job.id, { status: ready.status === "READY" ? "READY" : "DRAFT", creative_brief_id: ready.id, completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null, ...currentUsage() });
    return { status: "NOOP", candidate_id: trigger.candidate_id, creative_brief_id: ready.id, revision: ready.version, input_fingerprint: fingerprint };
  }
  job ??= await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "QUEUED", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: null, created_at: "", updated_at: "", completed_at: null }, runAt));
  if (!leaseAcquired) {
    const leaseUntil = new Date(runAt.getTime() + (dependencies.leaseSeconds ?? 300) * 1000);
    if (!(await dependencies.repository.acquireLease(job.id, dependencies.workerId, runAt, leaseUntil))) return { status: "CONCURRENT", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
    await dependencies.repository.updateJob(job.id, { status: "GENERATING", attempt_count: job.attempt_count + 1, lease_owner: dependencies.workerId, lease_expires_at: leaseUntil.toISOString() });
  }
  const providerInput = { content_mode: mode, match_phase: classification.match_phase, evidence_snapshot: snapshot, ...(intent === "EXPLORATION" ? { generation_intent: intent } : {}) };
  let generated: CreativeBriefOutput;
  try {
    generated = await dependencies.provider.generate(providerInput);
  } catch {
    await dependencies.repository.updateJob(job.id, { status: "FAILED_PROVIDER", last_error_category: "FAILED_PROVIDER", completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null, ...currentUsage() });
    return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: ["FAILED_PROVIDER"] };
  }
  const checked = await generateWithOneRepair(dependencies.provider, generated, providerInput, snapshot, qualityConfig(config, intent, reviewConfig, mode), intent, runAt);
  if (!checked.ok || !checked.output) {
    await dependencies.repository.updateJob(job.id, { status: "FAILED_VALIDATION", repair_attempted: checked.repair_attempted, last_error_category: "FAILED_VALIDATION", completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null, ...currentUsage() });
    return { status: "FAILED_VALIDATION", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: checked.validation.errors.map((entry) => entry.code) };
  }
  const output = checked.output;
  const usage = currentUsage();
  const revision = await dependencies.repository.nextRevision(trigger.candidate_id);
  const briefStatus = intent === "EXPLORATION" ? "DRAFT" : mode === "NEWS_UPDATE" && trigger.trigger_type !== "AUTO_PRIORITY" && !rankingEligible ? "DRAFT" : "READY";
  const brief = await dependencies.repository.insertCreativeBrief({
    candidate_id: trigger.candidate_id, version: revision, headline: output.hooks[0]?.text ?? output.angle, angle: output.angle, format: "INSTAGRAM_CAROUSEL", slide_count: output.slides.length,
    slides_json: { slides: output.slides, sources: output.sources, key_takeaway: output.key_takeaway, editor_warning: output.editor_warning ?? null, internal_grounding: output.internal_grounding ?? null, ...(intent === "EXPLORATION" ? { exploration_articles: eligibleExplorationArticles } : {}) }, design_json: { slides: output.slides.map((slide) => ({ slide_number: slide.slide_number, visual_direction: slide.visual_direction })) }, caption_draft: output.caption.body, cta: output.caption.cta, status: briefStatus, content_mode: output.content_mode, match_phase: output.match_phase, generation_config_id: config.id, input_fingerprint: fingerprint, evidence_snapshot: snapshot, hooks_json: output.hooks, grounding_json: { claims: output.slides.flatMap((slide) => slide.claims), internal_grounding: output.internal_grounding ?? null }, generation_metadata: { config_version: config.version, classifier_config_version: config.classifier_config.version, classification_source: classification.source, trigger_type: trigger.trigger_type, ...(intent === "EXPLORATION" ? { generation_intent: intent, exploration_fingerprint: fingerprint, ...(historicalReview ? { historical_review: true } : {}) } : {}), ranking_eligible: rankingEligible, provider_usage: usage }, generation_quality: output.generation_quality, model_name: String(config.generation_config.model), generated_at: runAt.toISOString(),
    style_profile: output.style_profile ?? (qualityConfig(config, intent, reviewConfig, mode).style_profile === "manutd_editor" ? "manutd_editor" : undefined), style_version: output.style_version ?? qualityConfig(config, intent, reviewConfig, mode).style_version,
    ...(intent === "EXPLORATION" ? { exploration_fingerprint: fingerprint } : {}), provider_calls: usage.provider_calls, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, estimated_cost_usd: usage.estimated_cost_usd,
  });
  await dependencies.repository.updateJob(job.id, { status: briefStatus, creative_brief_id: brief.id, repair_attempted: checked.repair_attempted, completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null, ...usage });
  return { status: briefStatus, candidate_id: trigger.candidate_id, creative_brief_id: brief.id, revision, input_fingerprint: fingerprint };
}

export async function runPriorityCreativeGeneration(dependencies: GenerationDependencies): Promise<readonly GenerationResult[]> {
  const runAt = (dependencies.now ?? (() => new Date()))();
  const ids = await dependencies.repository.listPriorityCandidateIds?.(businessDate(runAt, "Asia/Seoul")) ?? [];
  const results: GenerationResult[] = [];
  for (const candidateId of ids) results.push(await runCreativeGeneration({ candidate_id: candidateId, trigger_type: "AUTO_PRIORITY" }, dependencies));
  const explorationConfig = dependencies.explorationConfig ?? DEFAULT_EXPLORATION_CONFIG;
  if (explorationConfig.autoEnabled && dependencies.repository.listExplorationCandidateIds) {
    let created = 0;
    const explorationIds = await dependencies.repository.listExplorationCandidateIds(runAt);
    for (const candidateId of explorationIds) {
      if (created >= explorationConfig.maxDraftsPerDay) break;
      const result = await runCreativeGeneration({ candidate_id: candidateId, trigger_type: "AUTO_PRIORITY", generation_intent: "EXPLORATION" }, dependencies);
      results.push(result);
      if (result.status === "DRAFT") created += 1;
      if (result.status === "DAILY_LIMIT") break;
    }
  }
  return results;
}
