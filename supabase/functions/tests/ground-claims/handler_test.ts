import assert from "node:assert/strict";
import { createGroundClaimsHandler } from "../../ground-claims/handler.ts";
import type { GroundingRunInput, GroundingSummary } from "../../ground-claims/types.ts";

const endpoint = "https://functions.test/ground-claims";
const storyOne = "11111111-1111-4111-8111-111111111111";
const storyTwo = "22222222-2222-4222-8222-222222222222";
function authorized(body: unknown): Request {
  return new Request(endpoint, { method: "POST", headers: { authorization: "Bearer collector-secret" }, body: JSON.stringify(body) });
}

Deno.test("ground claims handler authenticates and returns safe summary", async () => {
  const handler = createGroundClaimsHandler({ collectorSecret: "collector-secret", requestId: () => "request-1", run: async () => ({ status: "COMPLETED", claimsProcessed: 0, verified: 0, discoveryOnly: 0, contradicted: 0, insufficient: 0, hasMore: false, nextCursor: null }) });
  assert.equal((await handler(new Request("https://functions.test/ground-claims", { method: "GET" }))).status, 405);
  assert.equal((await handler(new Request("https://functions.test/ground-claims", { method: "POST" }))).status, 401);
  const response = await handler(new Request("https://functions.test/ground-claims", { method: "POST", headers: { authorization: "Bearer collector-secret" }, body: JSON.stringify({ as_of: "2026-09-27T02:00:00Z" }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { request_id: "request-1", status: "COMPLETED", claims_processed: 0, verified: 0, discovery_only: 0, contradicted: 0, insufficient: 0, has_more: false, next_cursor: null });
});

Deno.test("ground claims handler defaults to 25 and accepts a scoped 100-item continuation", async () => {
  const inputs: GroundingRunInput[] = [];
  const handler = createGroundClaimsHandler({ collectorSecret: "collector-secret", run: async (input) => {
    inputs.push(input);
    return { status: "PARTIAL", claimsProcessed: 100, verified: 0, discoveryOnly: 0, contradicted: 0, insufficient: 100, hasMore: true, nextCursor: "d:claim-100" } as unknown as GroundingSummary;
  } });
  assert.equal((await handler(authorized({ story_cluster_ids: [storyOne] }))).status, 200);
  assert.equal((inputs[0] as GroundingRunInput & { limit: number }).limit, 25);
  const response = await handler(authorized({ as_of: "2026-09-27T02:00:00Z", story_cluster_ids: [storyOne, storyTwo], limit: 100, cursor: "d:claim-100" }));
  assert.equal(response.status, 200);
  assert.deepEqual(inputs[1], { asOf: new Date("2026-09-27T02:00:00Z"), storyClusterIds: [storyOne, storyTwo], limit: 100, cursor: "d:claim-100" });
  const result = await response.json();
  assert.equal(result.has_more, true);
  assert.equal(result.next_cursor, "d:claim-100");
});

Deno.test("ground claims handler rejects invalid limits, story scopes, and cursors", async () => {
  let runs = 0;
  const handler = createGroundClaimsHandler({ collectorSecret: "collector-secret", run: async () => { runs += 1; return { status: "COMPLETED", claimsProcessed: 0, verified: 0, discoveryOnly: 0, contradicted: 0, insufficient: 0 }; } });
  for (const body of [
    { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "25" },
    { story_cluster_ids: "cluster-1" }, { story_cluster_ids: [storyOne, 7] },
    { story_cluster_ids: [""] }, { story_cluster_ids: ["not-a-uuid"] }, { story_cluster_ids: [storyOne, storyOne] },
    { cursor: 123 }, { cursor: "" },
  ]) {
    const response = await handler(authorized(body));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(runs, 0);
});

Deno.test("ground claims handler preserves an explicit empty story scope", async () => {
  let input: GroundingRunInput | undefined;
  const handler = createGroundClaimsHandler({ collectorSecret: "collector-secret", run: async (value) => { input = value; return { status: "COMPLETED", claimsProcessed: 0, verified: 0, discoveryOnly: 0, contradicted: 0, insufficient: 0, hasMore: false, nextCursor: null }; } });
  assert.equal((await handler(authorized({ story_cluster_ids: [] }))).status, 200);
  assert.deepEqual((input as GroundingRunInput & { storyClusterIds: string[] }).storyClusterIds, []);
});
