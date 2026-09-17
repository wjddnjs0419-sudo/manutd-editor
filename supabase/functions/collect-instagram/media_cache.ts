import type {
  MediaAssetRepository,
  MediaStorage,
  MediaWorkItem,
  PendingMediaAsset,
  PreparedMediaAsset,
  StoredMediaAsset,
} from "./types.ts";

export interface MediaCacheResult {
  assetsStored: number;
  assetsFailed: number;
  bySourceAccountId: Record<string, {
    assetsStored: number;
    assetsFailed: number;
  }>;
}

export interface CacheMediaAssetsOptions {
  workItems: MediaWorkItem[];
  repository: MediaAssetRepository;
  storage: MediaStorage;
  concurrency: number;
  limit: number;
  deadlineAt: number;
  now?: () => number;
}

interface PendingWork {
  sourceAccountId: string;
  externalPostId: string;
  asset: PendingMediaAsset;
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function accountCounts(
  result: MediaCacheResult,
  sourceAccountId: string,
): { assetsStored: number; assetsFailed: number } {
  return result.bySourceAccountId[sourceAccountId] ??= {
    assetsStored: 0,
    assetsFailed: 0,
  };
}

export async function cacheMediaAssets(
  options: CacheMediaAssetsOptions,
): Promise<MediaCacheResult> {
  if (
    !Number.isInteger(options.concurrency) || options.concurrency < 1 ||
    options.concurrency > 2 || !Number.isInteger(options.limit) ||
    options.limit < 1
  ) {
    throw new Error("Media cache configuration is invalid");
  }
  const now = options.now ?? Date.now;
  const result: MediaCacheResult = {
    assetsStored: 0,
    assetsFailed: 0,
    bySourceAccountId: {},
  };
  const pendingWork: PendingWork[] = [];

  for (const workItem of options.workItems) {
    const counts = accountCounts(result, workItem.sourceAccountId);
    const rawPostByExternalId = new Map(
      workItem.ingestedPosts.map((
        post,
      ) => [post.externalPostId, post.rawPostId]),
    );
    const externalPostByRawId = new Map(
      workItem.ingestedPosts.map((
        post,
      ) => [post.rawPostId, post.externalPostId]),
    );
    const descriptors: PreparedMediaAsset[] = [];
    for (const post of workItem.batch.posts) {
      const rawPostId = rawPostByExternalId.get(post.externalPostId);
      if (rawPostId === undefined) {
        counts.assetsFailed += post.assets.length;
        result.assetsFailed += post.assets.length;
        continue;
      }
      descriptors.push(...post.assets.map((asset) => ({
        rawPostId,
        externalMediaId: asset.externalMediaId,
        assetType: asset.assetType,
        carouselIndex: asset.carouselIndex,
        originalMediaUrl: asset.originalMediaUrl,
      })));
    }
    if (descriptors.length === 0) continue;

    let pending: PendingMediaAsset[];
    try {
      pending = await options.repository.prepareMediaAssets(
        workItem.sourceAccountId,
        descriptors,
      );
    } catch {
      counts.assetsFailed += descriptors.length;
      result.assetsFailed += descriptors.length;
      continue;
    }
    for (const asset of pending) {
      const externalPostId = externalPostByRawId.get(asset.rawPostId);
      if (externalPostId === undefined) {
        counts.assetsFailed += 1;
        result.assetsFailed += 1;
        continue;
      }
      pendingWork.push({
        sourceAccountId: workItem.sourceAccountId,
        externalPostId,
        asset,
      });
    }
  }

  const selected = pendingWork.slice(0, options.limit);
  const uploadResults = await mapBounded(
    selected,
    options.concurrency,
    async (work): Promise<{ work: PendingWork; stored?: StoredMediaAsset }> => {
      if (now() >= options.deadlineAt) return { work };
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.max(1, options.deadlineAt - now()),
      );
      try {
        const stored = await options.storage.store(work.asset, {
          sourceAccountId: work.sourceAccountId,
          externalPostId: work.externalPostId,
          fetchedAt: new Date(now()),
          signal: controller.signal,
        });
        return { work, stored };
      } catch {
        const counts = accountCounts(result, work.sourceAccountId);
        counts.assetsFailed += 1;
        result.assetsFailed += 1;
        return { work };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );

  const storedByAccount = new Map<string, StoredMediaAsset[]>();
  for (const upload of uploadResults) {
    if (upload.stored === undefined) continue;
    const stored = storedByAccount.get(upload.work.sourceAccountId) ?? [];
    stored.push(upload.stored);
    storedByAccount.set(upload.work.sourceAccountId, stored);
  }

  for (const [sourceAccountId, stored] of storedByAccount) {
    const counts = accountCounts(result, sourceAccountId);
    try {
      const finalized = await options.repository.finalizeMediaAssets(
        sourceAccountId,
        stored,
      );
      counts.assetsStored += finalized;
      result.assetsStored += finalized;
      const missing = stored.length - finalized;
      counts.assetsFailed += missing;
      result.assetsFailed += missing;
    } catch {
      counts.assetsFailed += stored.length;
      result.assetsFailed += stored.length;
    }
  }

  return result;
}
