import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildMorningBriefingSnapshot, resolveBriefingPosition, selectBriefingCandidates } from "../../_shared/m6/briefing.ts";

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

Deno.test("excludes unverified candidates when editorial grounding is available", () => {
  const selected = selectBriefingCandidates([
    { candidate_id: "verified", grounding_status: "VERIFIED", news_eligible: true },
    { candidate_id: "discovery", grounding_status: "DISCOVERY_ONLY", news_eligible: false },
    { candidate_id: "insufficient", grounding_status: "INSUFFICIENT", news_eligible: false },
  ]);
  assertEquals(selected.map((candidate) => candidate.candidate_id), ["verified"]);
});

Deno.test("preserves the legacy candidate fallback when no grounding decision exists", () => {
  const selected = selectBriefingCandidates([
    { candidate_id: "legacy-a" },
    { candidate_id: "legacy-b", grounding_status: null, news_eligible: false },
  ]);
  assertEquals(selected.map((candidate) => candidate.candidate_id), ["legacy-a", "legacy-b"]);
});
