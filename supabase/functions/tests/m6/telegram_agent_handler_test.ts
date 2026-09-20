import { assertEquals } from "jsr:@std/assert@1";
import { createTelegramAgentHandler } from "../../telegram-agent/handler.ts";

Deno.test("agent handler rejects unauthorized invoke and owner identities", async () => {
  const handler = createTelegramAgentHandler({ invokeSecret: "secret", ownerUserId: "42", run: async () => ({ status: "OK", reply: "ok" }) });
  assertEquals((await handler(new Request("https://example.test", { method: "POST" }))).status, 401);
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ update_id: 1, message: { from: { id: 7 }, chat: { id: 1 }, text: "/today" } }) }));
  assertEquals(response.status, 403);
});

Deno.test("duplicate update is claimed before running agent logic", async () => {
  let runs = 0;
  const handler = createTelegramAgentHandler({ invokeSecret: "secret", ownerUserId: "42", claimUpdate: async () => false, run: async () => { runs += 1; return { status: "OK", reply: "ok" }; } });
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ update_id: 2, message: { from: { id: 42 }, chat: { id: 1 }, text: "hello" } }) }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "ALREADY_PROCESSED" });
  assertEquals(runs, 0);
});

Deno.test("agent handler unwraps a single n8n item before owner validation", async () => {
  let received: unknown;
  const handler = createTelegramAgentHandler({ invokeSecret: "secret", ownerUserId: "42", run: async (update) => {
    received = update;
    return { status: "OK", reply: "ok" };
  } });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify([{ update_id: 3, message: { from: { id: 42 }, chat: { id: 42 }, text: "/help" } }]),
  }));
  assertEquals(response.status, 200);
  assertEquals(received, { update_id: 3, message: { from: { id: 42 }, chat: { id: 42 }, text: "/help" } });
});

Deno.test("agent handler parses a JSON-encoded n8n item before owner validation", async () => {
  let received: unknown;
  const handler = createTelegramAgentHandler({ invokeSecret: "secret", ownerUserId: "42", run: async (update) => {
    received = update;
    return { status: "OK", reply: "ok" };
  } });
  const update = { update_id: 4, message: { from: { id: 42 }, chat: { id: 42 }, text: "/help" } };
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { authorization: "Bearer secret" },
    body: JSON.stringify(JSON.stringify(update)),
  }));
  assertEquals(response.status, 200);
  assertEquals(received, update);
});
