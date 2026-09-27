import assert from "node:assert/strict";
import { createSourceDiscoveryHandler } from "../../source-discovery/handler.ts";

function handler() {
  return createSourceDiscoveryHandler({
    collectorSecret: "collector-secret",
    requestId: () => "request-1",
    run: async ({ asOf, limit }) => ({ status: "NOOP", observed: 0, duplicates: 0, failedFeeds: 0, feedCount: limit ? 1 : asOf ? 2 : 0 }),
  });
}

Deno.test("source discovery handler authenticates and validates body", async () => {
  const run = handler();
  const unauthorized = await run(new Request("https://functions.test/source-discovery", { method: "POST" }));
  assert.equal(unauthorized.status, 401);
  const invalid = await run(new Request("https://functions.test/source-discovery", { method: "POST", headers: { authorization: "Bearer collector-secret", "content-type": "application/json" }, body: JSON.stringify({ as_of: "not-a-date" }) }));
  assert.equal(invalid.status, 400);
  const valid = await run(new Request("https://functions.test/source-discovery", { method: "POST", headers: { authorization: "Bearer collector-secret", "content-type": "application/json" }, body: JSON.stringify({ limit: 1 }) }));
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { request_id: "request-1", status: "NOOP", observed: 0, duplicates: 0, failed_feeds: 0, feed_count: 1 });
});

Deno.test("source discovery handler rejects non-POST", async () => {
  const response = await handler()(new Request("https://functions.test/source-discovery", { method: "GET" }));
  assert.equal(response.status, 405);
});
