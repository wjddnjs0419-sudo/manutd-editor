import assert from "node:assert/strict";

import { createOrchestrationWorker } from "../../orchestration-worker/worker.ts";
import type {
  BoundaryInvoker,
  EditorialJob,
  EditorialJobQueue,
  EditorialJobType,
} from "../../orchestration-worker/types.ts";

const now = new Date("2026-09-26T00:00:00.000Z");

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
  options: { repeatClaims?: boolean } = {},
): EditorialJobQueue & {
  readonly completed: string[];
  readonly failed: Array<{ id: string; category: string; message: string }>;
  readonly enqueued: Map<string, string>;
} {
  const jobs = [...initialJobs];
  const completed: string[] = [];
  const failed: Array<{ id: string; category: string; message: string }> = [];
  const enqueued = new Map<string, string>();
  let enqueueSequence = 0;
  return {
    completed,
    failed,
    enqueued,
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
    async enqueue(_jobType, _payload, dedupeKey) {
      const existing = enqueued.get(dedupeKey);
      if (existing) return existing;
      const id = `downstream-${++enqueueSequence}`;
      enqueued.set(dedupeKey, id);
      return id;
    },
  };
}

function invoker(
  handler: (jobType: EditorialJobType) => Promise<{ status: number; body?: unknown }>,
): BoundaryInvoker {
  return { invoke: async (jobType) => handler(jobType) };
}

Deno.test("successful collection enqueues exactly the intelligence stage", async () => {
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
  assert.deepEqual([...queue.enqueued.keys()], ["pipeline-1:RUN_INTELLIGENCE"]);
  assert.deepEqual(queue.completed, ["collect-1"]);
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
  assert.equal(queue.enqueued.get("pipeline-1:RUN_INTELLIGENCE"), "downstream-1");
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
