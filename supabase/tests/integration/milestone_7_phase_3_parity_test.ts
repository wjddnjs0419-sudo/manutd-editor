import assert from "node:assert/strict";

import { createEditorialJobQueue } from "../../functions/orchestration-worker/queue_client.ts";
import { createOrchestrationWorker } from "../../functions/orchestration-worker/worker.ts";
import type { BoundaryInvoker } from "../../functions/orchestration-worker/types.ts";
import { createTelegramAgentHandler } from "../../functions/telegram-agent/handler.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? "";
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");

const base = supabaseUrl.replace(/\/$/u, "");
const queue = createEditorialJobQueue({ supabaseUrl, serviceKey });

async function rpc(name: string, body: Record<string, unknown> = {}): Promise<unknown> {
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
  const response = await fetch(
    `${base}/rest/v1/editorial_jobs?select=job_type,status,attempt_count,last_error_category,dedupe_key&dedupe_key=eq.${encodeURIComponent(dedupeKey)}`,
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

async function restJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  assert.equal(response.ok, true, `${init.method ?? "GET"} ${path} failed with ${response.status}`);
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function insertReadyBrief(at: Date): Promise<string> {
  const clusterId = crypto.randomUUID();
  const candidateId = crypto.randomUUID();
  const briefId = crypto.randomUUID();
  const configs = await restJson("/rest/v1/scoring_configs?select=id&is_active=eq.true&limit=1") as Array<{ id: string }>;
  const scoringConfigId = configs[0]?.id;
  assert.ok(scoringConfigId, "seeded scoring config is required for the READY trigger fixture");

  await restJson("/rest/v1/story_clusters", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      id: clusterId,
      canonical_title: "M7 Phase 3 parity READY fixture",
      first_seen_at: at.toISOString(),
      last_seen_at: at.toISOString(),
    }),
  });
  await restJson("/rest/v1/content_candidates", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      id: candidateId,
      story_cluster_id: clusterId,
      scoring_config_id: scoringConfigId,
      global_spread_score: 1,
      engagement_outperformance_score: 1,
      engagement_velocity_score: 1,
      velocity_acceleration_score: 1,
      korea_gap_score: 1,
      first_mover_score: 1,
      korean_saturation_score: 1,
      reliability_score: 1,
      source_diversity_score: 1,
      freshness_score: 1,
      data_confidence: 100,
      rank: 1,
      ranking_date: "2026-09-27",
      score_inputs: {},
    }),
  });
  await restJson("/rest/v1/creative_briefs", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      id: briefId,
      candidate_id: candidateId,
      version: 1,
      headline: "M7 parity headline",
      angle: "M7 parity angle",
      format: "CAROUSEL",
      slide_count: 1,
      slides_json: { "1": { text: "M7 parity" } },
      design_json: {},
      caption_draft: "M7 parity caption",
      cta: "Read more",
      status: "READY",
      updated_at: at.toISOString(),
      created_at: at.toISOString(),
    }),
  });
  return briefId;
}

async function drainPreviousPendingJobs(): Promise<void> {
  const worker = createOrchestrationWorker({
    queue,
    invoker: { invoke: async () => ({ status: 200, body: { status: "DRAINED" } }) },
    workerId: "m7-phase-3-parity-cleanup",
    batchSize: 20,
    now: () => new Date("2026-09-27T02:00:00Z"),
  });
  for (let index = 0; index < 20; index += 1) {
    const result = await worker.processBatch();
    if (result.claimed === 0) return;
  }
  throw new Error("PARITY_CLEANUP_DID_NOT_DRAIN");
}

function telegramUpdate(updateId: number) {
  return {
    update_id: updateId,
    message: { from: { id: 42 }, chat: { id: 42 }, text: "/status" },
  };
}

