import assert from "node:assert/strict";

import { inputFingerprint } from "../../analyze-content/fingerprint.ts";
import { MediaReadError, type PrivateMediaInput } from "../../analyze-content/media.ts";
import {
  runContentAnalysis,
  type AnalysisCandidate,
  type AnalysisRepository,
} from "../../analyze-content/orchestrator.ts";
import type { ContentUnderstandingOutput } from "../../analyze-content/types.ts";
import { goldenAnalysisOutput } from "../fixtures/m8_phase_a.ts";

const contract = {
  analysisVersion: "m8-a-v1",
  model: "test-model",
  promptVersion: "prompt-v1",
};

function asset(index: number, type: "IMAGE" | "CAROUSEL_CHILD" | "THUMBNAIL" = "IMAGE") {
  return {
    mediaAssetId: `00000000-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`,
    assetType: type,
    carouselIndex: type === "CAROUSEL_CHILD" ? index : null,
    storagePath: `instagram/00000000-0000-4000-8000-000000000102/post-${index}/media-${index}.jpg`,
    mimeType: "image/jpeg",
    sha256: String.fromCharCode(97 + index).repeat(64),
  } as const;
}

function candidate(
  index: number,
  mediaType: string,
  mediaProductType: string | null,
  assets: readonly ReturnType<typeof asset>[],
  caption: string | null,
): AnalysisCandidate {
  return {
    rawPostId: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
    caption,
    mediaType,
    mediaProductType,
    assets,
    existingFingerprints: [],
  };
}

function output(visualFormat: ContentUnderstandingOutput["visualFormat"]): ContentUnderstandingOutput {
  return { ...goldenAnalysisOutput, visualFormat };
}

function mediaInput(reference: ReturnType<typeof asset>): PrivateMediaInput {
  return {
    mediaAssetId: reference.mediaAssetId,
    assetType: reference.assetType,
    carouselIndex: reference.carouselIndex,
    mimeType: "image/jpeg",
    bytes: new Uint8Array([1, 2, 3]),
    dataUrl: "data:image/jpeg;base64,AQID",
    sha256: reference.sha256,
  };
}

function repository(candidates: readonly AnalysisCandidate[], saved: Array<Record<string, unknown>>): AnalysisRepository {
  return {
    async listCandidates() {
      return candidates;
    },
    async save(input) {
      saved.push(input as unknown as Record<string, unknown>);
    },
  };
}

Deno.test("analyzes weak captions with visual context, preserves carousel order, and supports Reel thumbnails", async () => {
  const candidates = [
    candidate(1, "IMAGE", null, [asset(1)], "Thoughts? 👀"),
    candidate(2, "IMAGE", null, [asset(2)], "A useful caption with context."),
    candidate(3, "CAROUSEL_ALBUM", null, [asset(0, "CAROUSEL_CHILD"), asset(1, "CAROUSEL_CHILD"), asset(2, "CAROUSEL_CHILD")], "Swipe."),
    candidate(4, "VIDEO", "REELS", [asset(3, "THUMBNAIL")], "Watch this."),
  ];
  const saved: Array<Record<string, unknown>> = [];
  const providerInputs: Array<{ visualFormat: string; mediaIds: string[] }> = [];
  const result = await runContentAnalysis({
    repository: repository(candidates, saved),
    contract,
    batchSize: 10,
    concurrency: 2,
    readMedia: async (reference) => mediaInput(reference as ReturnType<typeof asset>),
    analyze: async (input) => {
      providerInputs.push({ visualFormat: input.visualFormat, mediaIds: input.media.map((item) => item.mediaAssetId) });
      return output(input.visualFormat);
    },
  });

  assert.deepEqual(result, { status: "COMPLETED", candidates: 4, analyzed: 4, skipped: 0, succeeded: 4, partial: 0, unavailable: 0, failed: 0 });
  assert.deepEqual(providerInputs.map((input) => input.visualFormat).sort(), ["CAROUSEL", "IMAGE", "IMAGE", "THUMBNAIL_ONLY"]);
  const carouselInput = providerInputs.find((input) => input.visualFormat === "CAROUSEL");
  assert.deepEqual(carouselInput?.mediaIds, candidates[2]?.assets.map((item) => item.mediaAssetId));
});

