import type {
  AnalysisValidationContext,
  ClaimEvidence,
  ClaimOrigin,
  ContentClaim,
  ContentUnderstandingOutput,
  EvidenceState,
  OnImageText,
  VisualFormat,
} from "./types.ts";

const MAX_SUMMARY_LENGTH = 4_000;
const MAX_TERM_LENGTH = 160;
const MAX_LIST_LENGTH = 64;
const MAX_CLAIMS = 32;
const MAX_EVIDENCE_PER_CLAIM = 8;
const CLAIM_ORIGINS = new Set<ClaimOrigin>([
  "caption",
  "image",
  "carousel_slide",
  "thumbnail",
]);
const EVIDENCE_STATES = new Set<EvidenceState>([
  "OBSERVED",
  "INFERRED",
  "UNAVAILABLE",
]);
const EVIDENCE_FIELDS = [
  "captionSummary",
  "visualSummary",
  "combinedSummary",
  "entities",
  "topics",
  "onImageText",
  "claims",
] as const;

export type AnalysisValidationErrorCode =
  | "INVALID_OUTPUT"
  | "INVALID_LIST"
  | "INVALID_ON_IMAGE_TEXT"
  | "INVALID_CLAIM"
  | "INVALID_CONFIDENCE"
  | "INVALID_EVIDENCE_STATE"
  | "VISUAL_FORMAT_MISMATCH";

export class AnalysisValidationError extends Error {
  constructor(readonly code: AnalysisValidationErrorCode) {
    super(code);
    this.name = "AnalysisValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new AnalysisValidationError("INVALID_OUTPUT");
  }
  return value;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new AnalysisValidationError("INVALID_LIST");
  }
  return value;
}

function confidence(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new AnalysisValidationError("INVALID_CONFIDENCE");
  }
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw new AnalysisValidationError("INVALID_LIST");
  }
  return value.map((item) => boundedString(item, MAX_TERM_LENGTH));
}

function slideIndex(value: unknown, context: AnalysisValidationContext): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= context.slideCount) {
    throw new AnalysisValidationError("INVALID_OUTPUT");
  }
  return value as number;
}

function onImageText(value: unknown, context: AnalysisValidationContext): OnImageText[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_LENGTH) {
    throw new AnalysisValidationError("INVALID_ON_IMAGE_TEXT");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new AnalysisValidationError("INVALID_ON_IMAGE_TEXT");
    return {
      text: boundedString(item.text, MAX_SUMMARY_LENGTH),
      slideIndex: slideIndex(item.slideIndex, context),
      confidence: confidence(item.confidence, true),
    };
  });
}

function evidence(value: unknown, context: AnalysisValidationContext): ClaimEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_PER_CLAIM) {
    throw new AnalysisValidationError("INVALID_CLAIM");
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new AnalysisValidationError("INVALID_CLAIM");
    if (item.mediaAssetId !== null && typeof item.mediaAssetId !== "string") {
      throw new AnalysisValidationError("INVALID_CLAIM");
    }
    return {
      slideIndex: slideIndex(item.slideIndex, context),
      mediaAssetId: item.mediaAssetId as string | null,
    };
  });
}

function claims(value: unknown, context: AnalysisValidationContext): ContentClaim[] {
  if (!Array.isArray(value) || value.length > MAX_CLAIMS) {
    throw new AnalysisValidationError("INVALID_CLAIM");
  }
  return value.map((item) => {
    if (!isRecord(item) || !CLAIM_ORIGINS.has(item.origin as ClaimOrigin)) {
      throw new AnalysisValidationError("INVALID_CLAIM");
    }
    return {
      subject: boundedString(item.subject, MAX_TERM_LENGTH),
      predicate: boundedString(item.predicate, MAX_TERM_LENGTH),
      object: boundedString(item.object, MAX_TERM_LENGTH),
      text: boundedString(item.text, MAX_SUMMARY_LENGTH),
      origin: item.origin as ClaimOrigin,
      confidence: confidence(item.confidence, false) as number,
      evidence: evidence(item.evidence, context),
    };
  });
}

function evidenceState(value: unknown): Readonly<Record<string, EvidenceState>> {
  if (!isRecord(value)) throw new AnalysisValidationError("INVALID_EVIDENCE_STATE");
  for (const field of EVIDENCE_FIELDS) {
    if (!EVIDENCE_STATES.has(value[field] as EvidenceState)) {
      throw new AnalysisValidationError("INVALID_EVIDENCE_STATE");
    }
  }
  return Object.fromEntries(EVIDENCE_FIELDS.map((field) => [field, value[field]])) as Record<string, EvidenceState>;
}

export function validateAnalysisOutput(
  value: unknown,
  context: AnalysisValidationContext,
): ContentUnderstandingOutput {
  if (!isRecord(value)) throw new AnalysisValidationError("INVALID_OUTPUT");
  if (value.visualFormat !== context.visualFormat) {
    throw new AnalysisValidationError("VISUAL_FORMAT_MISMATCH");
  }
  const visualFormat = value.visualFormat as VisualFormat;
  if (!Number.isSafeInteger(context.slideCount) || context.slideCount < 0) {
    throw new AnalysisValidationError("INVALID_OUTPUT");
  }
  return {
    captionSummary: stringOrNull(value.captionSummary, MAX_SUMMARY_LENGTH),
    visualSummary: stringOrNull(value.visualSummary, MAX_SUMMARY_LENGTH),
    combinedSummary: stringOrNull(value.combinedSummary, MAX_SUMMARY_LENGTH),
    entities: stringList(value.entities),
    topics: stringList(value.topics),
    onImageText: onImageText(value.onImageText, context),
    importantNumbers: stringList(value.importantNumbers),
    sourceNames: stringList(value.sourceNames),
    claims: claims(value.claims, context),
    contentType: stringOrNull(value.contentType, MAX_TERM_LENGTH),
    visualFormat,
    analysisConfidence: confidence(value.analysisConfidence, true),
    evidenceState: evidenceState(value.evidenceState),
  };
}
