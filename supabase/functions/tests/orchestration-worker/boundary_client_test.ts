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
    "COLLECT_INSTAGRAM", "ANALYZE_CONTENT", "RUN_INTELLIGENCE", "DISCOVER_SOURCES", "DISCOVER_TRENDS", "PROMOTE_DISCOVERY", "GROUND_CLAIMS", "RANK_EDITORIAL", "GENERATE_PRIORITY", "SYNC_NOTION", "PROJECT_NOTION",
    "POLL_SELECTED", "DISPATCH_ALERTS", "FIXTURE_SYNC", "MORNING_BRIEF", "EDITORIAL_DIGEST",
  ];
  for (const jobType of types) {
    await invoker.invoke(
      jobType,
      jobType === "PROMOTE_DISCOVERY"
        ? { as_of: "2026-09-26T00:00:00Z", promotion_job_id: "99999999-9999-4999-8999-999999999999" }
        : jobType === "RUN_INTELLIGENCE" || jobType === "ANALYZE_CONTENT" || jobType === "DISCOVER_SOURCES" || jobType === "DISCOVER_TRENDS" || jobType === "GROUND_CLAIMS" || jobType === "RANK_EDITORIAL"
        ? { as_of: "2026-09-26T00:00:00Z" }
        : jobType === "FIXTURE_SYNC"
        ? { mode: "FORCE" }
        : jobType === "PROJECT_NOTION"
        ? { creative_brief_id: "brief-1" }
        : jobType === "EDITORIAL_DIGEST"
        ? { window_start: "2026-10-02T04:00:00Z", window_end: "2026-10-02T05:00:00Z" }
        : {},
    );
  }

  assert.deepEqual(calls.map((call) => call.url), [
    "https://supabase.test/functions/v1/collect-instagram",
    "https://supabase.test/functions/v1/analyze-content",
    "https://supabase.test/functions/v1/intelligence",
    "https://supabase.test/functions/v1/source-discovery",
    "https://supabase.test/functions/v1/trend-discovery",
    "https://supabase.test/functions/v1/promote-discovery",
    "https://supabase.test/functions/v1/ground-claims",
    "https://supabase.test/functions/v1/rank-editorial",
    "https://supabase.test/functions/v1/creative-generation-priority",
    "https://supabase.test/functions/v1/sync-notion-intelligence",
    "https://supabase.test/functions/v1/project-notion",
    "https://supabase.test/functions/v1/creative-generation-selected-poll",
    "https://supabase.test/functions/v1/telegram-alerts",
    "https://supabase.test/functions/v1/fixture-sync",
    "https://supabase.test/functions/v1/telegram-morning-brief",
    "https://supabase.test/functions/v1/telegram-alerts",
  ]);
  assert.deepEqual(calls.map((call) => call.authorization), [
    "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret", "Bearer collector-secret",
    "Bearer telegram-secret", "Bearer telegram-secret", "Bearer telegram-secret", "Bearer telegram-secret",
  ]);
  assert.deepEqual(calls[1]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.equal(calls[0]?.body, null);
  assert.deepEqual(calls[2]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.deepEqual(calls[3]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.deepEqual(calls[4]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.deepEqual(calls[5]?.body, { as_of: "2026-09-26T00:00:00Z", promotion_job_id: "99999999-9999-4999-8999-999999999999" });
  assert.deepEqual(calls[6]?.body, { as_of: "2026-09-26T00:00:00Z" });
  assert.deepEqual(calls[10]?.body, { creative_brief_id: "brief-1" });
  assert.deepEqual(calls[13]?.body, { mode: "FORCE" });
  assert.deepEqual(calls[15]?.body, { mode: "HOURLY_DIGEST", window_start: "2026-10-02T04:00:00Z", window_end: "2026-10-02T05:00:00Z", timezone: "Asia/Seoul" });
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

Deno.test("boundary client preserves empty-body contracts for unscoped collection and analysis", async () => {
  const bodies: Array<unknown> = [];
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async (_input, init) => {
      const body = (init as globalThis.RequestInit | undefined)?.body;
      bodies.push(body ? JSON.parse(String(body)) : null);
      return response({ status: "completed" });
    },
  });
  await invoker.invoke("COLLECT_INSTAGRAM", {});
  await invoker.invoke("ANALYZE_CONTENT", {});
  await invoker.invoke("RUN_INTELLIGENCE", {});
  await invoker.invoke("DISCOVER_TRENDS", {});
  await invoker.invoke("SYNC_NOTION", {});
  assert.deepEqual(bodies, [null, null, null, null, null]);
});

Deno.test("boundary client preserves a successful parsed JSON response body", async () => {
  const body = { status: "COMPLETED", affectedStoryIds: ["story-1", "story-2"] };
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async () => response(body),
  });

  assert.deepEqual(await invoker.invoke("PROMOTE_DISCOVERY", {}), { status: 200, body });
});

Deno.test("boundary client rejects malformed grounding payload values", async () => {
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async () => response({ status: "COMPLETED" }),
  });

  await assert.rejects(() => invoker.invoke("GROUND_CLAIMS", {
    story_cluster_ids: ["not-a-uuid"],
    limit: 101,
    cursor: "not-a-cursor",
  }));
});

Deno.test("boundary client handles a successful response with an empty body", async () => {
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async () => new Response(null, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(await invoker.invoke("PROMOTE_DISCOVERY", {}), { status: 200 });
});

Deno.test("boundary client ignores invalid JSON in a successful response", async () => {
  const invoker = createBoundaryInvoker({
    functionsUrl: "https://supabase.test/functions/v1",
    collectorSecret: "collector-secret",
    telegramSecret: "telegram-secret",
    request: async () => new Response("{invalid", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.deepEqual(await invoker.invoke("PROMOTE_DISCOVERY", {}), { status: 200 });
});
