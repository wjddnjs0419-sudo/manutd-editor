export type ContentUnderstandingStatus =
  | "SUCCEEDED"
  | "PARTIAL"
  | "FAILED"
  | "UNAVAILABLE";

export type ClaimOrigin = "caption" | "image" | "carousel_slide" | "thumbnail";
export type EvidenceState = "OBSERVED" | "INFERRED" | "UNAVAILABLE";
export type VisualFormat = "IMAGE" | "CAROUSEL" | "THUMBNAIL_ONLY" | "NO_MEDIA";
export type MediaAssetType = "IMAGE" | "CAROUSEL_CHILD" | "THUMBNAIL";

export interface AnalysisContract {
  readonly analysisVersion: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface FingerprintAsset {
  readonly mediaAssetId: string;
  readonly assetType: MediaAssetType;
  readonly carouselIndex: number | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
}

export interface FingerprintInput extends AnalysisContract {
  readonly rawPostId: string;
  readonly caption: string | null;
  readonly mediaType: string;
  readonly mediaProductType: string | null;
  readonly assets: readonly FingerprintAsset[];
}

export interface AnalysisMediaInput {
  readonly mediaAssetId: string;
  readonly assetType: MediaAssetType;
  readonly carouselIndex: number | null;
  readonly mimeType: string;
  readonly sha256: string;
  readonly dataUrl: string;
}

export interface OnImageText {
  readonly text: string;
  readonly slideIndex: number | null;
  readonly confidence: number | null;
}

export interface ClaimEvidence {
  readonly slideIndex: number | null;
  readonly mediaAssetId: string | null;
}

export interface ContentClaim {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly text: string;
  readonly origin: ClaimOrigin;
  readonly confidence: number;
  readonly evidence: readonly ClaimEvidence[];
}

export interface ContentUnderstandingOutput {
  readonly captionSummary: string | null;
  readonly visualSummary: string | null;
  readonly combinedSummary: string | null;
  readonly entities: readonly string[];
  readonly topics: readonly string[];
  readonly onImageText: readonly OnImageText[];
  readonly importantNumbers: readonly string[];
  readonly sourceNames: readonly string[];
  readonly claims: readonly ContentClaim[];
  readonly contentType: string | null;
  readonly visualFormat: VisualFormat;
  readonly analysisConfidence: number | null;
  readonly evidenceState: Readonly<Record<string, EvidenceState>>;
}

export interface AnalysisValidationContext {
  readonly visualFormat: VisualFormat;
  readonly slideCount: number;
}

export type AnalysisFailureCategory =
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UPSTREAM_5XX"
  | "PROVIDER_UPSTREAM"
  | "MALFORMED_PROVIDER_RESPONSE"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_UNAVAILABLE"
  | "MEDIA_INVALID"
  | "INVALID_ANALYSIS_OUTPUT";

export interface AnalysisFailure {
  readonly category: AnalysisFailureCategory;
  readonly statusClass?: string;
}
