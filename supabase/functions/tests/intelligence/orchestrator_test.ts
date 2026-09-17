import assert from "node:assert/strict";

import {
  deriveLifecycleStatus,
  runIntelligence,
  type RunIntelligenceOptions,
} from "../../intelligence/orchestrator.ts";
import {
  createIntelligenceRepository,
  type EligibleAccountSnapshot,
  type IntelligenceRepository,
  type StoryClusterContext,
} from "../../intelligence/repository.ts";
import type { IntelligenceConfig } from "../../intelligence/types.ts";

const runAt = new Date("2026-09-18T12:00:00.000Z");
const config: IntelligenceConfig = {
  aiEnabled: false,
  aiModel: "gpt-5-mini",
  aiPromptVersion: "cluster-v1",
  dictionaryVersion: "entity-v1",
  leaseSeconds: 60,
  heartbeatSeconds: 10,
};

const accountSnapshot: EligibleAccountSnapshot = {
  runAt: runAt.toISOString(),
  eligible: [],
  pendingCapabilityAccountIds: ["pending-account"],
  unsupportedAccountIds: ["unsupported-account"],
  freshSuccessfulAccountIds: [],
};

function repository(
  overrides: Partial<IntelligenceRepository> = {},
): IntelligenceRepository {
  return {
    loadEligibleAccounts: async () => accountSnapshot,
    listRecentPosts: async () => [],
    listClusterContexts: async () => [],
    listInformationSources: async () => [],
    createCluster: async () => "cluster-created",
    upsertMembership: async () => undefined,
    saveEvaluation: async () => undefined,
    upsertClusterSources: async () => undefined,
    calculateCandidates: async () => 0,
    tryAcquireRun: async () => true,
    renewRun: async () => true,
    releaseRun: async () => undefined,
    ...overrides,
  };
}

function options(
  repo: IntelligenceRepository,
  overrides: Partial<RunIntelligenceOptions> = {},
): RunIntelligenceOptions {
  return { repository: repo, config, runAt, ...overrides };
}

Deno.test("returns already_running without processing when the lease is busy", async () => {
  let processed = false;
  const result = await runIntelligence(options(repository({
    tryAcquireRun: async () => false,
    listRecentPosts: async () => {
      processed = true;
      return [];
    },
  })));

  assert.equal(result.status, "already_running");
  assert.equal(result.clustersProcessed, 0);
  assert.equal(result.candidatesUpserted, 0);
  assert.equal(processed, false);
});

Deno.test("takes over after a previously acquired lease expires", async () => {
  let acquireCalls = 0;
  let processed = 0;
  const repo = repository({
    tryAcquireRun: async () => {
      acquireCalls += 1;
      return acquireCalls === 2;
    },
    calculateCandidates: async () => {
      processed += 1;
      return 0;
    },
  });

  assert.equal((await runIntelligence(options(repo))).status, "already_running");
  assert.equal((await runIntelligence(options(repo))).status, "completed");
  assert.equal(processed, 1);
});

