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