Deno.test("M7 full parity operates without n8n and isolates Notion failures", async () => {
  await drainPreviousPendingJobs();

  const chainKey = "m7-phase-3-full-parity";
  const at = new Date("2026-09-27T02:00:00Z");
  const readyBriefId = await insertReadyBrief(at);
  const projectDedupeKey = `creative-brief:${readyBriefId}:PROJECT_NOTION`;

  await queue.enqueue("COLLECT_INSTAGRAM", { chain_key: chainKey }, `${chainKey}:COLLECT_INSTAGRAM`, 3, at);
  await queue.enqueue("FIXTURE_SYNC", { chain_key: `${chainKey}:fixture` }, `${chainKey}:FIXTURE_SYNC`, 3, at);
  await queue.enqueue("MORNING_BRIEF", { chain_key: `${chainKey}:brief` }, `${chainKey}:MORNING_BRIEF`, 3, at);
  const projectId = await queue.enqueue(
    "PROJECT_NOTION",
    { chain_key: chainKey, creative_brief_id: readyBriefId },
    projectDedupeKey,
    3,
    at,
  );
  assert.equal(
    await queue.enqueue(
      "PROJECT_NOTION",
      { chain_key: chainKey, creative_brief_id: readyBriefId },
      projectDedupeKey,
      3,
      at,
    ),
    projectId,
  );

  const calls: string[] = [];
  const attempts = new Map<string, number>();
  let current = at;
  const invoker: BoundaryInvoker = {
    invoke: async (jobType) => {
      calls.push(jobType);
      const attempt = (attempts.get(jobType) ?? 0) + 1;
      attempts.set(jobType, attempt);
      if ((jobType === "PROJECT_NOTION" || jobType === "SYNC_NOTION") && attempt === 1) {
        return { status: 503, body: { status: "NOTION_UNAVAILABLE" } };
      }
      return { status: 200, body: { status: jobType === "GENERATE_PRIORITY" ? "READY" : "SUCCEEDED" } };
    },
  };
  const worker = createOrchestrationWorker({
    queue,
    invoker,
    workerId: "m7-phase-3-parity-worker",
    batchSize: 20,
    now: () => current,
  });

  for (let index = 0; index < 20; index += 1) {
    const result = await worker.processBatch();
    if (result.claimed === 0) current = new Date(current.getTime() + 6 * 60 * 1000);
    const terminalKeys = [
      `${chainKey}:COLLECT_INSTAGRAM`,
      `${chainKey}:RUN_INTELLIGENCE`,
      `${chainKey}:GENERATE_PRIORITY`,
      `${chainKey}:SYNC_NOTION`,
      projectDedupeKey,
      `${chainKey}:POLL_SELECTED`,
      `${chainKey}:DISPATCH_ALERTS`,
      `${chainKey}:FIXTURE_SYNC`,
      `${chainKey}:fixture:DISPATCH_ALERTS`,
      `${chainKey}:MORNING_BRIEF`,
    ];
    const rows = await Promise.all(terminalKeys.map(async (key) => (await rowsFor(key))[0]));
    if (rows.every((row) => row?.status === "SUCCEEDED")) break;
  }

  for (const key of [
    `${chainKey}:COLLECT_INSTAGRAM`,
    `${chainKey}:RUN_INTELLIGENCE`,
    `${chainKey}:GENERATE_PRIORITY`,
    `${chainKey}:SYNC_NOTION`,
    projectDedupeKey,
    `${chainKey}:POLL_SELECTED`,
    `${chainKey}:DISPATCH_ALERTS`,
    `${chainKey}:FIXTURE_SYNC`,
    `${chainKey}:fixture:DISPATCH_ALERTS`,
    `${chainKey}:MORNING_BRIEF`,
  ]) {
    assert.equal((await rowsFor(key))[0]?.status, "SUCCEEDED", key);
  }
  assert.equal(attempts.get("PROJECT_NOTION"), 2, "Notion projection recovers independently");
  assert.equal(attempts.get("SYNC_NOTION"), 2, "Notion intelligence sync retries and recovers");
  assert.ok(calls.includes("RUN_INTELLIGENCE"), "intelligence boundary was invoked");
  assert.ok(calls.includes("GENERATE_PRIORITY"), "priority creative generation boundary was invoked");
  assert.ok(calls.includes("FIXTURE_SYNC"), "fixture sync boundary was invoked");
  assert.ok(calls.includes("MORNING_BRIEF"), "morning briefing boundary was invoked");

  const statusValue = await rpc("get_editorial_job_status");
  const status = Array.isArray(statusValue) ? statusValue[0] as Record<string, unknown> : statusValue as Record<string, unknown>;
  assert.ok(Number(status.last_successful_instagram_pipeline) > 0 || status.last_successful_instagram_pipeline, "Instagram success is observable");
  assert.ok(status.last_successful_intelligence_run, "intelligence success is observable");
  assert.ok(status.last_morning_brief, "morning brief success is observable");

  let runCount = 0;
  let claimCount = 0;
  const handler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    claimUpdate: async () => {
      claimCount += 1;
      return claimCount === 1;
    },
    run: async () => {
      runCount += 1;
      return { status: "OK", reply: "direct" };
    },
  });
  const request = () => new Request("https://example.test", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
    body: JSON.stringify(telegramUpdate(9701)),
  });
  assert.equal((await handler(request())).status, 200);
  assert.equal((await handler(request())).status, 200);
  assert.equal(runCount, 1, "Telegram direct webhook is deduplicated");
  assert.equal(claimCount, 2, "Telegram retry path re-checks the update claim");
});
