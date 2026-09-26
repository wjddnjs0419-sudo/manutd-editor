import assert from "node:assert/strict";

import { createBoundaryInvoker } from "../../orchestration-worker/boundary_client.ts";
import { createEditorialJobQueue } from "../../orchestration-worker/queue_client.ts";
import type { EditorialJobType } from "../../orchestration-worker/types.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("queue client calls service-role RPCs with exact arguments", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init: init ?? {} });
    const url = String(input);
    if (url.endsWith("/rpc/claim_editorial_jobs")) return response([]);
    if (url.endsWith("/rpc/complete_editorial_job")) return response(true);
    if (url.endsWith("/rpc/fail_editorial_job")) return response([{ id: "job-1", status: "PENDING" }]);
    return response("job-1");
  };
  const queue = createEditorialJobQueue({
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-role-secret",
    request,
  });

  await queue.enqueue("COLLECT_INSTAGRAM", { chain_key: "pipeline-1" }, "pipeline-1:COLLECT_INSTAGRAM", 3, new Date("2026-09-26T00:00:00Z"));
  await queue.claim("worker-1", 5, new Date("2026-09-26T00:00:00Z"), 300);
  await queue.complete("job-1", "worker-1", new Date("2026-09-26T00:01:00Z"));
  await queue.fail("job-1", "worker-1", "DOWNSTREAM_HTTP_5XX", "safe failure", new Date("2026-09-26T00:02:00Z"));

  assert.equal(requests.length, 4);
  assert.equal(requests[0]?.init.headers instanceof Headers ? requests[0].init.headers.get("apikey") : (requests[0]?.init.headers as Record<string, string>)["apikey"], "service-role-secret");
  assert.match(String(requests[0]?.init.body), /pipeline-1:COLLECT_INSTAGRAM/);
  assert.match(String(requests[1]?.init.body), /p_worker_id/);
  assert.match(String(requests[2]?.init.body), /p_finished_at/);
  assert.match(String(requests[3]?.init.body), /p_error_category/);
  assert.doesNotMatch(JSON.stringify(requests), /Bearer service-role-secret/);
});

Deno.test("boundary client maps all job types to existing endpoints and secrets", async () => {
  const calls: Array<{ url: string; authorization: string; body: unknown }> = [];
  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") ?? "", body: init?.body ? JSON.parse(String(init.body)) : null });
    return response({ status: "completed" });
  };
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request,
  });
  const types: EditorialJobType[] = [
    "COLLECT_INSTAGRAM", "RUN_INTELLIGENCE", "GENERATE_PRIORITY", "SYNC_NOTION", "PROJECT_NOTION",
    "POLL_SELECTED", "DISPATCH_ALERTS", "FIXTURE_SYNC", "MORNING_BRIEF",
  ];
  for (const jobType of types) {
    await invoker.invoke(
      jobType,
      jobType === "RUN_INTELLIGENCE"
        ? { as_of: "2026-09-26T00:00:00Z" }
        : jobType === "FIXTURE_SYNC"
        ? { mode: "FORCE" }
        : jobType === "PROJECT_NOTION"
        ? { creative_brief_id: "brief-1" }
        : {},
    );
  }

  assert.deepEqual(calls.map((call) => call.url), [
    "https://supabase.test/functions/v1/collect-instagram",
    "https://supabase.test/functions/v1/intelligence",
    "https://supabase.test/functions/v1/creative-generation-priority",
    "https://supabase.test/functions/v1/sync-notion-intelligence",
    "https://supabase.test/functions/v1/project-notion",
    "https://supabase.test/functions/v1/creative-generation-selected-poll",
    "https://supabase.test/functions/v1/telegram-alerts",
    "https://supabase.test/functions/v1/fixture-sync",
    "https://supabase.test/functions/v1/telegram-morning-brief",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret",
    "Bearer telegram-secret", "Bearer telegram-secret", "Bearer telegram-secret",
  ]);
  assert.deepEqual(calls[1]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.deepEqual(calls[4]?.body, { creative_brief_id: "brief-1" });
  assert.deepEqual(calls[7]?.body, { mode: "FORCE" });
  assert.equal(JSON.stringify(calls).includes("service-role"), false);
});

Deno.test("boundary client returns status-only failures without retaining upstream bodies", async () => {
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async () => response({ access_token: "secret-token", raw: "complete body" }, 502),
  });

  assert.deepEqual(await invoker.invoke("SYNC_NOTION", {}), { status: 502 });
});
