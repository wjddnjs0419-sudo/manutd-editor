import { MetaApiError } from "./meta_client.ts";
import { cacheMediaAssets } from "./media_cache.ts";
import { RepositoryError } from "./repository.ts";
import type {
  AccountCollectionResult,
  AccountFailureCategory,
  AccountRepository,
  CollectionRunSummary,
  CoreCollectionResult,
  MediaAssetRepository,
  MediaStorage,
  MediaWorkItem,
  SourceAccount,
} from "./types.ts";

export class CollectionInputError extends Error {
  constructor() {
    super("Collection request is invalid");
    this.name = "CollectionInputError";
  }
}

export interface RunInstagramCollectionOptions {
  requestedSourceAccountIds?: string[];
  collectedAt: Date;
  concurrency: number;
  runBudgetMs: number;
  accountBudgetMs: number;
  accountRepository: AccountRepository;
  collectAccount: (
    account: SourceAccount,
    collectedAt: Date,
    signal: AbortSignal,
  ) => Promise<CoreCollectionResult>;
  mediaRepository?: MediaAssetRepository;
  mediaStorage?: MediaStorage;
  mediaConcurrency?: number;
  mediaLimitPerRun?: number;
  now?: () => number;
}

interface CoreWorkerResult {
  account: AccountCollectionResult;
  mediaWork?: MediaWorkItem;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new CollectionInputError();
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker(),
    ),
  );
  return results;
}

function failedResult(
  sourceAccountId: string,
  errorCategory: AccountFailureCategory,
): AccountCollectionResult {
  return {
    sourceAccountId,
    status: "failed",
    errorCategory,
    insertedPosts: 0,
    updatedPosts: 0,
    insertedSnapshots: 0,
    assetsStored: 0,
    assetsFailed: 0,
  };
}

function failureCategory(
  error: unknown,
  signal: AbortSignal,
): AccountFailureCategory {
  if (signal.aborted) return "temporary_upstream";
  if (error instanceof MetaApiError) return error.category;
  if (error instanceof RepositoryError) return "database";
  if (error instanceof Error && error.name === "ValidationError") {
    return "invalid_payload";
  }
  return "internal";
}

function markUnsupported(category: AccountFailureCategory): boolean {
  return category === "unsupported_account" || category === "permission";
}

async function recordFailureSafely(
  repository: AccountRepository,
  account: SourceAccount,
  collectedAt: Date,
  category: AccountFailureCategory,
): Promise<void> {
  try {
    await repository.recordFailure({
      sourceAccountId: account.id,
      probedAt: collectedAt.toISOString(),
      category,
      markUnsupported: markUnsupported(category),
    });
  } catch {
    // Failure persistence must not replace the original account result.
  }
}

function selectAccounts(
  activeAccounts: SourceAccount[],
  requestedSourceAccountIds?: string[],
): SourceAccount[] {
  if (requestedSourceAccountIds === undefined) return activeAccounts;
  if (
    requestedSourceAccountIds.length === 0 ||
    new Set(requestedSourceAccountIds).size !== requestedSourceAccountIds.length
  ) {
    throw new CollectionInputError();
  }

  const requested = new Set(requestedSourceAccountIds);
  const selected = activeAccounts.filter((account) =>
    requested.has(account.id)
  );
  if (selected.length !== requested.size) throw new CollectionInputError();
  return selected;
}

export async function runInstagramCollection(
  options: RunInstagramCollectionOptions,
): Promise<CollectionRunSummary> {
  if (
    !Number.isInteger(options.concurrency) || options.concurrency < 1 ||
    options.concurrency > 3 || !Number.isFinite(options.runBudgetMs) ||
    options.runBudgetMs <= 0 || !Number.isFinite(options.accountBudgetMs) ||
    options.accountBudgetMs <= 0 ||
    !Number.isFinite(options.collectedAt.getTime())
  ) {
    throw new CollectionInputError();
  }

  const now = options.now ?? Date.now;
  const mediaOptions = [
    options.mediaRepository,
    options.mediaStorage,
    options.mediaConcurrency,
    options.mediaLimitPerRun,
  ];
  if (
    mediaOptions.some((value) => value !== undefined) &&
    mediaOptions.some((value) => value === undefined)
  ) {
    throw new CollectionInputError();
  }
  const deadline = now() + options.runBudgetMs;
  const activeAccounts = await options.accountRepository.listActive();
  const selectedAccounts = selectAccounts(
    activeAccounts,
    options.requestedSourceAccountIds,
  );

  const coreResults = await mapWithConcurrency(
    selectedAccounts,
    options.concurrency,
    async (account): Promise<CoreWorkerResult> => {
      if (now() >= deadline) {
        const category = "run_budget_exhausted";
        await recordFailureSafely(
          options.accountRepository,
          account,
          options.collectedAt,
          category,
        );
        return { account: failedResult(account.id, category) };
      }

      const controller = new AbortController();
      const remainingRunMs = Math.max(1, deadline - now());
      const timeoutId = setTimeout(
        () => controller.abort(),
        Math.min(options.accountBudgetMs, remainingRunMs),
      );
      try {
        const result = await options.collectAccount(
          account,
          options.collectedAt,
          controller.signal,
        );
        return {
          account: {
            sourceAccountId: account.id,
            status: "success",
            insertedPosts: result.summary.insertedPosts,
            updatedPosts: result.summary.updatedPosts,
            insertedSnapshots: result.summary.insertedSnapshots,
            assetsStored: 0,
            assetsFailed: 0,
          },
          mediaWork: result.mediaWork,
        };
      } catch (error) {
        const category = failureCategory(error, controller.signal);
        await recordFailureSafely(
          options.accountRepository,
          account,
          options.collectedAt,
          category,
        );
        return { account: failedResult(account.id, category) };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  );

  const accounts = coreResults.map((result) => result.account);
  if (
    options.mediaRepository !== undefined &&
    options.mediaStorage !== undefined &&
    options.mediaConcurrency !== undefined &&
    options.mediaLimitPerRun !== undefined
  ) {
    try {
      const media = await cacheMediaAssets({
        workItems: coreResults.flatMap((result) =>
          result.mediaWork === undefined ? [] : [result.mediaWork]
        ),
        repository: options.mediaRepository,
        storage: options.mediaStorage,
        concurrency: options.mediaConcurrency,
        limit: options.mediaLimitPerRun,
        deadlineAt: deadline,
        now,
      });
      for (const account of accounts) {
        const counts = media.bySourceAccountId[account.sourceAccountId];
        if (counts !== undefined) {
          account.assetsStored = counts.assetsStored;
          account.assetsFailed = counts.assetsFailed;
        }
      }
    } catch {
      // Auxiliary media work must never replace completed core results.
    }
  }

  return {
    accountsRequested: accounts.length,
    accountsSuccess: accounts.filter((result) => result.status === "success")
      .length,
    accountsFailed: accounts.filter((result) => result.status === "failed")
      .length,
    postsCreated: accounts.reduce(
      (total, result) => total + result.insertedPosts,
      0,
    ),
    postsUpdated: accounts.reduce(
      (total, result) => total + result.updatedPosts,
      0,
    ),
    snapshotsCreated: accounts.reduce(
      (total, result) => total + result.insertedSnapshots,
      0,
    ),
    assetsStored: accounts.reduce(
      (total, result) => total + result.assetsStored,
      0,
    ),
    assetsFailed: accounts.reduce(
      (total, result) => total + result.assetsFailed,
      0,
    ),
    accounts,
  };
}
