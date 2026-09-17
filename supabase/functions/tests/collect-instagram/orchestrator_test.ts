import assert from "node:assert/strict";

import {
  CollectionInputError,
  runInstagramCollection,
} from "../../collect-instagram/orchestrator.ts";
import { MetaApiError } from "../../collect-instagram/meta_client.ts";
import type {
  AccountFailureCategory,
  AccountRepository,
  CollectionSummary,
  CoreCollectionResult,
  MediaAssetRepository,
  MediaStorage,
  NormalizedBatch,
  SourceAccount,
} from "../../collect-instagram/types.ts";

const accounts: SourceAccount[] = Array.from({ length: 5 }, (_, index) => ({
  id: `00000000-0000-4000-8000-00000000000${index + 1}`,
  username: `account${index + 1}`,
}));
const collectedAt = new Date("2026-09-17T03:00:00.000Z");

function success(account: SourceAccount): CollectionSummary {
  return {
    username: account.username,
    accountId: account.id,
    receivedMedia: 1,
    deduplicatedMedia: 1,
    insertedPosts: 1,
    updatedPosts: 2,
    insertedSnapshots: 1,
    posts: [],
  };
}

function coreSuccess(account: SourceAccount): CoreCollectionResult {
  const summary = success(account);
  return {
    summary,
    mediaWork: {
      sourceAccountId: account.id,
      batch: {
        username: account.username,
        account: {
          instagramAccountId: `instagram-${account.username}`,
          followersCount: 10,
          capabilities: {
            followersAvailable: true,
            likesAvailable: true,
            commentsAvailable: true,
            viewsAvailable: false,
            mediaUrlAvailable: false,
            carouselChildrenAvailable: false,
          },
        },
        posts: [],
        collectedAt: collectedAt.toISOString(),
        receivedMedia: 0,
      },
      ingestedPosts: [],
    },
  };
}

function accountRepository(
  activeAccounts: SourceAccount[],
  failures: Array<{
    sourceAccountId: string;
    category: AccountFailureCategory;
    markUnsupported: boolean;
  }>,
): AccountRepository {
  return {
    listActive: () => Promise.resolve(activeAccounts),
    recordFailure: (failure) => {
      failures.push({
        sourceAccountId: failure.sourceAccountId,
        category: failure.category,
        markUnsupported: failure.markUnsupported,
      });
      return Promise.resolve();
    },
  };
}

Deno.test("limits concurrency to two and isolates one account failure", async () => {
  let active = 0;
  let maxObservedConcurrency = 0;
  const failures: Array<{
    sourceAccountId: string;
    category: AccountFailureCategory;
    markUnsupported: boolean;
  }> = [];

  const summary = await runInstagramCollection({
    requestedSourceAccountIds: undefined,
    collectedAt,
    concurrency: 2,
    runBudgetMs: 100_000,
    accountBudgetMs: 20_000,
    accountRepository: accountRepository(accounts, failures),
    collectAccount: async (account) => {
      active += 1;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (account.id === accounts[2].id) {
        throw new MetaApiError(
          "META_HTTP_ERROR",
          403,
          false,
          "permission",
        );
      }
      return coreSuccess(account);
    },
  });

  assert.equal(maxObservedConcurrency, 2);
  assert.equal(summary.accountsRequested, 5);
  assert.equal(summary.accountsSuccess, 4);
  assert.equal(summary.accountsFailed, 1);
  assert.equal(summary.postsCreated, 4);
  assert.equal(summary.postsUpdated, 8);
  assert.equal(summary.snapshotsCreated, 4);
  assert.equal(summary.assetsStored, 0);
  assert.equal(summary.assetsFailed, 0);
  assert.deepEqual(
    summary.accounts.map((result) => result.sourceAccountId),
    accounts.map((account) => account.id),
  );
  assert.deepEqual(failures, [{
    sourceAccountId: accounts[2].id,
    category: "permission",
    markUnsupported: true,
  }]);
});

Deno.test("rejects a requested account ID outside the active DB set", async () => {
  let collectionCalls = 0;
  await assert.rejects(
    runInstagramCollection({
      requestedSourceAccountIds: [
        accounts[0].id,
        "00000000-0000-4000-8000-000000000099",
      ],
      collectedAt,
      concurrency: 2,
      runBudgetMs: 100_000,
      accountBudgetMs: 20_000,
      accountRepository: accountRepository(accounts, []),
      collectAccount: (account) => {
        collectionCalls += 1;
        return Promise.resolve(coreSuccess(account));
      },
    }),
    (error: unknown) => error instanceof CollectionInputError,
  );
  assert.equal(collectionCalls, 0);
});

