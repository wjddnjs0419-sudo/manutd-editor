import { classifyWithFallback } from "./classifier.ts";
import { validateGenerationConfig, type GenerationConfig } from "./config.ts";
import { buildEvidenceSnapshot } from "./evidence.ts";
import { canonicalJson, hashGenerationInput, sha256 } from "./fingerprint.ts";
import { generateWithOneRepair } from "./quality_gate.ts";
import type { CreativeGenerationProvider } from "./provider.ts";
import type { GenerationRepository, GenerationJob, StoredCreativeBrief, TriggerType } from "./repository.ts";
import type { ContentMode, CreativeBriefOutput, EvidenceSnapshot } from "./types.ts";

export interface GenerationTrigger {
  readonly candidate_id: string;
  readonly trigger_type: TriggerType;
}

export type GenerationStatus = "READY" | "NOOP" | "CONCURRENT" | "NOT_ELIGIBLE" | "BLOCKED_EVIDENCE" | "CLASSIFICATION_UNCERTAIN" | "FAILED_VALIDATION" | "FAILED_PROVIDER";

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
}

function evidenceText(snapshot: EvidenceSnapshot): string {
  return [snapshot.story.canonical_title ?? "", ...snapshot.posts.map((post) => post.caption ?? "")].filter(Boolean).join("\n");
}

function qualityConfig(config: GenerationConfig) {
  const value = config.quality_gate_config;
  return {
    min_slides: Number(value.min_slides ?? 4), max_slides: Number(value.max_slides ?? 7), hook_count: Number(value.hook_count ?? 3),
    max_repair_attempts: Number(value.max_repair_attempts ?? 1), require_visual_direction: value.require_visual_direction !== false,
  };
}

function strictNewsEvidence(snapshot: EvidenceSnapshot): boolean {
  return snapshot.sources.some((source) => (source.reliability_score ?? 0) >= 8);
}

function uncertainFingerprint(candidateId: string, snapshot: EvidenceSnapshot, config: GenerationConfig): Promise<string> {
  return sha256(canonicalJson({ candidate_id: candidateId, evidence_snapshot: snapshot, generation_config_version: config.version, classification: "uncertain" }));
}

function jobInput(job: Omit<GenerationJob, "id">, now: Date): Omit<GenerationJob, "id"> {
  return { ...job, created_at: job.created_at || now.toISOString(), updated_at: job.updated_at || now.toISOString() };
}

