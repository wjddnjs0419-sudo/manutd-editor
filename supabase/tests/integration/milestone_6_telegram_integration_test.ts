import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { applyCandidateAlertTransition } from "../../functions/_shared/m6/alerts.ts";
import { buildMorningBriefingSnapshot } from "../../functions/_shared/m6/briefing.ts";
import { phraseMorningBrief, renderMorningBrief } from "../../functions/_shared/m6/openai.ts";
import { selectRepresentativeReference } from "../../functions/_shared/m6/reference_media.ts";
import type { CandidateReferencePost } from "../../functions/_shared/m6/reference_media.ts";
import { validatePendingAction } from "../../functions/_shared/m6/commands.ts";

const reference = (id: string, type: string, path: string | null): CandidateReferencePost => ({ raw_post_id: id, username: "utdreport", permalink: `https://instagram.test/${id}`, published_at: "2026-09-19T01:00:00Z", media_type: type, media_product_type: type === "REELS" ? "REELS" : null, match_confidence: 0.9, cited_source_reliability: 9, media_assets: path ? [{ id: `${id}-asset`, asset_type: type === "REELS" ? "THUMBNAIL" : type === "CAROUSEL_ALBUM" ? "CAROUSEL_CHILD" : "IMAGE", carousel_index: type === "CAROUSEL_ALBUM" ? 0 : null, storage_path: path }] : [] });

Deno.test("M6 fixture covers frozen representatives, fallback phrasing, and media-less permalink", async () => {
  const candidates = ["image", "carousel", "reel"].map((id, index) => ({ candidate_id: `candidate-${index + 1}`, priority_score: 90 - index, first_mover_flag: index === 0, must_cover_flag: index === 1, creative_status: "READY", representative: selectRepresentativeReference([reference(`post-${id}`, id === "reel" ? "REELS" : id === "carousel" ? "CAROUSEL_ALBUM" : "IMAGE", id === "carousel" ? "cache/carousel.jpg" : id === "reel" ? "cache/reel.jpg" : "cache/image.jpg")] ) }));
  candidates.push({ candidate_id: "candidate-4", priority_score: 70, first_mover_flag: false, must_cover_flag: false, creative_status: "BLOCKED", representative: selectRepresentativeReference([reference("post-no-media", "IMAGE", null)]) });
  const snapshot = buildMorningBriefingSnapshot({ briefing_date: "2026-09-19", timezone: "Asia/Seoul", match_day_mode: "MATCH_DAY_PRE", match_context: { opponent: "Liverpool" }, overnight_counts: { new: 4 }, candidates, blocked_failed: [{ source: "fixture-sync", status: "FAILED" }] });
  assertEquals(snapshot.items.length, 3);
  assertEquals(snapshot.items[0]?.reference_post_id, "post-image");
  assertEquals(snapshot.items[0]?.reference_permalink, "https://instagram.test/post-image");
  const phrasing = await phraseMorningBrief(snapshot, { generate: async () => ({ intro: "아침 브리핑", candidate_notes: [], issue_note: null }) });
  assertEquals(phrasing.render_mode, "FALLBACK_TEMPLATE");
  assert(renderMorningBrief(snapshot, phrasing).some((plan) => plan.text.includes("/open 1")));
});

Deno.test("M6 transition, duplicate delivery, and stale confirmation invariants", () => {
  const first = applyCandidateAlertTransition({ first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 0 }, { first_mover_flag: true, must_cover_flag: false }, "candidate-1");
  assertEquals(first.events[0]?.fingerprint, "FIRST_MOVER:candidate-1:1");
  assertEquals(applyCandidateAlertTransition(first.state, { first_mover_flag: true, must_cover_flag: false }, "candidate-1").events, []);
  assertEquals(validatePendingAction({ command_event_id: "e", command_type: "SLIDE", base_brief_id: "brief-4", base_revision: 4, args: {}, requested_at: "2026-09-19T00:00:00Z", expires_at: "2026-09-19T00:10:00Z" }, { latest_brief_id: "brief-5", latest_revision: 5, production_status: "LOCKED" }, new Date("2026-09-19T00:05:00Z")), "STALE_PENDING_ACTION");
});