Deno.test("uses configured heartbeat, renews, and releases the lease", async () => {
  const intervals: number[] = [];
  let heartbeat: (() => void) | undefined;
  let renewals = 0;
  let releases = 0;
  const result = await runIntelligence(options(repository({
    renewRun: async () => {
      renewals += 1;
      return true;
    },
    releaseRun: async () => {
      releases += 1;
    },
  }), {
    setIntervalFn: ((callback: () => void, milliseconds: number) => {
      intervals.push(milliseconds);
      heartbeat = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearIntervalFn: (() => undefined) as typeof clearInterval,
  }));

  heartbeat?.();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(result.status, "completed");
  assert.deepEqual(intervals, [10_000]);
  assert.equal(renewals, 1);
  assert.equal(releases, 1);
});

Deno.test("eligible snapshot excludes pending and unsupported capabilities", async () => {
  let captured: EligibleAccountSnapshot | undefined;
  await runIntelligence(options(repository({
    loadEligibleAccounts: async () => ({
      ...accountSnapshot,
      eligible: [{
        id: "global-account",
        username: "global",
        region: "GLOBAL",
        active: true,
        apiSupported: true,
        priorityWeight: 1,
        lastProbeAt: runAt.toISOString(),
        probeError: null,
      }],
    }),
  }), {
    onEligibleAccounts: (snapshot) => {
      captured = snapshot;
    },
  }));

  assert.deepEqual(captured?.pendingCapabilityAccountIds, ["pending-account"]);
  assert.deepEqual(captured?.unsupportedAccountIds, ["unsupported-account"]);
  assert.deepEqual(captured?.eligible.map((account) => account.id), ["global-account"]);
});

Deno.test("rerunning the same input is idempotent and invokes scoring once per run", async () => {
  let memberships = 0;
  const methods: string[] = [];
  let storedContexts: StoryClusterContext[] = [];
  let candidateCalls = 0;
  const repo = repository({
    listRecentPosts: async () => [{
      id: "post-1",
      sourceAccountId: "global-account",
      caption: "Bruno injury update",
      mediaType: "IMAGE",
      publishedAt: "2026-09-18T11:00:00.000Z",
      collectedAt: "2026-09-18T11:05:00.000Z",
      likeCount: 10,
      commentsCount: 1,
      followersCountAtCollection: 100,
      createdAt: "2026-09-18T11:05:00.000Z",
    }],
    listClusterContexts: async () => storedContexts,
    upsertMembership: async (input) => {
      memberships += 1;
      methods.push("SEED");
      storedContexts = [{
        id: input.clusterId,
        canonicalTitle: "bruno injury",
        status: "OPEN",
        firstSeenAt: "2026-09-18T11:00:00.000Z",
        lastSeenAt: "2026-09-18T11:00:00.000Z",
        signature: input.signature,
        members: [{
          rawPostId: input.rawPostId,
          createdAt: "2026-09-18T11:05:00.000Z",
          matchMethod: input.matchMethod,
          matchConfidence: input.matchConfidence,
        }],
      }];
    },
    calculateCandidates: async () => {
      candidateCalls += 1;
      return 1;
    },
  });

  const first = await runIntelligence(options(repo));
  const second = await runIntelligence(options(repo));

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(memberships, 1);
  assert.deepEqual(methods, ["SEED"]);
  assert.equal(candidateCalls, 2);
});

Deno.test("manual review does not create membership but is retained as an evaluation", async () => {
  let memberships = 0;
  let evaluations = 0;
  const cluster: StoryClusterContext = {
    id: "candidate-cluster",
    canonicalTitle: "bruno injury",
    status: "OPEN",
    firstSeenAt: "2026-09-18T10:30:00.000Z",
    lastSeenAt: "2026-09-18T10:30:00.000Z",
    signature: {
      entities: ["bruno_fernandes"],
      events: [],
      sources: [],
      numbers: [],
      first_published_at: "2026-09-18T10:30:00.000Z",
      last_published_at: "2026-09-18T10:30:00.000Z",
      representative_post_ids: ["existing-post"],
      dictionary_version: "entity-v1",
    },
    members: [{
      rawPostId: "existing-post",
      createdAt: "2026-09-18T10:30:00.000Z",
      matchMethod: "SEED",
      matchConfidence: 1,
    }],
  };
  const result = await runIntelligence(options(repository({
    listRecentPosts: async () => [{
      id: "post-ambiguous",
      sourceAccountId: "global-account",
      caption: "Bruno update",
      mediaType: "IMAGE",
      publishedAt: "2026-09-18T11:00:00.000Z",
      collectedAt: "2026-09-18T11:05:00.000Z",
      likeCount: null,
      commentsCount: null,
      followersCountAtCollection: null,
      createdAt: "2026-09-18T11:05:00.000Z",
    }],
    listClusterContexts: async () => [cluster],
    upsertMembership: async () => {
      memberships += 1;
    },
    saveEvaluation: async () => {
      evaluations += 1;
    },
  }), {
    classify: async () => ({
      decision: "MANUAL_REVIEW",
      sameStory: null,
      confidence: null,
      reason: "AI_DISABLED",
      model: "gpt-5-mini",
      promptVersion: "cluster-v1",
      dictionaryVersion: "entity-v1",
      classifierVersion: "gpt-5-mini:cluster-v1:entity-v1",
      inputHash: "a".repeat(64),
      inputSnapshot: {
        raw_post: {} as never,
        aggregate_signature: {} as never,
      },
      result: { same_story: null, confidence: null, reason: "AI_DISABLED" },
    }),
  }));

  assert.equal(result.status, "completed");
  assert.equal(memberships, 0);
  assert.equal(evaluations, 1);
});

Deno.test("lifecycle uses exact six-hour and seven-day boundaries", () => {
  const cases = [
    ["exactly six hours", new Date(runAt.getTime() - 6 * 60 * 60 * 1000), "ACTIVE"],
    ["just over six hours", new Date(runAt.getTime() - 6 * 60 * 60 * 1000 - 1), "STALE"],
    ["exactly seven days", new Date(runAt.getTime() - 7 * 24 * 60 * 60 * 1000), "STALE"],
    ["just over seven days", new Date(runAt.getTime() - 7 * 24 * 60 * 60 * 1000 - 1), "ARCHIVED"],
    ["future timestamp", new Date(runAt.getTime() + 1), "OPEN"],
  ] as const;

  for (const [name, lastSeenAt, expected] of cases) {
    assert.equal(
      deriveLifecycleStatus({
        currentStatus: "OPEN",
        lastSeenAt: lastSeenAt.toISOString(),
        memberCount: name === "exactly six hours" ? 2 : 1,
        runAt: runAt.toISOString(),
      }),
      expected,
      name,
    );
  }
});

Deno.test("repository keeps capability audit fields and real run timestamp predicates", async () => {
  const urls: string[] = [];
  const repository = createIntelligenceRepository({
    supabaseUrl: "https://example.test",
    serviceRoleKey: "service-role-secret",
    fetch: (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("source_accounts") && !url.includes("raw_posts")) {
        return Promise.resolve(new Response(JSON.stringify([
          {
            id: "eligible",
            username: "global",
            region: "GLOBAL",
            active: true,
            api_supported: true,
            priority_weight: 2,
            last_probe_at: runAt.toISOString(),
            probe_error: null,
          },
          {
            id: "pending",
            username: "pending",
            region: "KR",
            active: true,
            api_supported: null,
            priority_weight: 1,
            last_probe_at: null,
            probe_error: null,
          },
          {
            id: "unsupported",
            username: "unsupported",
            region: "KR",
            active: true,
            api_supported: false,
            priority_weight: 1,
            last_probe_at: runAt.toISOString(),
            probe_error: "unsupported",
          },
        ]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    },
  });

  const accounts = await repository.loadEligibleAccounts(runAt);
  await repository.listRecentPosts(runAt);

  assert.deepEqual(accounts.eligible.map((account) => account.id), ["eligible"]);
  assert.deepEqual(accounts.pendingCapabilityAccountIds, ["pending"]);
  assert.deepEqual(accounts.unsupportedAccountIds, ["unsupported"]);
  const postQuery = urls.find((url) => url.includes("raw_posts")) ?? "";
  assert.match(postQuery, /published_at%3Dgte|published_at=gte/);
  assert.match(postQuery, /published_at%3Dlte|published_at=lte/);
  assert.match(postQuery, /2026-09-17/);
  assert.match(postQuery, /2026-09-18/);
});