export async function runCreativeGeneration(trigger: GenerationTrigger, dependencies: GenerationDependencies): Promise<GenerationResult> {
  const now = dependencies.now ?? (() => new Date());
  const runAt = now();
  const evidenceInput = await dependencies.repository.getCandidateEvidence(trigger.candidate_id);
  if (!evidenceInput) return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, error_codes: ["CANDIDATE_NOT_FOUND"] };
  if (trigger.trigger_type === "AUTO_PRIORITY" && !evidenceInput.candidate.first_mover_flag && !evidenceInput.candidate.must_cover_flag) {
    return { status: "NOT_ELIGIBLE", candidate_id: trigger.candidate_id };
  }
  const rawConfig = await dependencies.repository.getActiveConfig();
  const config = validateGenerationConfig(rawConfig);
  dependencies.provider.configure?.(config);
  const snapshot = buildEvidenceSnapshot(evidenceInput);
  const classification = await classifyWithFallback(evidenceText(snapshot), config.classifier_config, dependencies.provider);
  if (classification.source === "UNCERTAIN" || !classification.content_mode) {
    const fingerprint = await uncertainFingerprint(trigger.candidate_id, snapshot, config);
    const existing = await dependencies.repository.findReadyBrief(trigger.candidate_id, fingerprint);
    if (existing) return { status: "NOOP", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
    const job = await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "CLASSIFICATION_UNCERTAIN", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: "CLASSIFICATION_UNCERTAIN", created_at: "", updated_at: "", completed_at: runAt.toISOString() }, runAt));
    await dependencies.repository.updateJob(job.id, { status: "CLASSIFICATION_UNCERTAIN", completed_at: runAt.toISOString(), last_error_category: "CLASSIFICATION_UNCERTAIN" });
    return { status: "CLASSIFICATION_UNCERTAIN", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
  }
  const mode = classification.content_mode as ContentMode;
  if (mode === "NEWS_UPDATE" && !strictNewsEvidence(snapshot)) {
    const fingerprint = await hashGenerationInput({ candidate_id: trigger.candidate_id, evidence_snapshot: snapshot, content_mode: mode, match_phase: classification.match_phase, generation_config_version: config.version, classifier_config_version: config.classifier_config.version, generator_model_config: config.generation_config });
    const job = await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "BLOCKED_EVIDENCE", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: "BLOCKED_EVIDENCE", created_at: "", updated_at: "", completed_at: runAt.toISOString() }, runAt));
    await dependencies.repository.updateJob(job.id, { status: "BLOCKED_EVIDENCE", completed_at: runAt.toISOString(), last_error_category: "BLOCKED_EVIDENCE" });
    return { status: "BLOCKED_EVIDENCE", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
  }
  const fingerprint = await hashGenerationInput({ candidate_id: trigger.candidate_id, evidence_snapshot: snapshot, content_mode: mode, match_phase: classification.match_phase, generation_config_version: config.version, classifier_config_version: config.classifier_config.version, generator_model_config: config.generation_config });
  const ready = await dependencies.repository.findReadyBrief(trigger.candidate_id, fingerprint);
  if (ready) {
    return { status: "NOOP", candidate_id: trigger.candidate_id, creative_brief_id: ready.id, revision: ready.version, input_fingerprint: fingerprint };
  }
  const job = await dependencies.repository.insertJob(jobInput({ candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, trigger_type: trigger.trigger_type, status: "QUEUED", lease_owner: null, lease_expires_at: null, attempt_count: 0, repair_attempted: false, creative_brief_id: null, last_error_category: null, created_at: "", updated_at: "", completed_at: null }, runAt));
  const leaseUntil = new Date(runAt.getTime() + (dependencies.leaseSeconds ?? 300) * 1000);
  if (!(await dependencies.repository.acquireLease(job.id, dependencies.workerId, runAt, leaseUntil))) return { status: "CONCURRENT", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint };
  await dependencies.repository.updateJob(job.id, { status: "GENERATING", attempt_count: job.attempt_count + 1, lease_owner: dependencies.workerId, lease_expires_at: leaseUntil.toISOString() });
  let generated: CreativeBriefOutput;
  try {
    generated = await dependencies.provider.generate({ content_mode: mode, match_phase: classification.match_phase, evidence_snapshot: snapshot });
  } catch {
    await dependencies.repository.updateJob(job.id, { status: "FAILED_PROVIDER", last_error_category: "FAILED_PROVIDER", completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null });
    return { status: "FAILED_PROVIDER", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: ["FAILED_PROVIDER"] };
  }
  const checked = await generateWithOneRepair(dependencies.provider, generated, { content_mode: mode, match_phase: classification.match_phase, evidence_snapshot: snapshot }, snapshot, qualityConfig(config));
  if (!checked.ok || !checked.output) {
    await dependencies.repository.updateJob(job.id, { status: "FAILED_VALIDATION", repair_attempted: checked.repair_attempted, last_error_category: "FAILED_VALIDATION", completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null });
    return { status: "FAILED_VALIDATION", candidate_id: trigger.candidate_id, input_fingerprint: fingerprint, error_codes: checked.validation.errors.map((entry) => entry.code) };
  }
  const output = checked.output;
  const revision = await dependencies.repository.nextRevision(trigger.candidate_id);
  const brief = await dependencies.repository.insertCreativeBrief({
    candidate_id: trigger.candidate_id, version: revision, headline: output.hooks[0]?.text ?? output.angle, angle: output.angle, format: "INSTAGRAM_CAROUSEL", slide_count: output.slides.length,
    slides_json: { slides: output.slides, key_takeaway: output.key_takeaway }, design_json: { slides: output.slides.map((slide) => ({ slide_number: slide.slide_number, visual_direction: slide.visual_direction })) }, caption_draft: output.caption.body, cta: output.caption.cta, status: "READY", content_mode: output.content_mode, match_phase: output.match_phase, generation_config_id: config.id, input_fingerprint: fingerprint, evidence_snapshot: snapshot, hooks_json: output.hooks, grounding_json: { claims: output.slides.flatMap((slide) => slide.claims) }, generation_metadata: { config_version: config.version, classifier_config_version: config.classifier_config.version, classification_source: classification.source, trigger_type: trigger.trigger_type }, generation_quality: output.generation_quality, model_name: String(config.generation_config.model), generated_at: runAt.toISOString(),
  });
  await dependencies.repository.updateJob(job.id, { status: "READY", creative_brief_id: brief.id, repair_attempted: checked.repair_attempted, completed_at: runAt.toISOString(), lease_owner: null, lease_expires_at: null });
  return { status: "READY", candidate_id: trigger.candidate_id, creative_brief_id: brief.id, revision, input_fingerprint: fingerprint };
}

export async function runPriorityCreativeGeneration(dependencies: GenerationDependencies): Promise<readonly GenerationResult[]> {
  const ids = await dependencies.repository.listPriorityCandidateIds?.() ?? [];
  const results: GenerationResult[] = [];
  for (const candidateId of ids) results.push(await runCreativeGeneration({ candidate_id: candidateId, trigger_type: "AUTO_PRIORITY" }, dependencies));
  return results;
}
