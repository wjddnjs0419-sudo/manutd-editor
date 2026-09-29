import assert from "node:assert/strict";
import { enqueueManualDiscovery } from "../../telegram-agent/manual_discovery.ts";
import type { EditorialJobQueue } from "../../orchestration-worker/types.ts";

Deno.test("manual discovery enqueues a bounded trend job with a per-request dedupe key", async () => {
  const calls: Array<
    {
      jobType: string;
      payload: Record<string, unknown>;
      dedupeKey: string;
      maxAttempts: number;
      availableAt: Date;
    }
  > = [];
  const queue = {
    enqueue: async (
      jobType: string,
      payload: Record<string, unknown>,
      dedupeKey: string,
      maxAttempts: number,
      availableAt: Date,
    ) => {
      calls.push({ jobType, payload, dedupeKey, maxAttempts, availableAt });
      return "job-1";
    },
  } as unknown as EditorialJobQueue;
  const availableAt = new Date("2026-09-29T13:05:00.000Z");

  assert.deepEqual(
    await enqueueManualDiscovery(queue, "thread-1", "update-42", availableAt, {
      mode: "GENERAL",
      search_profile: "MANUAL",
      max_queries: 8,
    }),
    { status: "QUEUED", run_id: "job-1" },
  );
  assert.deepEqual(calls, [{
    jobType: "DISCOVER_TRENDS",
    payload: {
      chain_key: "telegram-discovery:thread-1:update-42",
      mode: "GENERAL",
      search_profile: "MANUAL",
      max_queries: 8,
      trigger: "TELEGRAM_MANUAL",
      thread_id: "thread-1",
    },
    dedupeKey: "telegram-discovery:thread-1:update-42",
    maxAttempts: 3,
    availableAt,
  }]);
});
