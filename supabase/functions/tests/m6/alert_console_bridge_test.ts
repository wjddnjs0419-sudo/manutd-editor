import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { createEditorialConsoleRepository, findCanonicalStoryByToken, paginateStories } from "../../_shared/m6/editorial_console.ts";
import { dispatchEditorialConsoleAction, parseConsoleCallback, type ConsoleState } from "../../_shared/m6/editorial_console_actions.ts";
import { createM6Repository } from "../../_shared/m6/repository.ts";
import { snapshotCurrentCandidates } from "../../telegram-agent/current.ts";
import { renderEditorialStoryAlert } from "../../telegram-alerts/editorial_alerts.ts";
import type { ManutdEditorCarouselDraft } from "../../_shared/editorial-style/types.ts";

const date = "2026-09-27";
const storyId = "11111111-1111-4111-8111-111111111111";
const candidateId = "21111111-1111-4111-8111-111111111111";
const sourceUrl = "https://example.test/man-utd-report";
const postUrl = "https://example.test/post";

function response(rows: unknown): Response {
  return new Response(JSON.stringify(rows), { headers: { "content-type": "application/json" } });
}

// Both repositories read the same existing cluster and candidate rows.
function fixtureFetch(input: RequestInfo | URL): Promise<Response> {
  const url = String(input);
  if (url.includes("/editorial_rankings?")) return Promise.resolve(response([{ story_cluster_id: storyId, ranking_date: date, ranking_version: "m8-v1", rank: 1, editorial_score: 91, information_gap_score: 94, fact_grounding_score: 87, discovery_audience_signal_score: 88, grounding_status: "VERIFIED", news_eligible: true }]));
  if (url.includes("/story_clusters?")) return Promise.resolve(response([{ id: storyId, canonical_title: "Manchester United transfer update", summary: "Confirmed report", signature_json: {} }]));
  if (url.includes("/content_candidates?")) return Promise.resolve(response([{ id: candidateId, story_cluster_id: storyId, ranking_date: date, rank: 1, priority_score: 90, first_mover_flag: false, must_cover_flag: false, creative_briefs: [] }]));
  if (url.includes("/story_cluster_sources?")) return Promise.resolve(response([{ story_cluster_id: storyId, information_source_id: "source-1", information_sources: { canonical_name: "BBC Sport" } }]));
  if (url.includes("/story_claims?")) return Promise.resolve(response([{ id: "claim-1", story_cluster_id: storyId, claim_text: "Manchester United confirmed the update.", grounding_status: "VERIFIED" }]));
  if (url.includes("/claim_evidence?")) return Promise.resolve(response([{ claim_id: "claim-1", source_observation_id: "observation-1", evidence_text: "Confirmed report", is_grounding: true }]));
  if (url.includes("/source_observations?")) return Promise.resolve(response([{ id: "observation-1", information_source_id: "source-1", editorial_role: "FACT_PRIMARY", title: "Manchester United transfer update", canonical_url: sourceUrl, observed_at: `${date}T08:00:00.000Z` }]));
  if (url.includes("/information_sources?")) return Promise.resolve(response([{ id: "source-1", canonical_name: "BBC Sport" }]));
  if (url.includes("/story_cluster_posts?")) return Promise.resolve(response([{ story_cluster_id: storyId, raw_post_id: "post-1", match_confidence: 0.9, raw_posts: { permalink: postUrl, published_at: `${date}T07:00:00.000Z`, media_type: "IMAGE", media_product_type: null, source_accounts: { username: "utdreport" }, media_assets: [] } }]));
  return Promise.resolve(response([]));
}

Deno.test("alert story callbacks resolve the canonical story and /current's existing candidate", async () => {
  const options = { supabaseUrl: "https://example.supabase.co", serviceRoleKey: "test-key", fetch: fixtureFetch };
  const consoleRepository = createEditorialConsoleRepository(options);
  const currentRepository = createM6Repository(options);
  const stories = await consoleRepository.listCanonicalStories(date);
  const currentRows = await currentRepository.listBriefingCandidates(date);
  const snapshot = snapshotCurrentCandidates(date, currentRows);
  assertEquals(stories.length, 1);
  assertEquals(stories[0]?.candidate_id, candidateId);
  assertEquals(snapshot.items[0]?.candidate_id, candidateId);
  assertEquals(snapshot.items[0]?.reference_permalink, postUrl);
  assertEquals(stories[0]?.evidence[0]?.canonical_url, sourceUrl);
  assertEquals(snapshot.items.find((item) => item.candidate_id === "source:observation-1")?.source_url, sourceUrl);

  const alert = renderEditorialStoryAlert({ eventType: "VERIFIED_STORY", storyId, title: stories[0]!.title, sourceCount: 1, trendState: "RISING", groundingStatus: "VERIFIED", newsEligible: true, groundingEvidenceAvailable: true, primarySourceName: "BBC Sport", primarySourceUrl: sourceUrl });
  const actions = alert.reply_markup.inline_keyboard.flat().map((button) => parseConsoleCallback(button.callback_data));
  assertEquals(actions.map((action) => action?.type), ["GENERATE_CAROUSEL", "OPEN_REEL", "OPEN_EVIDENCE", "SKIP_STORY"]);
  for (const action of actions) {
    assert(action && "token" in action && typeof action.token === "string");
    assertEquals(findCanonicalStoryByToken(stories, action.token)?.candidate_id, snapshot.items[0]?.candidate_id);
  }

  const state: ConsoleState = { view: "HOME", mode: "recommended", page: 1, story_id: null, story_fingerprint: null, brief_id: null, telegram_message_id: 1, state_version: 1 };
  const draft: ManutdEditorCarouselDraft = { style_profile: "manutd_editor", style_version: "manutd-editor-v1", story_id: storyId, creative_brief_id: "brief-1", slides: [], caption: { body: "Draft", cta: null }, editor_warning: null, internal_grounding: { evidence_ids: ["claim:claim-1"], source_caveats: [], unsupported_claims: [] } };
  let generatedCandidate: string | null = null;
  let skippedFingerprint: string | null = null;
  const skipped = new Set<string>();
  const dependencies = {
    listStories: async () => paginateStories(stories.filter((story) => !skipped.has(story.story_fingerprint)), 1),
    getStoryByToken: async (token: string) => findCanonicalStoryByToken(stories, token),
    skipStory: async (story: typeof stories[number]) => { skippedFingerprint = story.story_fingerprint; skipped.add(story.story_fingerprint); },
    generateCarousel: async (story: typeof stories[number]) => { generatedCandidate = story.candidate_id; return draft; },
    selectDraft: async () => undefined,
  };
  const carousel = await dispatchEditorialConsoleAction(actions[0]!, state, dependencies);
  assertEquals(carousel.event.action, "CREATIVE_GENERATION_COMPLETED");
  assertEquals(generatedCandidate, candidateId);
  const reel = await dispatchEditorialConsoleAction(actions[1]!, state, dependencies);
  assertEquals(reel.event.action, "REEL_OPENED");
  const evidence = await dispatchEditorialConsoleAction(actions[2]!, state, dependencies);
  assertEquals(evidence.event.action, "EVIDENCE_OPENED");
  assert(evidence.view.text.includes(sourceUrl));
  const skip = await dispatchEditorialConsoleAction(actions[3]!, state, dependencies);
  assertEquals(skip.event.action, "STORY_SKIPPED");
  assertEquals(skippedFingerprint, stories[0]?.story_fingerprint);
  assertEquals(skip.view.text.includes(stories[0]!.title), false);
  assertEquals((await consoleRepository.listCanonicalStories(date)).length, 1);
});
