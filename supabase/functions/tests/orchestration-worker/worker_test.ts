import assert from "node:assert/strict";

import { createOrchestrationWorker } from "../../orchestration-worker/worker.ts";
import type {
  BoundaryInvoker,
  EditorialJob,
  EditorialJobQueue,
  EditorialJobType,
} from "../../orchestration-worker/types.ts";

const now = new Date("2026-09-26T00:00:00.000Z");
const storyOne = "11111111-1111-4111-8111-111111111111";
const storyTwo = "22222222-2222-4222-8222-222222222222";
const storyOther = "33333333-3333-4333-8333-333333333333";

function job(
  id: string,
  jobType: EditorialJobType,
  overrides: Partial<EditorialJob> = {},
): EditorialJob {
  return {
    id,
    job_type: jobType,
    payload: { chain_key: "pipeline-1" },
    dedupe_key: `pipeline-1:${jobType}`,
    status: "PENDING",
    attempt_count: 1,
    max_attempts: 3,
    available_at: now.toISOString(),
    locked_at: now.toISOString(),
    locked_by: "worker-1",
    last_error_category: null,
    last_error_message: null,
    created_at: now.toISOString(),
    started_at: now.toISOString(),
    finished_at: null,
    updated_at: now.toISOString(),
    ...overrides,
  };
}

function queueWith(
  initialJobs: readonly EditorialJob[],
  options: { repeatClaims?: boolean; enqueueFailures?: number } = {},
): EditorialJobQueue & {
  readonly completed: string[];
  readonly failed: Array<{ id: string; category: string; message: string }>;
  readonly enqueued: Map<string, string>;
  readonly enqueueCalls: Array<{ jobType: EditorialJobType; payload: Record<string, unknown>; dedupeKey: string }>;
  readonly payloadUpdates: Array<{ jobId: string; patch: Record<string, unknown> }>;
} {
  const jobs = [...initialJobs];
  const completed: string[] = [];
  const failed: Array<{ id: string; category: string; message: string }> = [];
  const enqueued = new Map<string, string>();
  const enqueueCalls: Array<{ jobType: EditorialJobType; payload: Record<string, unknown>; dedupeKey: string }> = [];
  const payloadUpdates: Array<{ jobId: string; patch: Record<string, unknown> }> = [];
  let enqueueFailuresRemaining = options.enqueueFailures ?? 0;
  let enqueueSequence = 0;
  return {
    completed,
    failed,
    enqueued,
    enqueueCalls,
    payloadUpdates,
    async claim() {
      if (options.repeatClaims) return jobs;
      const pending = jobs.filter((entry) => entry.status === "PENDING");
      pending.forEach((entry) => entry.status = "RUNNING");
      return pending;
    },
    async complete(id) {
      completed.push(id);
      const entry = jobs.find((value) => value.id === id);
      if (entry) entry.status = "SUCCEEDED";
      return true;
    },
    async fail(id, _workerId, category, message) {
      failed.push({ id, category, message });
      const entry = jobs.find((value) => value.id === id);
      if (entry) entry.status = "PENDING";
      return entry ?? job(id, "COLLECT_INSTAGRAM");
    },
    async enqueue(jobType, payload, dedupeKey) {
      enqueueCalls.push({ jobType, payload, dedupeKey });
      if (enqueueFailuresRemaining > 0) {
        enqueueFailuresRemaining -= 1;
        throw new Error("QUEUE_ENQUEUE_FAILED");
      }
      const existing = enqueued.get(dedupeKey);
      if (existing) return existing;
      const id = `downstream-${++enqueueSequence}`;
      enqueued.set(dedupeKey, id);
      return id;
    },
    async updatePayload(jobId, patch) {
      payloadUpdates.push({ jobId, patch });
      const entry = jobs.find((value) => value.id === jobId);
      if (entry) Object.assign(entry.payload, patch);
    },
  };
}

function invoker(
  handler: (jobType: EditorialJobType) => Promise<{ status: number; body?: unknown }>,
): BoundaryInvoker {
  return { invoke: async (jobType) => handler(jobType) };
}

Deno.test("successful collection enqueues exactly the multimodal analysis stage", async () => {
  const queue = queueWith([job("collect-1", "COLLECT_INSTAGRAM")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "completed" } })),
    workerId: "worker-1",
    batchSize: 5,
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual([...queue.enqueued.keys()], ["pipeline-1:ANALYZE_CONTENT"]);
  assert.deepEqual(queue.completed, ["collect-1"]);
});

