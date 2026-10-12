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

Deno.test("rank handler logs safe stage timings and never logs credentials", async () => {
  const entries: Record<string, unknown>[] = [];
  const handler = createRankEditorialHandler({
    collectorSecret: "collector-secret",
    requestId: () => "request-safe-7",
    log: (entry) => entries.push(entry),
    run: async () => {
      return { status: "COMPLETED", ranked: 2, newsEligible: 1, researchLeads: 1, version: "m8-c-v1" };
    },
  });
  const response = await handler(new Request("https://functions.test/rank-editorial", {
    method: "POST",
    headers: { authorization: "Bearer collector-secret" },
    body: JSON.stringify({ ranking_date: "2026-09-27" }),
  }));
  assert.equal(response.status, 200);
  const stages = entries.filter((entry) => entry.event === "rank_editorial_stage");
  assert.deepEqual(stages.map((entry) => entry.stage), ["auth", "parse", "run", "total"]);
  for (const entry of stages) {
    assert.equal(entry.requestId, "request-safe-7");
    assert.equal(typeof entry.elapsedMs, "number");
    assert.equal(typeof entry.outcome, "string");
  }
  assert.equal(JSON.stringify(entries).includes("collector-secret"), false);
});

Deno.test("rank handler rejects before repository work", async () => {
  const entries: Record<string, unknown>[] = [];
  let runCalls = 0;
  const handler = createRankEditorialHandler({
    collectorSecret: "collector-secret",
    requestId: () => "request-rejected-1",
    log: (entry) => entries.push(entry),
    run: async () => {
      runCalls += 1;
      return { status: "COMPLETED", ranked: 0, newsEligible: 0, researchLeads: 0, version: "m8-c-v1" };
    },
  });

  const response = await handler(new Request("https://functions.test/rank-editorial", { method: "POST" }));

  assert.equal(response.status, 401);
  assert.equal(runCalls, 0);
  assert.deepEqual(entries.map((entry) => entry.stage), ["auth", "total"]);
  assert.equal(JSON.stringify(entries).includes("collector-secret"), false);
});
