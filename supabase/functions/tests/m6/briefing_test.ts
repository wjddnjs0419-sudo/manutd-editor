import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildMorningBriefingSnapshot, resolveBriefingPosition } from "../../_shared/m6/briefing.ts";

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
