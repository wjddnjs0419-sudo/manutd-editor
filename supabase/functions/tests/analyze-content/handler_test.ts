import assert from "node:assert/strict";

import { createAnalyzeContentHandler } from "../../analyze-content/handler.ts";

const summary = {
  status: "COMPLETED" as const,
  candidates: 2,
  analyzed: 1,
  skipped: 1,
  succeeded: 1,
  partial: 0,
  unavailable: 0,
  failed: 0,
};

function request(body: string, authorization = "Bearer collector-secret", method = "POST") {
  return new Request("https://functions.test/analyze-content", {
    method,
    headers: { authorization, "content-type": "application/json" },
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  });
}

Deno.test("authenticates and returns only the safe analysis summary", async () => {
  let received: { asOf: Date | undefined; limit: number } | undefined;
  const handler = createAnalyzeContentHandler({
    collectorSecret: "collector-secret",
    now: () => new Date("2026-09-27T01:00:00.000Z"),
    requestId: () => "request-1",
    run: async (asOf, limit) => {
      received = { asOf, limit };
      return summary;
    },
  });

  const response = await handler(request(JSON.stringify({ as_of: "2026-09-27T00:00:00.000Z", limit: 7 })));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { asOf: new Date("2026-09-27T00:00:00.000Z"), limit: 7 });
  assert.deepEqual(await response.json(), { request_id: "request-1", ...summary });
});

Deno.test("rejects methods, credentials, and malformed bodies without running", async () => {
  let calls = 0;
  const handler = createAnalyzeContentHandler({ collectorSecret: "collector-secret", run: async () => { calls += 1; return summary; } });
  assert.equal((await handler(request("", "Bearer collector-secret", "GET"))).status, 405);
  assert.equal((await handler(request("", "Bearer wrong"))).status, 401);
  assert.equal((await handler(request(JSON.stringify({ limit: 101 })))).status, 400);
  assert.equal((await handler(request(JSON.stringify({ extra: true })))).status, 400);
  assert.equal(calls, 0);
});

Deno.test("maps a run failure to a safe response and redacted log", async () => {
  const logs: Record<string, unknown>[] = [];
  const handler = createAnalyzeContentHandler({
    collectorSecret: "collector-secret",
    requestId: () => "request-id-unset",
    log: (entry) => logs.push(entry),
    run: async () => { throw new Error("OPENAI_API_KEY and https://private.example/raw body"); },
  });
  const response = await handler(request(""));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { request_id: "request-id-unset", error: { code: "ANALYSIS_FAILED", message: "Content analysis failed" } });
  assert.equal(JSON.stringify(logs).includes("OPENAI_API_KEY"), false);
  assert.equal(JSON.stringify(logs).includes("private.example"), false);
});
