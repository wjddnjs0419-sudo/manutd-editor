import assert from "node:assert/strict";
import { createRankEditorialHandler } from "../../rank-editorial/handler.ts";
import type { EditorialRankingRunInput } from "../../rank-editorial/types.ts";

Deno.test("rank-editorial defaults ranking_date from as_of in the Seoul timezone", async () => {
  const received: EditorialRankingRunInput[] = [];
  const handler = createRankEditorialHandler({
    collectorSecret: "collector-secret",
    run: async (input) => {
      received.push(input);
      return { status: "COMPLETED", ranked: 0, newsEligible: 0, researchLeads: 0, version: "m8-c-v1" };
    },
  });

  const response = await handler(new Request("https://functions.test/rank-editorial", {
    method: "POST",
    headers: { authorization: "Bearer collector-secret" },
    body: JSON.stringify({ as_of: "2026-09-29T17:40:00Z" }),
  }));

  assert.equal(response.status, 200);
  assert.equal(received[0]?.rankingDate, "2026-09-30");
});
