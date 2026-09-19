import {
  phraseMorningBrief,
  renderMorningBrief,
  validatePhrasedBriefing,
} from "../../_shared/m6/openai.ts";
import type { MorningBriefingSnapshot } from "../../_shared/m6/briefing.ts";
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { createMorningBriefHandler } from "../../telegram-morning-brief/handler.ts";

const snapshot: MorningBriefingSnapshot = {
  briefing_date: "2026-09-19",
  timezone: "Asia/Seoul",
  match_day_mode: "NORMAL_DAY",
  match_context: {},
  overnight_counts: { new: 4, blocked: 1 },
  items: [{
    position: 1,
    candidate_id: "candidate-1",
    priority_score: 88,
    first_mover_flag: true,
    must_cover_flag: false,
    creative_status: "READY",
    reference_post_id: "post-1",
    reference_media_asset_id: "asset-1",
    reference_username: "utdreport",
    reference_permalink: "https://www.instagram.com/p/abc/",
  }],
  blocked_failed: [],
};

Deno.test("phrasing validator rejects non-canonical positions and unsafe notes", async () => {
  assertThrows(() => validatePhrasedBriefing(snapshot, {
    intro: "좋은 아침입니다.",
    candidate_notes: [{ position: 2, note: "소식입니다" }],
    issue_note: null,
  }), Error, "UNKNOWN_POSITION");
  assertThrows(() => validatePhrasedBriefing(snapshot, {
    intro: "좋은 아침입니다.",
    candidate_notes: [{ position: 1, note: "Priority 88" }],
    issue_note: null,
  }), Error, "UNSAFE_NOTE");
  assertThrows(() => validatePhrasedBriefing(snapshot, {
    intro: "좋은 아침입니다.",
    candidate_notes: [{ position: 1, note: "자세한 내용 https://example.com" }],
    issue_note: null,
  }), Error, "UNSAFE_NOTE");
});

Deno.test("phrasing falls back deterministically when provider output is invalid", async () => {
  const result = await phraseMorningBrief(snapshot, {
    maxNoteChars: 80,
    generate: async () => ({ intro: "", candidate_notes: [{ position: 99, note: "bad" }], issue_note: null }),
  });
  assertEquals(result.render_mode, "FALLBACK_TEMPLATE");
  assertEquals(result.candidate_notes[0]?.position, 1);
  assert(!result.candidate_notes[0]?.note.includes("88"));
});

Deno.test("renderer owns canonical score, flags, status, source link, and open position", () => {
  const plans = renderMorningBrief(snapshot, {
    intro: "좋은 아침입니다.",
    candidate_notes: [{ position: 1, note: "부상 소식의 핵심을 확인해 주세요." }],
    issue_note: null,
  });
  assertEquals(plans.length, 3);
  assert(plans[1].text.includes("Priority 88"));
  assert(plans[1].text.includes("FIRST_MOVER"));
  assert(plans[1].text.includes("Creative Brief: READY"));
  assert(plans[1].text.includes("https://www.instagram.com/p/abc/"));
  assert(plans[1].text.includes("/open 1"));
});

Deno.test("morning brief handler authenticates and returns safe delivery summary", async () => {
  const handler = createMorningBriefHandler({
    invokeSecret: "secret",
    run: async () => ({ status: "SENT", briefing_date: "2026-09-19", messages_sent: 3, render_mode: "FALLBACK_TEMPLATE" }),
  });
  assertEquals((await handler(new Request("https://example.test", { method: "GET" }))).status, 405);
  assertEquals((await handler(new Request("https://example.test", { method: "POST" }))).status, 401);
  const response = await handler(new Request("https://example.test", { method: "POST", headers: { authorization: "Bearer secret" }, body: "{}" }));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { status: "SENT", briefing_date: "2026-09-19", messages_sent: 3, render_mode: "FALLBACK_TEMPLATE" });
});
