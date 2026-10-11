import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1.0.8";
import { deliverM9Carousel, signerFromSupabase, telegramAlbumFromBot } from "../../_shared/m9/telegram_album.ts";

const cover = { slide_number: 1, kind: "COVER_NEWS" as const, storage_bucket: "rendered", storage_path: "jobs/a/01.png", mime_type: "image/png" as const };
const body = { slide_number: 2, kind: "BODY_NEWS" as const, storage_bucket: "rendered", storage_path: "jobs/a/02.png", mime_type: "image/png" as const };

Deno.test("M9 signs every slide including CTA and sends one ordered Telegram group", async () => {
  const paths: string[] = [];
  const outputs: string[][] = [];
  const result = await deliverM9Carousel("chat", [cover, body], {
    storage: { sign: async (bucket, path, ttl) => { assertEquals(ttl, 600); paths.push(`${bucket}/${path}`); return `https://signed.example/${path}`; } },
    telegram: { sendAlbum: async (_chat, urls, caption) => { outputs.push([...urls]); assertEquals(caption, "뉴스"); return [11, 12, 13]; } },
  }, "뉴스");
  assertEquals(paths, ["rendered/jobs/a/01.png", "rendered/jobs/a/02.png", "manutd-card-assets/assets/cta.png"]);
  assertEquals(result.message_ids, [11, 12, 13]);
  assertEquals(result.slide_count, 3);
  assertEquals(outputs[0]?.length, 3);
});

Deno.test("M9 signing failure prevents partial Telegram delivery", async () => {
  let sent = false;
  await assertRejects(() => deliverM9Carousel("chat", [cover, body], {
    storage: { sign: async (_bucket, path) => { if (path === "jobs/a/02.png") throw new Error("missing"); return "https://signed.example/ok"; } },
    telegram: { sendAlbum: async () => { sent = true; return [1, 2, 3]; } },
  }));
  assertEquals(sent, false);
});

Deno.test("M9 fails closed on invalid URL and oversized caption", async () => {
  await assertRejects(() => deliverM9Carousel("chat", [cover], {
    storage: { sign: async () => "http://invalid" },
    telegram: { sendAlbum: async () => [1, 2] },
  }), Error, "M9_SIGNED_URL_INVALID");
  await assertRejects(() => deliverM9Carousel("chat", [cover], {
    storage: { sign: async () => "https://example.com/item" },
    telegram: { sendAlbum: async () => [1, 2] },
  }, "x".repeat(1025)), Error, "M9_TELEGRAM_CAPTION_TOO_LONG");
});

Deno.test("M9 Bot API uses sendMediaGroup with caption on first photo only", async () => {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const transport = telegramAlbumFromBot("bot-token", async (input, init) => {
    calls.push({ method: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ ok: true, result: [{ message_id: 101 }, { message_id: 102 }] }), { status: 200 });
  });
  const ids = await transport.sendAlbum("1234", ["https://example.com/one.png", "https://example.com/two.png"], "hello");
  assertEquals(ids, [101, 102]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.method.endsWith("/sendMediaGroup"), true);
  const media = calls[0]?.body.media as Array<Record<string, unknown>>;
  assertEquals(media[0]?.caption, "hello");
  assertEquals(media[1]?.caption, undefined);
});

Deno.test("M9 Bot API rejects network errors and malformed response without retry", async () => {
  let attempts = 0;
  const transport = telegramAlbumFromBot("bot-token", async () => { attempts++; throw Error("offline"); });
  await assertRejects(() => transport.sendAlbum("1", ["https://ex.com/1","https://ex.com/2"]), Error, "M9_TELEGRAM_SEND_NETWORK_FAILED");
  assertEquals(attempts, 1);
  assertThrows(() => telegramAlbumFromBot("   "), Error, "M9_BOT_TOKEN_REQUIRED");
});

Deno.test("M9 signer adapter accepts signed URL and rejects auth failure", async () => {
  const signer = signerFromSupabase({ from: (bucket) => ({ createSignedUrl: async (path, seconds) => { assertEquals(bucket, "manutd-card-assets");assertEquals(path, "assets/cta.png");assertEquals(seconds,600); return { data: { signedUrl: "https://secure.example/cta.png?token=a" },error:null }; } }) });
  assertEquals(await signer.sign("manutd-card-assets","assets/cta.png",600),"https://secure.example/cta.png?token=a");
  const broken = signerFromSupabase({ from: () => ({ createSignedUrl: async () => ({ data: null,error:"401" }) }) });
  await assertRejects(() => broken.sign("bucket","a",600), Error, "M9_STORAGE_SIGNING_FAILED");
});
