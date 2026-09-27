import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createTelegramAgentHandler } from "../../telegram-agent/handler.ts";

function telegramUpdate(updateId = 1, fromId = 42, chatId = 42) {
  return { update_id: updateId, message: { from: { id: fromId }, chat: { id: chatId }, text: "/today" } };
}

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

Deno.test("direct Telegram webhook header authenticates without a bearer token", async () => {
  let received: unknown;
  const handler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    run: async (update) => {
      received = update;
      return { status: "OK", reply: "ok" };
    },
  });
  const update = telegramUpdate(5);
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
    body: JSON.stringify(update),
  }));
  assertEquals(response.status, 200);
  assertEquals(received, update);
});

Deno.test("webhook authentication rejects missing or incorrect secrets without fallback", async () => {
  const handler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    run: async () => ({ status: "OK", reply: "ok" }),
  });
  assertEquals((await handler(new Request("https://example.test", { method: "POST", body: JSON.stringify(telegramUpdate()) }))).status, 401);
  assertEquals((await handler(new Request("https://example.test", { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: JSON.stringify(telegramUpdate()) }))).status, 401);
  assertThrows(() => createTelegramAgentHandler({ invokeSecret: "", webhookSecret: "", ownerUserId: "42", run: async () => ({ status: "OK" }) }));
});

Deno.test("direct webhook rejects malformed updates before owner or dedupe processing", async () => {
  let claims = 0;
  let runs = 0;
  const handler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    claimUpdate: async () => {
      claims += 1;
      return true;
    },
    run: async () => {
      runs += 1;
      return { status: "OK", reply: "ok" };
    },
  });
  const malformed: unknown[] = [
    [telegramUpdate(10)],
    JSON.stringify(telegramUpdate(11)),
    null,
    {},
    { update_id: 12 },
    { update_id: 13, message: { chat: { id: 42 } } },
    { update_id: 14, message: { from: { id: 42 } } },
    { update_id: 15, message: { from: { id: 42 }, chat: { id: "" } } },
  ];
  for (const body of malformed) {
    const response = await handler(new Request("https://example.test", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
      body: JSON.stringify(body),
    }));
    assertEquals(response.status, 400);
  }
  assertEquals(claims, 0);
  assertEquals(runs, 0);
});

Deno.test("duplicate direct webhook update is claimed before running agent logic", async () => {
  let runs = 0;
  const handler = createTelegramAgentHandler({
    invokeSecret: "internal-secret",
    webhookSecret: "webhook-secret",
    ownerUserId: "42",
    claimUpdate: async () => false,
    run: async () => {
      runs += 1;
      return { status: "OK", reply: "ok" };
    },
  });
  const response = await handler(new Request("https://example.test", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
    body: JSON.stringify(telegramUpdate(16)),
  }));
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

Deno.test("agent handler accepts owner callback queries and deduplicates them", async () => {
  let runs = 0;
  const callbackUpdate = { update_id: 17, callback_query: { id: "callback-1", from: { id: 42 }, message: { message_id: 8, chat: { id: 42 } }, data: "ideas:recommended:1" } };
  const handler = createTelegramAgentHandler({ invokeSecret: "secret", ownerUserId: "42", claimUpdate: async () => { runs += 1; return runs === 1; }, run: async (update) => ({ status: "OK", reply: JSON.stringify(update) }) });
  const first = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(callbackUpdate) }));
  assertEquals(first.status, 200);
  assertEquals((await first.json()).status, "OK");
  const second = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify(callbackUpdate) }));
  assertEquals(await second.json(), { status: "ALREADY_PROCESSED" });
});
