import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createPromoteDiscoveryHandler } from "../../promote-discovery/handler.ts";

Deno.test("promotion handler authenticates and forwards bounded search context", async () => {
  let received: unknown;
  const handler = createPromoteDiscoveryHandler({
    invokeSecret: "promotion-secret",
    now: () => new Date("2026-09-29T00:00:00.000Z"),
    run: async (input) => { received = input; return { status: "COMPLETED", observationsProcessed: 0, storiesCreated: 0, storiesUpdated: 0, claimsCreated: 0, editorialCandidatesEnsured: 0, affectedStoryIds: [] }; },
  });
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer promotion-secret" }, body: JSON.stringify({ as_of: "2026-09-29T01:00:00.000Z", limit: 20, ranking_date: "2026-09-29", promotion_job_id: "99999999-9999-4999-8999-999999999999", promotion_observation_id: "11111111-1111-4111-8111-111111111111", refresh_existing_grounding: true }) }));
  assertEquals(response.status, 200);
  assertEquals(received, { asOf: new Date("2026-09-29T01:00:00.000Z"), limit: 20, rankingDate: "2026-09-29", promotionJobId: "99999999-9999-4999-8999-999999999999", promotionObservationId: "11111111-1111-4111-8111-111111111111", refreshExistingGrounding: true });
});

Deno.test("promotion handler rejects unsafe methods, credentials, and limits", async () => {
  const handler = createPromoteDiscoveryHandler({ invokeSecret: "promotion-secret", run: async () => ({ status: "COMPLETED", observationsProcessed: 0, storiesCreated: 0, storiesUpdated: 0, claimsCreated: 0, editorialCandidatesEnsured: 0, affectedStoryIds: [] }) });
  assertEquals((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("https://example.test", { method: "POST" }))).status, 401);
  assertEquals((await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer promotion-secret", "content-type": "application/json" }, body: JSON.stringify({ limit: 501 }) })) ).status, 400);
  assertEquals((await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer promotion-secret", "content-type": "application/json" }, body: JSON.stringify({ limit: 101 }) })) ).status, 400);
});

Deno.test("promotion handler rejects malformed recheck flags", async () => {
  const handler = createPromoteDiscoveryHandler({
    invokeSecret: "promotion-secret",
    run: async () => ({ status: "COMPLETED", observationsProcessed: 0, storiesCreated: 0, storiesUpdated: 0, claimsCreated: 0, editorialCandidatesEnsured: 0, affectedStoryIds: [] }),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer promotion-secret", "content-type": "application/json" },
    body: JSON.stringify({ refresh_existing_grounding: "yes" }),
  }));
  assertEquals(response.status, 400);
});

Deno.test("promotion handler requires a job ID when an exact observation ID is supplied", async () => {
  const handler = createPromoteDiscoveryHandler({
    invokeSecret: "promotion-secret",
    run: async () => ({ status: "COMPLETED", observationsProcessed: 0, storiesCreated: 0, storiesUpdated: 0, claimsCreated: 0, editorialCandidatesEnsured: 0, affectedStoryIds: [] }),
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer promotion-secret", "content-type": "application/json" },
    body: JSON.stringify({ promotion_observation_id: "11111111-1111-4111-8111-111111111111" }),
  }));
  assertEquals(response.status, 400);
});
