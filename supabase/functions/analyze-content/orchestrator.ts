import { inputFingerprint } from "./fingerprint.ts";
import { MediaReadError, type PrivateMediaInput } from "./media.ts";
import type { ContentUnderstandingInput } from "./provider.ts";
import { ProviderError } from "./provider.ts";
import type {
  AnalysisContract,
  AnalysisMediaInput,
  ContentUnderstandingOutput,
  ContentUnderstandingStatus,
  VisualFormat,
} from "./types.ts";
import type {
  AnalysisCandidate,
  AnalysisCandidateAsset,
  AnalysisRepository,
  AnalysisSaveInput,
} from "./repository.ts";

export type { AnalysisCandidate, AnalysisRepository } from "./repository.ts";

export interface AnalysisBatchSummary {
  readonly status: "COMPLETED";
  readonly candidates: number;
  readonly analyzed: number;
  readonly skipped: number;
  readonly succeeded: number;
  readonly partial: number;
  readonly unavailable: number;
  readonly failed: number;
}

export interface ContentAnalysisOptions {
  readonly repository: AnalysisRepository;
  readonly contract: AnalysisContract;
  readonly batchSize: number;
  readonly concurrency: number;
  readonly maxSlides?: number;
  readonly asOf?: Date;
  readonly limit?: number;
  readonly readMedia: (asset: AnalysisCandidateAsset) => Promise<PrivateMediaInput>;
  readonly analyze: (input: ContentUnderstandingInput) => Promise<ContentUnderstandingOutput>;
  readonly now?: () => Date;
}

function visualFormat(candidate: AnalysisCandidate, availableCount: number): VisualFormat {
  if (availableCount === 0) return "NO_MEDIA";
  if (candidate.mediaType === "CAROUSEL_ALBUM") return "CAROUSEL";
  if (candidate.mediaType === "VIDEO" && candidate.mediaProductType === "REELS") return "THUMBNAIL_ONLY";
  if (candidate.mediaType === "IMAGE") return "IMAGE";
  return "NO_MEDIA";
}

function fallback(visual: VisualFormat): ContentUnderstandingOutput {
  const unavailable = "UNAVAILABLE" as const;
  return {
    captionSummary: null,
    visualSummary: null,
    combinedSummary: null,
    entities: [],
    topics: [],
    onImageText: [],
    importantNumbers: [],
    sourceNames: [],
    claims: [],
    contentType: null,
    visualFormat: visual,
    analysisConfidence: null,
    evidenceState: {
      captionSummary: unavailable,
      visualSummary: unavailable,
      combinedSummary: unavailable,
      entities: unavailable,
      topics: unavailable,
      onImageText: unavailable,
      claims: unavailable,
    },
  };
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof MediaReadError) return error.category;
  if (error instanceof ProviderError) return error.category;
  return "PROVIDER_UPSTREAM";
}

function mediaInput(value: PrivateMediaInput): AnalysisMediaInput {
  return {
    mediaAssetId: value.mediaAssetId,
    assetType: value.assetType,
    carouselIndex: value.carouselIndex,
    mimeType: value.mimeType,
    sha256: value.sha256,
    dataUrl: value.dataUrl,
  };
}

function saveInput(
  candidate: AnalysisCandidate,
  status: ContentUnderstandingStatus,
  contract: AnalysisContract,
  fingerprint: string,
  output: ContentUnderstandingOutput,
  errorCategory: string | null,
  now: () => Date,
): AnalysisSaveInput {
  return {
    rawPostId: candidate.rawPostId,
    status,
    contract,
    inputFingerprint: fingerprint,
    output,
    errorCategory,
    analyzedAt: now().toISOString(),
  };
}

async function processCandidate(
  candidate: AnalysisCandidate,
  options: ContentAnalysisOptions,
  maxSlides: number,
): Promise<"skipped" | "succeeded" | "partial" | "unavailable" | "failed"> {
  const now = options.now ?? (() => new Date());
  const media: PrivateMediaInput[] = [];
  let mediaFailure: string | null = null;
  for (const asset of candidate.assets.slice(0, maxSlides)) {
    if (asset.storagePath === null) {
      mediaFailure = "MEDIA_UNAVAILABLE";
      continue;
    }
    try {
      media.push(await options.readMedia(asset));
    } catch (error) {
      mediaFailure = safeFailureCategory(error);
    }
  }

  const fingerprint = await inputFingerprint({
    rawPostId: candidate.rawPostId,
    caption: candidate.caption,
    mediaType: candidate.mediaType,
    mediaProductType: candidate.mediaProductType,
    ...options.contract,
    assets: candidate.assets.map((asset) => ({
      mediaAssetId: asset.mediaAssetId,
      assetType: asset.assetType,
      carouselIndex: asset.carouselIndex,
      mimeType: asset.mimeType,
      sha256: media.find((value) => value.mediaAssetId === asset.mediaAssetId)?.sha256 ?? asset.sha256,
    })),
  });
  if (candidate.existingFingerprints.includes(fingerprint)) return "skipped";

  const visual = visualFormat(candidate, media.length);
  if (candidate.assets.length > 0 && media.length === 0) {
    await options.repository.save(saveInput(candidate, "UNAVAILABLE", options.contract, fingerprint, fallback("NO_MEDIA"), mediaFailure ?? "MEDIA_UNAVAILABLE", now));
    return "unavailable";
  }

  const providerInput: ContentUnderstandingInput = {
    caption: candidate.caption,
    visualFormat: visual,
    media: media.map(mediaInput),
  };
  try {
    const result = await options.analyze(providerInput);
    const status: ContentUnderstandingStatus = mediaFailure === null ? "SUCCEEDED" : "PARTIAL";
    await options.repository.save(saveInput(candidate, status, options.contract, fingerprint, result, mediaFailure, now));
    return status === "SUCCEEDED" ? "succeeded" : "partial";
  } catch (error) {
    await options.repository.save(saveInput(candidate, "FAILED", options.contract, fingerprint, fallback(visual), safeFailureCategory(error), now));
    return "failed";
  }
}

export async function runContentAnalysis(options: ContentAnalysisOptions): Promise<AnalysisBatchSummary> {
  if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) throw new Error("Analysis batch size is invalid");
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 2) throw new Error("Analysis concurrency is invalid");
  const maxSlides = options.maxSlides ?? 6;
  if (!Number.isSafeInteger(maxSlides) || maxSlides < 1 || maxSlides > 10) throw new Error("Analysis slide limit is invalid");
  const candidates = await options.repository.listCandidates(options.asOf ?? (options.now?.() ?? new Date()), options.limit ?? options.batchSize, options.contract);
  const counts = { analyzed: 0, skipped: 0, succeeded: 0, partial: 0, unavailable: 0, failed: 0 };
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      const candidate = candidates[index];
      if (!candidate) return;
      const result = await processCandidate(candidate, options, maxSlides);
      if (result !== "skipped") counts.analyzed += 1;
      counts[result] += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, candidates.length || 1) }, () => worker()));
  return { status: "COMPLETED", candidates: candidates.length, ...counts };
}
