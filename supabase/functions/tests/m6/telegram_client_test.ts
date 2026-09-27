import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { TelegramClientError, createTelegramClient } from "../../_shared/m6/telegram_client.ts";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.test("sends text and photo through the Bot API", async () => {
  const paths: string[] = [];
  const client = createTelegramClient({ token: "bot-secret", fetch: async (input) => { paths.push(String(input)); return response(200, { ok: true, result: { message_id: 7 } }); } });
  assertEquals((await client.sendText("chat", "hello")).message_id, 7);
  assertEquals((await client.sendPhoto("chat", "https://signed/photo", "caption")).message_id, 7);
  assertEquals(paths, ["https://api.telegram.org/botbot-secret/sendMessage", "https://api.telegram.org/botbot-secret/sendPhoto"]);
});

Deno.test("honors retry_after on 429 and retries transient failures", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const client = createTelegramClient({ token: "secret", sleep: async (ms) => { sleeps.push(ms); }, fetch: async () => { attempts += 1; return attempts === 1 ? response(429, { ok: false, parameters: { retry_after: 2 } }) : response(200, { ok: true, result: { message_id: 1 } }); } });
  await client.sendText("chat", "hello");
  assertEquals(attempts, 2);
  assertEquals(sleeps, [2000]);
});

Deno.test("does not retry permanent auth errors or expose token", async () => {
  let attempts = 0;
  const client = createTelegramClient({ token: "secret-token", fetch: async () => { attempts += 1; return response(401, { ok: false, description: "secret-token private detail" }); } });
  await assertRejects(() => client.sendText("chat", "hello"), TelegramClientError, "UNAUTHORIZED");
  assertEquals(attempts, 1);
});

Deno.test("sends inline keyboards, edits navigation messages, and acknowledges callbacks", async () => {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const client = createTelegramClient({ token: "secret", fetch: async (input, init) => {
    const requestInit = init as globalThis.RequestInit | undefined;
    calls.push({ method: String(input).split("/").pop() ?? "", body: JSON.parse(String(requestInit?.body)) as Record<string, unknown> });
    return response(200, { ok: true, result: { message_id: 8 } });
  } });
  const markup = { inline_keyboard: [[{ text: "추천", callback_data: "ideas:recommended:1" }]] };
  await client.sendText("chat", "hello", markup);
  await client.editMessageText("chat", 8, "updated", markup);
  await client.answerCallbackQuery("callback-1");
  assertEquals(calls.map((call) => call.method), ["sendMessage", "editMessageText", "answerCallbackQuery"]);
  assertEquals(calls[0]?.body.reply_markup, markup);
  assertEquals(calls[1]?.body.message_id, 8);
  assertEquals(calls[2]?.body.callback_query_id, "callback-1");
});