Deno.test("successful analysis enqueues exactly one intelligence stage", async () => {
  const queue = queueWith([job("analysis-1", "ANALYZE_CONTENT")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "COMPLETED" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual([...queue.enqueued.keys()], ["pipeline-1:RUN_INTELLIGENCE"]);
});

Deno.test("failed analysis does not enqueue intelligence", async () => {
  const queue = queueWith([job("analysis-1", "ANALYZE_CONTENT")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 502, body: { error: "provider detail" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, downstream_enqueued: 0 });
  assert.equal(queue.enqueued.size, 0);
});

Deno.test("one failed job does not block an unrelated successful job", async () => {
  const queue = queueWith([
    job("bad", "SYNC_NOTION"),
    job("good", "FIXTURE_SYNC", { dedupe_key: "fixture-1", payload: {} }),
  ]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async (jobType) => {
      if (jobType === "SYNC_NOTION") throw new Error("secret upstream body");
      return { status: 200, body: { status: "SYNCED" } };
    }),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 2, succeeded: 1, failed: 1, downstream_enqueued: 1 });
  assert.deepEqual(queue.completed, ["good"]);
  assert.deepEqual(queue.failed, [{ id: "bad", category: "WORKER_FAILURE", message: "SYNC_NOTION invocation failed" }]);
  assert.deepEqual([...queue.enqueued.keys()], ["fixture-1:DISPATCH_ALERTS"]);
});

Deno.test("successful fixture sync enqueues one stable alert stage", async () => {
  const queue = queueWith([job("fixture-1", "FIXTURE_SYNC")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "SYNCED" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual([...queue.enqueued.keys()], ["pipeline-1:DISPATCH_ALERTS"]);
  assert.deepEqual(queue.completed, ["fixture-1"]);
});

Deno.test("fixture failure does not enqueue Telegram alerts", async () => {
  const queue = queueWith([job("fixture-1", "FIXTURE_SYNC")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 502, body: { error: "upstream details" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, downstream_enqueued: 0 });
  assert.equal(queue.enqueued.size, 0);
  assert.deepEqual(queue.failed, [{ id: "fixture-1", category: "DOWNSTREAM_HTTP_5XX", message: "FIXTURE_SYNC returned HTTP 502" }]);
});

Deno.test("intelligence already_running is safe but does not start priority generation", async () => {
  const queue = queueWith([job("intelligence-1", "RUN_INTELLIGENCE")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 202, body: { status: "already_running" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 0 });
  assert.equal(queue.enqueued.size, 0);
  assert.deepEqual(queue.completed, ["intelligence-1"]);
});

Deno.test("unaffected editorial stages retain their downstream transitions", async () => {
  const transitions: Array<[EditorialJobType, EditorialJobType]> = [
    ["RUN_INTELLIGENCE", "DISCOVER_SOURCES"],
    ["DISCOVER_SOURCES", "DISCOVER_TRENDS"],
    ["DISCOVER_TRENDS", "PROMOTE_DISCOVERY"],
    ["RANK_EDITORIAL", "GENERATE_PRIORITY"],
  ];
  for (const [index, [stage, expected]] of transitions.entries()) {
    const queue = queueWith([job(`stage-${index}`, stage)]);
    const worker = createOrchestrationWorker({
      queue,
      invoker: invoker(async () => ({ status: 200, body: { status: "COMPLETED" } })),
      workerId: "worker-1",
      now: () => now,
    });
    await worker.processBatch();
    assert.deepEqual([...queue.enqueued.keys()], [`pipeline-1:${expected}`]);
  }
});

Deno.test("promotion enqueues grounding for only its affected story IDs with a canonical payload", async () => {
  const asOf = "2026-09-25T12:00:00.000Z";
  const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY", {
    payload: { chain_key: "pipeline-1", as_of: asOf },
  })]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({
      status: 200,
      body: { status: "COMPLETED", affectedStoryIds: [storyOne, storyTwo], unrelatedStoryId: storyOther },
    })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(queue.enqueueCalls, [{
    jobType: "GROUND_CLAIMS",
    payload: {
      chain_key: "pipeline-1",
      parent_job_id: "promotion-1",
      stage: "GROUND_CLAIMS",
      as_of: asOf,
      story_cluster_ids: [storyOne, storyTwo],
      limit: 25,
      cursor: null,
    },
    dedupeKey: "pipeline-1:GROUND_CLAIMS:initial",
  }]);
  assert.deepEqual(queue.completed, ["promotion-1"]);
});

Deno.test("promotion snapshots grounding after promotion when the root has no as-of", async () => {
  const times = [
    new Date("2026-09-25T12:00:00.000Z"),
    new Date("2026-09-25T12:00:01.000Z"),
    new Date("2026-09-25T12:00:02.000Z"),
  ];
  const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "COMPLETED", affectedStoryIds: [storyOne] } })),
    workerId: "worker-1",
    now: () => times.shift() ?? new Date("2026-09-25T12:00:03.000Z"),
  });

  await worker.processBatch();

  assert.equal(queue.enqueueCalls[0]?.payload.as_of, "2026-09-25T12:00:01.000Z");
});

