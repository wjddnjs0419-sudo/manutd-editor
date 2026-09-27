import assert from "node:assert/strict";
import { createGroundClaimsHandler } from "../../ground-claims/handler.ts";

Deno.test("ground claims handler authenticates and returns safe summary", async () => {
  const handler = createGroundClaimsHandler({ collectorSecret: "collector-secret", requestId: () => "request-1", run: async () => ({ status: "COMPLETED", claimsProcessed: 0, verified: 0, discoveryOnly: 0, contradicted: 0, insufficient: 0 }) });
  assert.equal((await handler(new Request("https://functions.test/ground-claims", { method: "GET" }))).status, 405);
  assert.equal((await handler(new Request("https://functions.test/ground-claims", { method: "POST" }))).status, 401);
  const response = await handler(new Request("https://functions.test/ground-claims", { method: "POST", headers: { authorization: "Bearer collector-secret" }, body: JSON.stringify({ as_of: "2026-09-27T02:00:00Z" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request_id: "request-1", status: "COMPLETED", claims_processed: 0, verified: 0, discovery_only: 0, contradicted: 0, insufficient: 0 });
});
