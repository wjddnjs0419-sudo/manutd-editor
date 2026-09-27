import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createTrendDiscoveryHandler } from "../../trend-discovery/handler.ts";

Deno.test("trend discovery handler validates auth and bounded mode input", async () => {
  let called = 0;
  const handler = createTrendDiscoveryHandler({ collectorSecret: "secret", run: async (input) => { called += 1; return { runId: "run-1", status: "NOOP", mode: input.mode ?? "GENERAL", queryCount: 0, observationCount: 0, newObservationCount: 0, newStoryCount: 0, updatedStoryCount: 0, providerStatuses: [], durationMs: 0 }; } });
  const unauthorized = await handler(new Request("https://example.test", { method: "POST", body: JSON.stringify({ mode: "GENERAL" }) }));
  assertEquals(unauthorized.status, 401);
  const invalid = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ mode: "UNKNOWN" }) }));
  assertEquals(invalid.status, 400);
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ mode: "COMMUNITY", max_queries: 2 }) }));
  assertEquals(response.status, 200);
  assertEquals(called, 1);
});
