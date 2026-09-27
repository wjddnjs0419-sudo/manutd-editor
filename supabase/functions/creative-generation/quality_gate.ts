import type { ProviderPromptInput } from "./provider.ts";
import type {
  ContentMode,
  CreativeBriefOutput,
  EvidenceSnapshot,
  MatchPhase,
} from "./types.ts";
import { validateManutdEditorDraft } from "../_shared/editorial-style/validator.ts";
import type { ManutdEditorCarouselDraft } from "../_shared/editorial-style/types.ts";

export interface QualityGateConfig {
  readonly min_slides: number;
  readonly max_slides: number;
  readonly hook_count: number;
  readonly max_repair_attempts: number;
  readonly require_visual_direction: boolean;
  readonly style_profile?: string;
  readonly style_version?: string;
  readonly enable_style_validator?: boolean;
}

export interface ValidationError {
  readonly code: string;
  readonly path: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
}

export interface RepairProvider {
  repair(input: ProviderPromptInput, output: CreativeBriefOutput, errors: readonly string[]): Promise<CreativeBriefOutput>;
}

export interface RepairResult {
  readonly ok: boolean;
  readonly output?: CreativeBriefOutput;
  readonly validation: ValidationResult;
  readonly repair_attempted: boolean;
}

const MODES: readonly ContentMode[] = ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"];
const PHASES: readonly MatchPhase[] = ["PRE_MATCH", "LIVE", "POST_MATCH"];

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function error(code: string, path: string): ValidationError {
  return { code, path };
}

function styleDraft(value: CreativeBriefOutput, evidence: EvidenceSnapshot): ManutdEditorCarouselDraft {
  const slides = value.slides.map((slide, index) => ({
    index: typeof slide.index === "number" ? slide.index : index + 1,
    role: slide.role ?? (index === 0 ? "HOOK" : index === 1 ? "CONTEXT" : index === 2 ? "KEY_FACT" : "IMPLICATION"),
    headline: slide.headline,
    highlight: slide.highlight ?? null,
    body: typeof slide.body === "string" && slide.body.trim() ? slide.body : null,
    closing_line: slide.closing_line ?? null,
    evidence_ids: [...new Set((Array.isArray(slide.claims) ? slide.claims : []).filter(object).flatMap((claim) => Array.isArray(claim.evidence_ids) ? claim.evidence_ids.filter((entry): entry is string => typeof entry === "string") : []))],
  }));
  const grounding = object(value.internal_grounding) ? value.internal_grounding : {};
  const internalGrounding = {
    evidence_ids: Array.isArray(grounding.evidence_ids) ? grounding.evidence_ids.filter((entry): entry is string => typeof entry === "string") : [...evidence.evidence_ids],
    source_caveats: Array.isArray(grounding.source_caveats) ? grounding.source_caveats.filter((entry): entry is string => typeof entry === "string") : [],
    unsupported_claims: Array.isArray(grounding.unsupported_claims) ? grounding.unsupported_claims.filter((entry): entry is string => typeof entry === "string") : [],
  };
  return {
    style_profile: value.style_profile ?? "",
    style_version: value.style_version ?? "",
    story_id: typeof evidence.story.id === "string" && evidence.story.id.trim() ? evidence.story.id : typeof evidence.candidate.story_cluster_id === "string" && evidence.candidate.story_cluster_id.trim() ? evidence.candidate.story_cluster_id : "style-story",
    creative_brief_id: null,
    slides,
    caption: object(value.caption) ? { body: typeof value.caption.body === "string" ? value.caption.body : "", cta: typeof value.caption.cta === "string" ? value.caption.cta : null } : { body: "", cta: null },
    editor_warning: value.editor_warning ?? null,
    internal_grounding: internalGrounding,
  };
}

