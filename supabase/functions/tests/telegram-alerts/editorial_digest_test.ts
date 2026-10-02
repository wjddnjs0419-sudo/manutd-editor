import assert from "node:assert/strict";
import { buildEditorialDigest, renderEditorialDigest, type EditorialDigestStory } from "../../telegram-alerts/editorial_digest.ts";
import { dispatchPendingAlerts, type PendingAlert } from "../../_shared/m6/alerts.ts";
import type { TelegramClient } from "../../_shared/m6/telegram_client.ts";

const start = new Date("2026-10-02T04:00:00.000Z");
const end = new Date("2026-10-02T05:00:00.000Z");
const story = (overrides: Partial<EditorialDigestStory> = {}) => ({
  story_id: "story-1", title: "맨유 단독 보도", trust_state: "REPORTED" as const, source_name: "BBC Sport", source_url: "https://bbc.test/article", last_seen_at: "2026-10-02T04:45:00.000Z", ...overrides,
});

Deno.test("hourly digest includes a fresh credible one-source story and dedupes clusters", () => {
  const digest = buildEditorialDigest([story(), story({ title: "중복" }), story({ story_id: "old", last_seen_at: "2026-10-02T03:59:59.000Z" })], start, end);
  assert.equal(digest?.stories.length, 1);
  assert.equal(digest?.stories[0]?.source_url, "https://bbc.test/article");
  assert.equal(digest?.stories[0]?.trust_state, "REPORTED");
  assert.equal(digest?.event_fingerprint, `EDITORIAL_DIGEST:${start.toISOString()}`);
});

Deno.test("empty hour suppresses an outbox event and windows use a stable idempotency key", () => {
  assert.equal(buildEditorialDigest([story({ last_seen_at: end.toISOString() })], start, end), null);
  const first = buildEditorialDigest([story()], start, end);
  const retry = buildEditorialDigest([story()], start, end);
  assert.equal(first?.event_fingerprint, retry?.event_fingerprint);
});

Deno.test("previously sent unchanged stories stay quiet while a material update appears again", () => {
  const unchanged = story({ material_fingerprint: "stable-v1" });
  assert.equal(buildEditorialDigest([unchanged], start, end, new Set(["stable-v1"])), null);
  const updated = story({ title: "맨유 새 보도 업데이트", material_fingerprint: "stable-v2" });
  assert.equal(buildEditorialDigest([updated], start, end, new Set(["stable-v1"]))?.stories.length, 1);
});

Deno.test("digest renders trust, source URL and optional trend label without score clutter", () => {
  const rendered = renderEditorialDigest({ window_start: start.toISOString(), stories: [story({ trend_state: "RISING" })] });
  assert.match(rendered.text, /🟡/u);
  assert.match(rendered.text, /https:\/\/bbc\.test\/article/u);
  assert.match(rendered.text, /🔥 급상승/u);
  assert.doesNotMatch(rendered.text, /relevance|trend score|source_count/iu);
});

Deno.test("outbox retries a failed send without creating another digest event", async () => {
  const pending: PendingAlert[] = [{ id: "digest-1", event_type: "EDITORIAL_DIGEST", payload: { window_start: start.toISOString(), stories: [story()] }, attempt_count: 0, max_attempt_count: 5 }];
  let sends = 0;
  let retryStatus = "";
  const client = { sendText: async () => { sends += 1; if (sends === 1) throw new Error("temporary"); return { message_id: 10 }; } } as unknown as TelegramClient;
  const dependencies = {
    listPending: async () => pending,
    resolveChatId: async () => "chat",
    client,
    markSent: async () => undefined,
    markFailed: async () => { retryStatus = "PENDING"; },
  };
  const first = await dispatchPendingAlerts(dependencies);
  assert.equal(first.failed, 1);
  assert.equal(retryStatus, "PENDING");
  const second = await dispatchPendingAlerts(dependencies);
  assert.equal(second.sent, 1);
  assert.equal(sends, 2);
});