Deno.test("bounds oversized carousels to the configured slide limit", async () => {
  const carousel = candidate(
    5,
    "CAROUSEL_ALBUM",
    null,
    Array.from({ length: 7 }, (_, index) => asset(index, "CAROUSEL_CHILD")),
    "Seven slides.",
  );
  const saved: Array<Record<string, unknown>> = [];
  const readIds: string[] = [];
  let providerMediaIds: string[] = [];
  const result = await runContentAnalysis({
    repository: repository([carousel], saved),
    contract,
    batchSize: 10,
    concurrency: 1,
    maxSlides: 6,
    readMedia: async (reference) => {
      readIds.push(reference.mediaAssetId);
      return mediaInput(reference as ReturnType<typeof asset>);
    },
    analyze: async (input) => {
      providerMediaIds = input.media.map((item) => item.mediaAssetId);
      return output(input.visualFormat);
    },
  });

  assert.deepEqual(result, { status: "COMPLETED", candidates: 1, analyzed: 1, skipped: 0, succeeded: 1, partial: 0, unavailable: 0, failed: 0 });
  assert.deepEqual(readIds, carousel.assets.slice(0, 6).map((item) => item.mediaAssetId));
  assert.deepEqual(providerMediaIds, carousel.assets.slice(0, 6).map((item) => item.mediaAssetId));
});

Deno.test("skips an exact fingerprint, but analyzes a changed caption as a new historical row", async () => {
  const base = candidate(1, "IMAGE", null, [asset(1)], "same");
  const readMedia = async (reference: AnalysisCandidate["assets"][number]) => mediaInput(reference as ReturnType<typeof asset>);
  const fingerprint = await inputFingerprint({
    rawPostId: base.rawPostId,
    caption: base.caption,
    mediaType: base.mediaType,
    mediaProductType: base.mediaProductType,
    ...contract,
    assets: [{ mediaAssetId: asset(1).mediaAssetId, assetType: "IMAGE", carouselIndex: null, mimeType: "image/jpeg", sha256: asset(1).sha256 }],
  });
  const saved: Array<Record<string, unknown>> = [];
  let providerCalls = 0;
  const duplicate = { ...base, existingFingerprints: [fingerprint] };
  const skipped = await runContentAnalysis({ repository: repository([duplicate], saved), contract, batchSize: 5, concurrency: 1, readMedia, analyze: async (input) => { providerCalls += 1; return output(input.visualFormat); } });
  assert.equal(skipped.skipped, 1);
  assert.equal(providerCalls, 0);

  const changed = { ...base, caption: "changed", existingFingerprints: [fingerprint] };
  const analyzed = await runContentAnalysis({ repository: repository([changed], saved), contract, batchSize: 5, concurrency: 1, readMedia, analyze: async (input) => { providerCalls += 1; return output(input.visualFormat); } });
  assert.equal(analyzed.analyzed, 1);
  assert.equal(providerCalls, 1);
  assert.equal(saved.length, 1);
});

Deno.test("isolates missing media and provider failures while completing other posts", async () => {
  const missing = candidate(1, "IMAGE", null, [asset(1)], "missing");
  const partial = candidate(2, "CAROUSEL_ALBUM", null, [asset(0, "CAROUSEL_CHILD"), asset(1, "CAROUSEL_CHILD")], "partial");
  const failed = candidate(3, "IMAGE", null, [asset(2)], "provider fails");
  const good = candidate(4, "IMAGE", null, [asset(3)], "good");
  const saved: Array<Record<string, unknown>> = [];
  const result = await runContentAnalysis({
    repository: repository([missing, partial, failed, good], saved),
    contract,
    batchSize: 10,
    concurrency: 2,
    readMedia: async (reference) => {
      if (reference.mediaAssetId === missing.assets[0]?.mediaAssetId || reference.mediaAssetId === partial.assets[1]?.mediaAssetId) {
        throw new MediaReadError("MEDIA_UNAVAILABLE");
      }
      return mediaInput(reference as ReturnType<typeof asset>);
    },
    analyze: async (input) => {
      if (input.caption === "provider fails") throw new Error("raw upstream body must not escape");
      return output(input.visualFormat);
    },
  });

  assert.equal(result.unavailable, 1);
  assert.equal(result.partial, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.succeeded, 1);
  assert.equal(saved.length, 4);
  assert.equal(saved.some((row) => row.errorCategory === "MEDIA_UNAVAILABLE"), true);
  assert.equal(saved.some((row) => row.errorCategory === "PROVIDER_UPSTREAM"), true);
  assert.equal(JSON.stringify(saved).includes("raw upstream body"), false);
});