Deno.test("marks accounts not started before the run deadline as exhausted", async () => {
  let clock = 0;
  const failures: Array<{
    sourceAccountId: string;
    category: AccountFailureCategory;
    markUnsupported: boolean;
  }> = [];
  const summary = await runInstagramCollection({
    requestedSourceAccountIds: undefined,
    collectedAt,
    concurrency: 1,
    runBudgetMs: 100,
    accountBudgetMs: 20_000,
    accountRepository: accountRepository(accounts.slice(0, 3), failures),
    collectAccount: (account) => {
      clock = 101;
      return Promise.resolve(coreSuccess(account));
    },
    now: () => clock,
  });

  assert.equal(summary.accountsSuccess, 1);
  assert.equal(summary.accountsFailed, 2);
  assert.deepEqual(
    summary.accounts.map((result) => result.errorCategory ?? "success"),
    ["success", "run_budget_exhausted", "run_budget_exhausted"],
  );
  assert.deepEqual(
    failures.map((failure) => failure.category),
    ["run_budget_exhausted", "run_budget_exhausted"],
  );
});

Deno.test("starts auxiliary media only after every core account and preserves core success", async () => {
  const events: string[] = [];
  const mediaBatch = (account: SourceAccount): NormalizedBatch => ({
    ...coreSuccess(account).mediaWork.batch,
    posts: [{
      externalPostId: `post-${account.username}`,
      caption: null,
      permalink: null,
      mediaType: "IMAGE",
      mediaProductType: null,
      publishedAt: "2026-09-17T02:30:00.000Z",
      likeCount: 1,
      commentsCount: 0,
      viewCount: null,
      followersCountAtCollection: 10,
      postAgeMinutes: 30,
      rawPayload: { id: `post-${account.username}` },
      assets: [{
        externalMediaId: `image-${account.username}`,
        assetType: "IMAGE",
        carouselIndex: null,
        originalMediaUrl: `https://cdn.example/${account.username}.jpg`,
      }],
    }],
  });
  const mediaRepository: MediaAssetRepository = {
    prepareMediaAssets: (sourceAccountId) => {
      events.push(`prepare:${sourceAccountId}`);
      if (sourceAccountId === accounts[0].id) {
        return Promise.reject(new Error("safe prepare failure"));
      }
      return Promise.resolve([]);
    },
    finalizeMediaAssets: () => Promise.resolve(0),
  };
  const mediaStorage: MediaStorage = {
    store: () => Promise.reject(new Error("must not upload")),
  };

  const summary = await runInstagramCollection({
    requestedSourceAccountIds: undefined,
    collectedAt,
    concurrency: 2,
    runBudgetMs: 100_000,
    accountBudgetMs: 20_000,
    accountRepository: accountRepository(accounts.slice(0, 2), []),
    collectAccount: (account) => {
      events.push(`core:${account.id}`);
      const result = coreSuccess(account);
      result.mediaWork.batch = mediaBatch(account);
      result.mediaWork.ingestedPosts = [{
        externalPostId: `post-${account.username}`,
        rawPostId: account.id,
      }];
      return Promise.resolve(result);
    },
    mediaRepository,
    mediaStorage,
    mediaConcurrency: 2,
    mediaLimitPerRun: 20,
  });

  const lastCore = Math.max(
    ...events.map((event, index) => event.startsWith("core:") ? index : -1),
  );
  const firstPrepare = events.findIndex((event) =>
    event.startsWith("prepare:")
  );
  assert.ok(firstPrepare > lastCore);
  assert.equal(summary.accountsSuccess, 2);
  assert.equal(summary.accountsFailed, 0);
  assert.equal(summary.assetsFailed, 1);
  assert.equal(summary.accounts[0].status, "success");
  assert.equal(summary.accounts[0].assetsFailed, 1);
});

Deno.test("aborts an account that exceeds its account budget", async () => {
  const failures: Array<{
    sourceAccountId: string;
    category: AccountFailureCategory;
    markUnsupported: boolean;
  }> = [];
  let observedAbort = false;
  const summary = await runInstagramCollection({
    requestedSourceAccountIds: undefined,
    collectedAt,
    concurrency: 1,
    runBudgetMs: 1_000,
    accountBudgetMs: 10,
    accountRepository: accountRepository(accounts.slice(0, 1), failures),
    collectAccount: (_account, _collectedAt, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("private timeout detail", "AbortError"));
        }, { once: true });
      }),
  });

  assert.equal(observedAbort, true);
  assert.equal(summary.accountsSuccess, 0);
  assert.equal(summary.accountsFailed, 1);
  assert.equal(summary.accounts[0].errorCategory, "temporary_upstream");
  assert.deepEqual(failures.map((failure) => failure.category), [
    "temporary_upstream",
  ]);
});
