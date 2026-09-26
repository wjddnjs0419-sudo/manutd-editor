import assert from "node:assert/strict";

import { createEditorialJobQueue } from "../../functions/orchestration-worker/queue_client.ts";
import { createOrchestrationWorker } from "../../functions/orchestration-worker/worker.ts";
import type { BoundaryInvoker } from "../../functions/orchestration-worker/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const queue = createEditorialJobQueue({ supabaseUrl, serviceKey });

async function rowsFor(dedupeKey: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(
    `${supabaseUrl.replace(/\/$/u, "")}/rest/v1/editorial_jobs?select=job_type,status,dedupe_key&dedupe_key=eq.${encodeURIComponent(dedupeKey)}`,
    {
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "accept-profile": "app_private",
      },
    },
  );
  assert.equal(response.status, 200);
  const value = await response.json();
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

Deno.test("local smoke claims collection, completes it, and enqueues intelligence once", async () => {
  const chainKey = "m7-phase-1-smoke";
  const rootDedupeKey = `${chainKey}:COLLECT_INSTAGRAM`;
  const intelligenceDedupeKey = `${chainKey}:RUN_INTELLIGENCE`;
  await queue.enqueue("COLLECT_INSTAGRAM", { chain_key: chainKey, smoke_fixture: true }, rootDedupeKey, 3, new Date("2026-09-26T00:00:00Z"));

  const calls: string[] = [];
  const invoker: BoundaryInvoker = {
    invoke: async (jobType) => {
      calls.push(jobType);
      return { status: 200, body: { status: "completed" } };
    },
  };
  const worker = createOrchestrationWorker({
    queue,
    invoker,
    workerId: "m7-smoke-worker",
    batchSize: 5,
    leaseSeconds: 300,
    now: () => new Date("2026-09-26T00:00:00Z"),
  });

  assert.deepEqual(await worker.processBatch(), { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(calls, ["COLLECT_INSTAGRAM"]);
  assert.deepEqual(await rowsFor(rootDedupeKey), [{ job_type: "COLLECT_INSTAGRAM", status: "SUCCEEDED", dedupe_key: rootDedupeKey }]);
  assert.deepEqual(await rowsFor(intelligenceDedupeKey), [{ job_type: "RUN_INTELLIGENCE", status: "PENDING", dedupe_key: intelligenceDedupeKey }]);
  assert.equal((await rowsFor(intelligenceDedupeKey)).length, 1);

  const [downstream] = await queue.claim("m7-smoke-drain", 1, new Date("2026-09-26T00:00:00Z"), 300);
  assert.equal(downstream?.dedupe_key, intelligenceDedupeKey);
  assert.equal(await queue.complete(downstream!.id, "m7-smoke-drain", new Date("2026-09-26T00:01:00Z")), true);
});

Deno.test("two simultaneous local claims return a job to only one worker", async () => {
  const dedupeKey = "m7-phase-1-concurrent-claim";
  const jobId = await queue.enqueue("FIXTURE_SYNC", { chain_key: dedupeKey }, dedupeKey, 3, new Date("2026-09-26T00:00:00Z"));
  const [first, second] = await Promise.all([
    queue.claim("concurrent-worker-a", 1, new Date("2026-09-26T00:00:00Z"), 300),
    queue.claim("concurrent-worker-b", 1, new Date("2026-09-26T00:00:00Z"), 300),
  ]);
  const claimed = [...first, ...second];
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0]?.id, jobId);
  assert.equal(await queue.complete(jobId, claimed[0]?.locked_by ?? "", new Date("2026-09-26T00:01:00Z")), true);
});
