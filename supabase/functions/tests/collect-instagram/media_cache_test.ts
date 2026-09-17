import assert from "node:assert/strict";

import { cacheMediaAssets } from "../../collect-instagram/media_cache.ts";
import type {
  MediaAssetRepository,
  MediaStorage,
  NormalizedBatch,
  PendingMediaAsset,
  StoredMediaAsset,
} from "../../collect-instagram/types.ts";

const sourceAccountId = "00000000-0000-4000-8000-000000000001";
const rawPostId = "00000000-0000-4000-8000-000000000002";
const batch: NormalizedBatch = {
  username: "utdreport",
  account: {
    instagramAccountId: "17841400000000001",
    followersCount: 10,
    capabilities: {
      followersAvailable: true,
      likesAvailable: true,
      commentsAvailable: true,
      viewsAvailable: false,
      mediaUrlAvailable: true,
      carouselChildrenAvailable: true,
    },
  },
  posts: [{
    externalPostId: "post-1",
    caption: null,
    permalink: null,
    mediaType: "CAROUSEL_ALBUM",
    mediaProductType: null,
    publishedAt: "2026-09-17T02:30:00.000Z",
    likeCount: 1,
    commentsCount: 0,
    viewCount: null,
    followersCountAtCollection: 10,
    postAgeMinutes: 30,
    rawPayload: { id: "post-1" },
    assets: [0, 1, 2].map((index) => ({
      externalMediaId: `child-${index + 1}`,
      assetType: "CAROUSEL_CHILD" as const,
      carouselIndex: index,
      originalMediaUrl: `https://cdn.example/child-${index + 1}.jpg`,
    })),
  }],
  collectedAt: "2026-09-17T03:00:00.000Z",
  receivedMedia: 1,
};

Deno.test("isolates one media failure, finalizes successes, and limits concurrency", async () => {
  const pending: PendingMediaAsset[] = batch.posts[0].assets.map((
    asset,
    index,
  ) => ({
    mediaAssetId: `00000000-0000-4000-8000-00000000001${index}`,
    rawPostId,
    externalMediaId: asset.externalMediaId,
    assetType: asset.assetType,
    carouselIndex: asset.carouselIndex,
    originalMediaUrl: asset.originalMediaUrl,
  }));
  const finalized: StoredMediaAsset[] = [];
  const repository: MediaAssetRepository = {
    prepareMediaAssets: () => Promise.resolve(pending),
    finalizeMediaAssets: (_accountId, assets) => {
      finalized.push(...assets);
      return Promise.resolve(assets.length);
    },
  };
  let active = 0;
  let maxObservedConcurrency = 0;
  const storage: MediaStorage = {
    store: async (media) => {
      active += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (media.externalMediaId === "child-2") {
        throw new Error("safe test failure");
      }
      return {
        mediaAssetId: media.mediaAssetId,
        storagePath: `instagram/account/post/${media.externalMediaId}.jpg`,
        mimeType: "image/jpeg",
        fetchedAt: "2026-09-17T03:00:00.000Z",
      };
    },
  };

  const result = await cacheMediaAssets({
    workItems: [{
      sourceAccountId,
      batch,
      ingestedPosts: [{ externalPostId: "post-1", rawPostId }],
    }],
    repository,
    storage,
    concurrency: 2,
    limit: 20,
    deadlineAt: 100_000,
    now: () => 0,
  });

  assert.deepEqual(
    { assetsStored: result.assetsStored, assetsFailed: result.assetsFailed },
    { assetsStored: 2, assetsFailed: 1 },
  );
  assert.equal(finalized.length, 2);
  assert.deepEqual(
    finalized.map((item) => item.mediaAssetId),
    [pending[0].mediaAssetId, pending[2].mediaAssetId],
  );
  assert.equal(maxObservedConcurrency, 2);
});
