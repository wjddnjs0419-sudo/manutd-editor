import assert from "node:assert/strict";

import { createOrchestrationHandler } from "../../orchestration-worker/handler.ts";
import type { OrchestrationBatchSummary } from "../../orchestration-worker/types.ts";

const summary: OrchestrationBatchSummary = {
  claimed: 2,
  succeeded: 1,
  failed: 1,
  downstream_enqueued: 1,
};

function request(authorization = "Bearer worker-secret", body?: string, method = "POST"): Request {
  return new Request("https://example.test", {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
}

Deno.test("handler authenticates and returns only a safe batch summary", async () => {
  let receivedLimit = 0;
  const handler = createOrchestrationHandler({
    workerSecret: "worker-secret",
    run: async (limit) => {
      receivedLimit = limit;
      return summary;
    },
    requestId: () => "request-1",
    log: () => undefined,
  });

  const response = await handler(request(undefined, JSON.stringify({ limit: 3 })));

  assert.equal(response.status, 200);
  assert.equal(receivedLimit, 3);
  assert.deepEqual(await response.json(), { request_id: "request-1", ...summary });
});

Deno.test("handler rejects methods, credentials, and invalid limits without running", async () => {
  let runs = 0;
  const handler = createOrchestrationHandler({
    workerSecret: "worker-secret",
    run: async () => {
      runs += 1;
      return summary;
    },
    log: () => undefined,
  });

  assert.equal((await handler(request("Bearer worker-secret", undefined, "GET"))).status, 405);
  assert.equal((await handler(request("Bearer wrong"))).status, 401);
  assert.equal((await handler(request("Bearer worker-secret", JSON.stringify({ limit: 0 })))).status, 400);
  assert.equal((await handler(request("Bearer worker-secret", JSON.stringify({ limit: 21 })))).status, 400);
  assert.equal(runs, 0);
});

Deno.test("handler accepts an empty POST and never logs the worker secret", async () => {
  const logs: unknown[] = [];
  const handler = createOrchestrationHandler({
    workerSecret: "worker-secret",
    run: async () => summary,
    log: (entry) => logs.push(entry),
  });

  const response = await handler(request());

  assert.equal(response.status, 200);
  assert.doesNotMatch(JSON.stringify(logs), /worker-secret/);
});

