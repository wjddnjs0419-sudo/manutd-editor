import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildMorningBriefingSnapshot, resolveBriefingPosition, selectBriefingCandidates } from "../../_shared/m6/briefing.ts";
import { renderMorningBrief } from "../../_shared/m6/openai.ts";

Deno.test("freezes exact candidate and representative identity for /open", () => {
  const saved = buildMorningBriefingSnapshot({
    briefing_date: "2026-09-20",
    timezone: "Asia/Seoul",
    match_day_mode: "NORMAL_DAY",
    match_context: { status: "none" },
    overnight_counts: { posts: 10, candidates: 3 },
    candidates: [
      { candidate_id: "candidate-a", priority_score: 88, first_mover_flag: true, must_cover_flag: false, creative_status: "DRAFT", representative: { raw_post_id: "post-a", media_asset_id: "asset-a", username: "u1", permalink: "https://instagram/a" } },
      { candidate_id: "candidate-b", priority_score: 81, first_mover_flag: false, must_cover_flag: true, creative_status: "READY", representative: { raw_post_id: "post-b", media_asset_id: "asset-b", username: "utddistrict", permalink: "https://www.instagram.com/p/abc/" } },
    ],
    blocked_failed: [],
  });
  assertEquals(resolveBriefingPosition(saved, 2), {
    position: 2,
    candidate_id: "candidate-b",
    priority_score: 81,
    first_mover_flag: false,
    must_cover_flag: true,
    creative_status: "READY",
    reference_post_id: "post-b",
    reference_media_asset_id: "asset-b",
    reference_username: "utddistrict",
    reference_permalink: "https://www.instagram.com/p/abc/",
  });
  assertEquals(resolveBriefingPosition(saved, 2)?.candidate_id, "candidate-b");
});

Deno.test("freezes editorial grounding state when the same-date ranking is available", () => {
  const saved = buildMorningBriefingSnapshot({
    briefing_date: "2026-09-20",
    timezone: "Asia/Seoul",
    match_day_mode: "NORMAL_DAY",
    match_context: {},
    overnight_counts: { candidates: 1 },
    candidates: [{ candidate_id: "candidate-a", priority_score: 88, first_mover_flag: false, must_cover_flag: false, creative_status: "DRAFT", editorial_rank: 1, grounding_status: "DISCOVERY_ONLY", news_eligible: false, representative: null }],
    blocked_failed: [],
  });
  assertEquals(saved.items[0]?.editorial_rank, 1);
  assertEquals(saved.items[0]?.grounding_status, "DISCOVERY_ONLY");
  assertEquals(saved.items[0]?.news_eligible, false);
});

Deno.test("keeps all trust states and ranks VERIFIED before REPORTED before DISCOVERY", () => {
  const selected = selectBriefingCandidates([
    { candidate_id: "discovery", grounding_status: "DISCOVERY_ONLY", news_eligible: false },
    { candidate_id: "reported", grounding_status: "INSUFFICIENT", news_eligible: false, source_name: "BBC Sport", source_url: "https://bbc.test/report" },
    { candidate_id: "verified", grounding_status: "VERIFIED", news_eligible: true },
  ]);
  assertEquals(selected.map((candidate) => candidate.candidate_id), ["verified", "reported", "discovery"]);
  assertEquals(selected[1]?.source_url, "https://bbc.test/report");
});

Deno.test("briefing renderer labels a single-source report and preserves its original URL", () => {
  const saved = buildMorningBriefingSnapshot({
    briefing_date: "2026-10-02", timezone: "Asia/Seoul", match_day_mode: "NORMAL_DAY", match_context: {}, overnight_counts: {},
    candidates: [{ candidate_id: "reported", priority_score: 55, first_mover_flag: false, must_cover_flag: false, creative_status: "NOT_REQUESTED", representative: null, grounding_status: "INSUFFICIENT", news_eligible: false, source_name: "BBC Sport", source_url: "https://bbc.test/report" }],
    blocked_failed: [],
  });
  const messages = renderMorningBrief(saved, { intro: "오늘의 업데이트", candidate_notes: [{ position: 1, note: "원문 확인" }], issue_note: null });
  assertEquals(messages[1]?.text.includes("🟡 보도됨"), true);
  assertEquals(messages[1]?.text.includes("https://bbc.test/report"), true);
});

Deno.test("preserves the legacy candidate fallback when no grounding decision exists", () => {
  const selected = selectBriefingCandidates([
    { candidate_id: "legacy-a" },
    { candidate_id: "legacy-b", grounding_status: null, news_eligible: false },
  ]);
  assertEquals(selected.map((candidate) => candidate.candidate_id), ["legacy-a", "legacy-b"]);
});

Deno.test("keeps verified standalone facts and useful unverified social candidates visible", () => {
  const selected = selectBriefingCandidates([
    { candidate_id: "social", candidate_type: "SOCIAL", grounding_status: "INSUFFICIENT", news_eligible: false },
    { candidate_id: "fact-source", candidate_type: "FACT_SOURCE", grounding_status: "VERIFIED", news_eligible: true },
  ]);
  assertEquals(selected.map((candidate) => candidate.candidate_id), ["fact-source", "social"]);
});

Deno.test("freezes standalone fact source metadata for Telegram rendering", () => {
  const saved = buildMorningBriefingSnapshot({
    briefing_date: "2026-09-20",
    timezone: "Asia/Seoul",
    match_day_mode: "NORMAL_DAY",
    match_context: {},
    overnight_counts: { candidates: 1 },
    candidates: [{
      candidate_id: "source:observation-1",
      priority_score: null,
      first_mover_flag: false,
      must_cover_flag: false,
      creative_status: "NOT_REQUESTED",
      representative: null,
      title: "Manchester United announce an official update",
      source_name: "Manchester United",
      source_url: "https://www.manutd.com/en/news/example",
    }],
    blocked_failed: [],
  });

  assertEquals(saved.items[0]?.title, "Manchester United announce an official update");
  assertEquals(saved.items[0]?.source_name, "Manchester United");
  assertEquals(saved.items[0]?.source_url, "https://www.manutd.com/en/news/example");
});
