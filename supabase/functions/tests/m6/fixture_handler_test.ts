import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createFixtureSyncHandler } from "../../fixture-sync/handler.ts";

const result = {
  status: "SYNCED" as const,
  matches_seen: 8,
  matches_changed: 1,
  alerts_created: 1,
  match_day_mode: "MATCH_DAY_PRE" as const,
};

Deno.test("fixture handler authenticates and returns only safe sync summary", async () => {
  let calls = 0;
  const handler = createFixtureSyncHandler({
    invokeSecret: "secret",
    now: () => new Date("2026-09-20T00:00:00Z"),
    run: async (request) => {
      calls += 1;
      assertEquals(request.mode, "FORCE");
      return result;
    },
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify({ mode: "FORCE" }),
  }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), result);
  assertEquals(calls, 1);
});

Deno.test("fixture handler rejects unauthorized, malformed, and non-POST requests", async () => {
  const handler = createFixtureSyncHandler({ invokeSecret: "secret", run: async () => result });
  assertEquals((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("https://example.test", { method: "POST" }))).status, 401);
  assertEquals((await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }))).status, 400);
});