Deno.test("promotion with empty or missing affected story IDs does not enqueue grounding", async () => {
  for (const body of [
    { status: "COMPLETED", affectedStoryIds: [] },
    { status: "COMPLETED" },
  ]) {
    const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY")]);
    const worker = createOrchestrationWorker({
      queue,
      invoker: invoker(async () => ({ status: 200, body })),
      workerId: "worker-1",
      now: () => now,
    });

    const result = await worker.processBatch();

    assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 0 });
    assert.deepEqual(queue.enqueueCalls, []);
    assert.deepEqual(queue.completed, ["promotion-1"]);
  }
});

Deno.test("promotion retry replays a persisted grounding scope when the response is empty", async () => {
  const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY", {
    payload: {
      chain_key: "pipeline-1",
      grounding_story_cluster_ids: [storyOne],
      grounding_as_of: "2026-09-25T12:00:01.000Z",
      grounding_limit: 25,
    },
  })]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "COMPLETED", affectedStoryIds: [] } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.equal(result.downstream_enqueued, 1);
  assert.deepEqual(queue.enqueueCalls[0]?.payload.story_cluster_ids, [storyOne]);
  assert.equal(queue.enqueueCalls[0]?.payload.as_of, "2026-09-25T12:00:01.000Z");
});

Deno.test("promotion persists grounding scope before an enqueue failure so retry can recover", async () => {
  const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY")], { enqueueFailures: 1 });
  let invocation = 0;
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => {
      invocation += 1;
      return { status: 200, body: { status: "COMPLETED", affectedStoryIds: invocation === 1 ? [storyOne] : [] } };
    }),
    workerId: "worker-1",
    now: () => now,
  });

  const first = await worker.processBatch();
  const second = await worker.processBatch();

  assert.equal(first.failed, 1);
  assert.equal(second.succeeded, 1);
  assert.deepEqual(queue.payloadUpdates[0]?.patch.grounding_story_cluster_ids, [storyOne]);
  assert.equal(queue.enqueued.size, 1);
});

Deno.test("worker rejects malformed grounding promotion metadata before enqueue", async () => {
  const queue = queueWith([job("promotion-1", "PROMOTE_DISCOVERY")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "COMPLETED", affectedStoryIds: ["not-a-uuid"] } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, downstream_enqueued: 0 });
  assert.equal(queue.enqueueCalls.length, 0);
  assert.equal(queue.failed[0]?.category, "GROUNDING_PAYLOAD_INVALID");
});

