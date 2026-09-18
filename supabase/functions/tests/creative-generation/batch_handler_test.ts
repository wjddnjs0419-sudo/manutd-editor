import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createCreativeBatchHandler } from "../../creative-generation/batch_handler.ts";

Deno.test("batch handler accepts an authenticated empty POST and returns the batch result", async () => {
  let runs = 0;
  const handler = createCreativeBatchHandler({ collectorSecret: "secret", run: async () => { runs += 1; return { ready: 2 }; }, requestId: () => "req-1", log: () => undefined });
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" } }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { request_id: "req-1", status: "COMPLETED", result: { ready: 2 } });
  assertEquals(runs, 1);
});

Deno.test("batch handler rejects bodies and methods outside its contract", async () => {
  const handler = createCreativeBatchHandler({ collectorSecret: "secret", run: async () => ({}), log: () => undefined });
  assertEquals((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("https://example.test", { method: "POST", body: "{\"x\":1}", headers: { authorization: "Bearer secret" } }))).status, 400);
});
