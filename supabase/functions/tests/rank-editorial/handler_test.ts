import assert from "node:assert/strict";
import { createRankEditorialHandler } from "../../rank-editorial/handler.ts";

Deno.test("editorial ranking handler authenticates and returns safe summary", async () => {
  const handler = createRankEditorialHandler({ collectorSecret: "collector-secret", requestId: () => "request-1", run: async () => ({ status: "COMPLETED", ranked: 0, newsEligible: 0, researchLeads: 0, version: "m8-c-v1" }) });
  assert.equal((await handler(new Request("https://functions.test/rank-editorial", { method: "GET" }))).status, 405);
  assert.equal((await handler(new Request("https://functions.test/rank-editorial", { method: "POST" }))).status, 401);
  const response = await handler(new Request("https://functions.test/rank-editorial", { method: "POST", headers: { authorization: "Bearer collector-secret" }, body: JSON.stringify({ ranking_date: "2026-09-27" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request_id: "request-1", status: "COMPLETED", ranked: 0, news_eligible: 0, research_leads: 0, version: "m8-c-v1" });
});
