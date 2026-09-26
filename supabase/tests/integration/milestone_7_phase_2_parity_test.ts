import assert from "node:assert/strict";

import { createEditorialJobQueue } from "../../functions/orchestration-worker/queue_client.ts";
import { createOrchestrationWorker } from "../../functions/orchestration-worker/worker.ts";
import { createTelegramAgentHandler } from "../../functions/telegram-agent/handler.ts";
import type { BoundaryInvoker } from "../../functions/orchestration-worker/types.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const base = supabaseUrl.replace(/\/$/u, "");
const queue = createEditorialJobQueue({ supabaseUrl, serviceKey });

async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  return await response.json();
}

async function rowsFor(dedupeKey: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}/rest/v1/editorial_jobs?select=job_type,status,dedupe_key&dedupe_key=eq.${encodeURIComponent(dedupeKey)}`, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "accept-profile": "app_private",
    },
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

function telegramUpdate(updateId: number, fromId = 42, chatId = 42) {
  return { update_id: updateId, message: { from: { id: fromId }, chat: { id: chatId }, text: "/today" } };
}

// Parity mapping: n8n 30-minute pipeline -> scheduled COLLECT_INSTAGRAM root + orchestration worker chain.
// Parity mapping: n8n fixture scheduler -> scheduled FIXTURE_SYNC root + worker alert edge.
// Parity mapping: n8n 09:00 brief -> scheduled MORNING_BRIEF root + existing morning-brief business owner.
// Parity mapping: n8n Telegram Trigger -> direct Telegram webhook with a secret header.
Deno.test("M7 Phase 2 parity runs the Supabase path without n8n", async () => {
  const instagramAt = "2026-09-26T14:30:00Z";
  const instagramId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "COLLECT_INSTAGRAM", p_scheduled_at: instagramAt });
  const instagramDuplicateId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "COLLECT_INSTAGRAM", p_scheduled_at: "2026-09-26T14:30:01Z" });
  assert.equal(instagramDuplicateId, instagramId);
  assert.deepEqual(await rowsFor("instagram-pipeline:202609262330"), [{ job_type: "COLLECT_INSTAGRAM", status: "PENDING", dedupe_key: "instagram-pipeline:202609262330" }]);

  const fixtureId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "FIXTURE_SYNC", p_scheduled_at: "2026-09-26T14:45:00Z" });
  const fixtureDuplicateId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "FIXTURE_SYNC", p_scheduled_at: "2026-09-26T14:45:01Z" });
  assert.equal(fixtureDuplicateId, fixtureId);
  assert.deepEqual(await rowsFor("fixture-pipeline:202609262345"), [{ job_type: "FIXTURE_SYNC", status: "PENDING", dedupe_key: "fixture-pipeline:202609262345" }]);

  const morningId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "MORNING_BRIEF", p_scheduled_at: "2026-09-26T15:00:00Z" });
  const morningDuplicateId = await rpc("enqueue_scheduled_editorial_job", { p_job_type: "MORNING_BRIEF", p_scheduled_at: "2026-09-26T15:00:01Z" });
  assert.equal(morningDuplicateId, morningId);
  assert.deepEqual(await rowsFor("morning-brief:2026-09-27"), [{ job_type: "MORNING_BRIEF", status: "PENDING", dedupe_key: "morning-brief:2026-09-27" }]);

  const drain = await queue.claim("m7-phase-2-schedule-drain", 20, new Date("2026-09-27T00:00:00Z"), 300);
  for (const job of drain) assert.equal(await queue.complete(job.id, "m7-phase-2-schedule-drain", new Date("2026-09-27T00:01:00Z")), true);

  const fixtureRoot = "m7-phase-2-fixture-worker";
  const morningRoot = "m7-phase-2-morning-worker";
  await queue.enqueue("FIXTURE_SYNC", { chain_key: fixtureRoot }, `${fixtureRoot}:FIXTURE_SYNC`, 3, new Date("2026-09-27T00:02:00Z"));
  await queue.enqueue("MORNING_BRIEF", { chain_key: morningRoot }, `${morningRoot}:MORNING_BRIEF`, 3, new Date("2026-09-27T00:02:00Z"));
  const calls: string[] = [];
  const invoker: BoundaryInvoker = {
    invoke: async (jobType) => {
      calls.push(jobType);
      return { status: 200, body: jobType === "FIXTURE_SYNC" ? { status: "SYNCED" } : { status: "ALREADY_SENT" } };
    },
  };
  const worker = createOrchestrationWorker({
    queue,
    invoker,
    workerId: "m7-phase-2-parity-worker",
    batchSize: 2,
    now: () => new Date("2026-09-27T00:02:00Z"),
  });
  assert.deepEqual(await worker.processBatch(), { claimed: 2, succeeded: 2, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(calls.sort(), ["FIXTURE_SYNC", "MORNING_BRIEF"]);
  assert.deepEqual(await rowsFor(`${fixtureRoot}:DISPATCH_ALERTS`), [{ job_type: "DISPATCH_ALERTS", status: "PENDING", dedupe_key: `${fixtureRoot}:DISPATCH_ALERTS` }]);
  assert.deepEqual(await rowsFor(`${morningRoot}:MORNING_BRIEF`), [{ job_type: "MORNING_BRIEF", status: "SUCCEEDED", dedupe_key: `${morningRoot}:MORNING_BRIEF` }]);

  let runCount = 0;
  let claimCount = 0;
  const directHandler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    claimUpdate: async () => {
      claimCount += 1;
      return claimCount === 1;
    },
    run: async () => {
      runCount += 1;
      return { status: "OK", reply: "ok" };
    },
  });
  const directRequest = () => new Request("https://example.test", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
    body: JSON.stringify(telegramUpdate(700)),
  });
  assert.equal((await directHandler(directRequest())).status, 200);
  assert.equal((await directHandler(directRequest())).status, 200);
  assert.equal(runCount, 1);
  assert.equal(claimCount, 2);
  assert.equal((await directHandler(new Request("https://example.test", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: JSON.stringify(telegramUpdate(701)) }))).status, 401);
  assert.equal((await directHandler(new Request("https://example.test", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "webhook-secret" }, body: JSON.stringify({ update_id: 702 }) }))).status, 400);
  assert.equal((await directHandler(new Request("https://example.test", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "webhook-secret" }, body: JSON.stringify(telegramUpdate(703, 7)) }))).status, 403);

  let compatibilityReceived: unknown;
  const compatibilityHandler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    run: async (update) => {
      compatibilityReceived = update;
      return { status: "OK" };
    },
  });
  const compatibilityUpdate = telegramUpdate(704);
  assert.equal((await compatibilityHandler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer internal-secret" },
    body: JSON.stringify([compatibilityUpdate]),
  }))).status, 200);
  assert.deepEqual(compatibilityReceived, compatibilityUpdate);
});