Deno.test("partial grounding enqueues a scoped continuation with a cursor-specific dedupe key", async () => {
  const asOf = "2026-09-25T12:00:00.000Z";
  const scope = [storyOne, storyTwo];
  const queue = queueWith([job("grounding-1", "GROUND_CLAIMS", {
    payload: { chain_key: "pipeline-1", as_of: asOf, story_cluster_ids: scope, limit: 25, cursor: null },
    dedupe_key: "pipeline-1:GROUND_CLAIMS:initial",
  })]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({
      status: 200,
      body: { status: "PARTIAL", has_more: true, next_cursor: "d:claim-2" },
    })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(queue.enqueueCalls, [{
    jobType: "GROUND_CLAIMS",
    payload: {
      chain_key: "pipeline-1",
      parent_job_id: "grounding-1",
      stage: "GROUND_CLAIMS",
      as_of: asOf,
      story_cluster_ids: scope,
      limit: 25,
      cursor: "d:claim-2",
    },
    dedupeKey: "pipeline-1:GROUND_CLAIMS:d:claim-2",
  }]);
  assert.deepEqual(queue.completed, ["grounding-1"]);
});

Deno.test("completed grounding with no more pages enqueues editorial ranking", async () => {
  const queue = queueWith([job("grounding-2", "GROUND_CLAIMS", {
    payload: {
      chain_key: "pipeline-1",
      as_of: "2026-09-25T12:00:00.000Z",
      story_cluster_ids: [storyOne],
      limit: 25,
      cursor: "d:claim-2",
    },
    dedupe_key: "pipeline-1:GROUND_CLAIMS:d:claim-2",
  })]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({
      status: 200,
      body: { status: "COMPLETED", has_more: false, next_cursor: null },
    })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(queue.enqueueCalls.map(({ jobType, dedupeKey }) => ({ jobType, dedupeKey })), [{
    jobType: "RANK_EDITORIAL",
    dedupeKey: "pipeline-1:RANK_EDITORIAL",
  }]);
  assert.deepEqual(queue.completed, ["grounding-2"]);
});

Deno.test("Notion failure is isolated and does not enqueue selected polling", async () => {
  const queue = queueWith([job("notion-1", "SYNC_NOTION")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 503, body: { access_token: "secret" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 0, failed: 1, downstream_enqueued: 0 });
  assert.equal(queue.enqueued.size, 0);
  assert.deepEqual(queue.failed, [{ id: "notion-1", category: "DOWNSTREAM_HTTP_5XX", message: "SYNC_NOTION returned HTTP 503" }]);
});

Deno.test("repeated stage processing uses one stable downstream dedupe key", async () => {
  const queue = queueWith([job("collect-1", "COLLECT_INSTAGRAM")], { repeatClaims: true });
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200 })),
    workerId: "worker-1",
    now: () => now,
  });

  await worker.processBatch();
  await worker.processBatch();

  assert.equal(queue.enqueued.size, 1);
  assert.equal(queue.enqueued.get("pipeline-1:ANALYZE_CONTENT"), "downstream-1");
});

Deno.test("repeated fixture processing uses one stable alert dedupe key", async () => {
  const queue = queueWith([job("fixture-1", "FIXTURE_SYNC")], { repeatClaims: true });
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200 })),
    workerId: "worker-1",
    now: () => now,
  });

  await worker.processBatch();
  await worker.processBatch();

  assert.equal(queue.enqueued.size, 1);
  assert.equal(queue.enqueued.get("pipeline-1:DISPATCH_ALERTS"), "downstream-1");
});

Deno.test("morning brief remains a terminal worker stage", async () => {
  const queue = queueWith([job("brief-1", "MORNING_BRIEF")]);
  const worker = createOrchestrationWorker({
    queue,
    invoker: invoker(async () => ({ status: 200, body: { status: "ALREADY_SENT" } })),
    workerId: "worker-1",
    now: () => now,
  });

  const result = await worker.processBatch();

  assert.deepEqual(result, { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 0 });
  assert.equal(queue.enqueued.size, 0);
  assert.deepEqual(queue.completed, ["brief-1"]);
});

Deno.test("hourly editorial digest invokes the bounded Telegram digest boundary and is terminal", async () => {
  const queue = queueWith([job("digest-1", "EDITORIAL_DIGEST", { payload: { window_start: "2026-10-02T04:00:00Z", window_end: "2026-10-02T05:00:00Z" } })]);
  const calls: Array<{ type: EditorialJobType; payload: Record<string, unknown> }> = [];
  const worker = createOrchestrationWorker({
    queue,
    invoker: { invoke: async (type, payload) => { calls.push({ type, payload }); return { status: 200, body: { status: "EMPTY" } }; } },
    workerId: "worker-1",
    now: () => now,
  });
  const result = await worker.processBatch();
  assert.equal(result.succeeded, 1);
  assert.equal(result.downstream_enqueued, 0);
  assert.deepEqual(calls, [{ type: "EDITORIAL_DIGEST", payload: { window_start: "2026-10-02T04:00:00Z", window_end: "2026-10-02T05:00:00Z" } }]);
});

Deno.test("promotion invocation carries its durable queue job ID for retry recovery", async () => {
  const promotionJobId = "99999999-9999-4999-8999-999999999999";
  const queue = queueWith([job(promotionJobId, "PROMOTE_DISCOVERY")]);
  const invocationPayloads: Record<string, unknown>[] = [];
  const worker = createOrchestrationWorker({
    queue,
    invoker: { invoke: async (_jobType, payload) => { invocationPayloads.push(payload); return { status: 200, body: { status: "COMPLETED", affected_story_ids: [] } }; } },
    workerId: "worker-1",
    now: () => now,
  });

  await worker.processBatch();

  assert.equal(invocationPayloads[0]?.promotion_job_id, promotionJobId);
});