export function validateCreativeBrief(
  value: unknown,
  evidence: EvidenceSnapshot,
  config: QualityGateConfig,
): ValidationResult {
  const errors: ValidationError[] = [];
  if (!object(value)) return { valid: false, errors: [error("SCHEMA_INVALID", "root")] };
  const output = value;
  const mode = output.content_mode;
  const phase = output.match_phase;
  if (!MODES.includes(mode as ContentMode)) errors.push(error("MODE_INVALID", "content_mode"));
  if (mode === "MATCH_CONTENT") {
    if (!PHASES.includes(phase as MatchPhase)) errors.push(error("MATCH_PHASE_INVALID", "match_phase"));
  } else if (phase !== null) {
    errors.push(error("MATCH_PHASE_INVALID", "match_phase"));
  }
  if (!nonblank(output.angle)) errors.push(error("EMPTY_ANGLE", "angle"));
  if (!nonblank(output.key_takeaway)) errors.push(error("EMPTY_KEY_TAKEAWAY", "key_takeaway"));

  if (!Array.isArray(output.hooks) || output.hooks.length !== config.hook_count) {
    errors.push(error("HOOK_COUNT", "hooks"));
  } else {
    output.hooks.forEach((hook, index) => {
      if (!object(hook) || !nonblank(hook.id) || !nonblank(hook.text)) errors.push(error("HOOK_INVALID", `hooks[${index}]`));
    });
  }

  if (!Array.isArray(output.slides) || output.slides.length < config.min_slides || output.slides.length > config.max_slides) {
    errors.push(error("SLIDE_COUNT", "slides"));
  }

  const evidenceIds = new Set(evidence.evidence_ids);
  if (Array.isArray(output.slides)) {
    output.slides.forEach((slide, index) => {
      const path = `slides[${index}]`;
      if (!object(slide)) {
        errors.push(error("SLIDE_INVALID", path));
        return;
      }
      if (slide.slide_number !== index + 1) errors.push(error("SLIDE_NUMBER", `${path}.slide_number`));
      const hookMayBeBodyless = config.enable_style_validator === true && (slide.role === "HOOK" || slide.purpose === "HOOK");
      if (!nonblank(slide.headline) || (!hookMayBeBodyless && !nonblank(slide.body))) errors.push(error("SLIDE_TEXT_BLANK", path));
      const visual = slide.visual_direction;
      if (config.require_visual_direction && (!object(visual) || !nonblank(visual.subject) || !nonblank(visual.image_type) || !nonblank(visual.layout_intent) || !Array.isArray(visual.text_hierarchy) || visual.text_hierarchy.length === 0)) {
        errors.push(error("VISUAL_DIRECTION_MISSING", `${path}.visual_direction`));
      }
      if (!Array.isArray(slide.claims)) {
        errors.push(error("CLAIMS_INVALID", `${path}.claims`));
        return;
      }
      slide.claims.forEach((claim, claimIndex) => {
        const claimPath = `${path}.claims[${claimIndex}]`;
        if (!object(claim) || !nonblank(claim.text) || (claim.type !== "FACT" && claim.type !== "INFERENCE")) {
          errors.push(error("CLAIM_INVALID", claimPath));
          return;
        }
        const claimEvidence = Array.isArray(claim.evidence_ids) ? claim.evidence_ids : [];
        const hasUnknownEvidence = claimEvidence.some((id) => typeof id !== "string" || !evidenceIds.has(id));
        if (hasUnknownEvidence) errors.push(error("EVIDENCE_ID_UNKNOWN", `${claimPath}.evidence_ids`));
        if (claimEvidence.length === 0 || hasUnknownEvidence) {
          errors.push(error(claim.type === "FACT" ? "FACT_UNGROUNDED" : "INFERENCE_UNGROUNDED", claimPath));
        }
      });
    });
  }

  if (!Array.isArray(output.sources)) {
    errors.push(error("SOURCES_INVALID", "sources"));
  } else {
    output.sources.forEach((source, index) => {
      if (!object(source) || !nonblank(source.evidence_id) || !nonblank(source.label)) {
        errors.push(error("SOURCE_INVALID", `sources[${index}]`));
      } else if (!evidenceIds.has(source.evidence_id)) {
        errors.push(error("UNSUPPORTED_SOURCE", `sources[${index}].evidence_id`));
      }
    });
  }

  if (mode === "NEWS_UPDATE") {
    const reliableSource = evidence.sources.some((source) => (source.reliability_score ?? 0) >= 8);
    if (!reliableSource || !Array.isArray(output.sources) || output.sources.length === 0) errors.push(error("NEWS_EVIDENCE_BLOCKED", "sources"));
  }

  if (config.enable_style_validator === true) {
    if (output.style_profile !== config.style_profile || output.style_version !== config.style_version) {
      errors.push(error("STYLE_IDENTITY", "style_profile"));
    }
    const styleResult = validateManutdEditorDraft(styleDraft(output as unknown as CreativeBriefOutput, evidence), new Set(evidence.evidence_ids));
    for (const entry of styleResult.errors) errors.push(error(`STYLE_${entry.code}`, entry.path ?? "root"));
  }

  return { valid: errors.length === 0, errors };
}

export async function generateWithOneRepair(
  provider: RepairProvider,
  output: unknown,
  input: ProviderPromptInput,
  evidence: EvidenceSnapshot,
  config: QualityGateConfig,
): Promise<RepairResult> {
  const first = validateCreativeBrief(output, evidence, config);
  if (first.valid) return { ok: true, output: output as CreativeBriefOutput, validation: first, repair_attempted: false };
  if (config.max_repair_attempts < 1) return { ok: false, validation: first, repair_attempted: false };
  try {
    const repaired = await provider.repair(input, output as CreativeBriefOutput, first.errors.map((entry) => entry.code));
    const second = validateCreativeBrief(repaired, evidence, config);
    return { ok: second.valid, output: second.valid ? repaired : undefined, validation: second, repair_attempted: true };
  } catch {
    return { ok: false, validation: { valid: false, errors: [...first.errors, error("REPAIR_FAILED", "root")] }, repair_attempted: true };
  }
}
