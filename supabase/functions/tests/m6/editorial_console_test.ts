import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1.0.8";
import {
  buildCanonicalStories,
  createEditorialConsoleRepository,
  findCanonicalStoryByToken,
  paginateStories,
  renderEvidenceView,
  renderRecommendedList,
  renderStoryDetail,
  renderTextReel,
  renderCarouselDraft,
  renderTrendingList,
  type EditorialStoryInput,
} from "../../_shared/m6/editorial_console.ts";
import type { ManutdEditorCarouselDraft } from "../../_shared/editorial-style/types.ts";

const firstStory: EditorialStoryInput = {
  story_cluster_id: "11111111-1111-4111-8111-111111111111",
  candidate_id: "21111111-1111-4111-8111-111111111111",
  ranking_date: "2026-09-27",
  ranking_version: "m8-v1",
  canonical_title: "산초, 3개월째 FA",
  summary: "맨유와 계약이 끝난 뒤 새 팀을 찾고 있다.",
  rank: 1,
  editorial_score: 91.2,
  information_gap_score: 94,
  discovery_audience_signal_score: 88,
  fact_grounding_score: 87,
  grounding_status: "VERIFIED",
  news_eligible: true,
  source_names: ["BBC Sport", "Sky Sports"],
  evidence: [{ evidence_id: "claim:1", source_name: "BBC Sport", claim_text: "산초가 새 팀을 찾고 있다.", status: "SUPPORTED", canonical_url: "https://example.test/bbc" }],
  story_fingerprint: "story:111:m8-v1",
  latest_brief_id: null,
};

const secondStory: EditorialStoryInput = {
  ...firstStory,
  story_cluster_id: "12222222-2222-4222-8222-222222222222",
  candidate_id: "22222222-2222-4222-8222-222222222222",
  canonical_title: "가르나초 최근 4경기 0분",
  rank: 2,
  story_fingerprint: "story:122:m8-v1",
  grounding_status: "DISCOVERY_ONLY",
  news_eligible: false,
};

Deno.test("canonical story builder collapses duplicate source posts into one story", () => {
  const stories = buildCanonicalStories([firstStory, { ...firstStory, source_names: ["BBC Sport", "Sky Sports", "Reddit"] }]);
  assertEquals(stories.length, 1);
  assertEquals(stories[0]?.source_count, 3);
  assertEquals(stories[0]?.title, "산초, 3개월째 FA");
});

Deno.test("canonical stories show linked evidence sources when the legacy source relation is empty", () => {
  const stories = buildCanonicalStories([{ ...firstStory, source_names: [] }]);
  assertEquals(stories[0]?.sources, ["BBC Sport"]);
  assertEquals(stories[0]?.source_count, 1);
});

Deno.test("canonical story renderer hides internal entity-token titles", () => {
  const stories = buildCanonicalStories([{ ...firstStory, canonical_title: "sir_alex_ferguson pep_guardiola manchester_united manchester_city" }]);
  assertEquals(stories[0]?.title, "퍼거슨 · 과르디올라 · 맨유 · 맨시티 관련 소재");
});

Deno.test("all stories retains lower-ranked discovery-only canonical stories", () => {
  const stories = buildCanonicalStories([firstStory, secondStory]);
  assertEquals(stories.length, 2);
  assertEquals(stories[1]?.grounding_status, "DISCOVERY_ONLY");
  assertEquals(stories[1]?.news_eligible, false);
});

Deno.test("canonical story resolver accepts the visible list rank as a natural-language selection token", () => {
  const stories = buildCanonicalStories([firstStory, secondStory]);
  assertEquals(findCanonicalStoryByToken(stories, "1")?.id, stories[0]?.id);
  assertEquals(findCanonicalStoryByToken(stories, "1번")?.id, stories[0]?.id);
  assertEquals(findCanonicalStoryByToken(stories, "2")?.id, stories[1]?.id);
  assertEquals(findCanonicalStoryByToken(stories, "9"), null);
});

Deno.test("pagination uses five stories and preserves page boundaries", () => {
  const stories = buildCanonicalStories(Array.from({ length: 7 }, (_, index) => ({ ...firstStory, story_cluster_id: `cluster-${index}`, candidate_id: `candidate-${index}`, rank: index + 1, story_fingerprint: `fingerprint-${index}`, canonical_title: `스토리 ${index + 1}` })));
  const page = paginateStories(stories, 2, 5);
  assertEquals(page.items.length, 2);
  assertEquals(page.start, 6);
  assertEquals(page.end, 7);
  assertEquals(page.has_previous, true);
  assertEquals(page.has_next, false);
});

Deno.test("skipped story is filtered only when its current fingerprint is unchanged", () => {
  const stories = buildCanonicalStories([firstStory, secondStory]);
  assertEquals(buildCanonicalStories([firstStory, secondStory], new Set([firstStory.story_fingerprint])).length, 1);
  assertEquals(buildCanonicalStories([{ ...firstStory, story_fingerprint: "story:111:m8-v2" }, secondStory], new Set([firstStory.story_fingerprint])).length, 2);
});

Deno.test("rendered list and detail use compact editorial copy and short callbacks", () => {
  const list = renderRecommendedList(paginateStories(buildCanonicalStories([firstStory, secondStory]), 1), "recommended");
  assert(list.text.includes("🔥 추천 소재"));
  assert(list.text.includes("정보격차 9.4"));
  assert(list.inline_keyboard.flat().some((button) => button.callback_data.startsWith("idea:open:")));
  assert(list.inline_keyboard.flat().every((button) => button.callback_data.length <= 64));

  const detail = renderStoryDetail(buildCanonicalStories([firstStory])[0]!);
  assert(detail.text.includes("주요 출처: BBC Sport / Sky Sports"));
  assert(detail.inline_keyboard.flat().some((button) => button.callback_data.startsWith("idea:carousel:")));
  assertFalse(detail.text.includes("model"));
  assertFalse(detail.text.includes("grounding_json"));
});

Deno.test("discovery-only detail labels unverified facts separately from the Google News discovery link", () => {
  const discoveryStory = buildCanonicalStories([{
    ...secondStory,
    fact_grounding_score: 0,
    source_names: ["Goal.com"],
    evidence: [{ evidence_id: "discovery:1", source_name: "Goal.com", claim_text: "기사 후보", status: "REPORTED", canonical_url: "https://news.google.com/rss/articles/example", editorial_role: "DISCOVERY_COMMUNITY", source_reliability_score: null }],
  }])[0]!;
  const detail = renderStoryDetail(discoveryStory);
  const evidence = renderEvidenceView(discoveryStory);

  assert(detail.text.includes("사실 검증 0.0/10"));
  assert(detail.text.includes("발견 경로: Goal.com"));
  assert(detail.text.includes("매체 신뢰도: Goal.com 미등록"));
  assertFalse(detail.text.includes("매체 신뢰도: Goal.com 0.0/10"));
  assert(evidence.text.includes("https://news.google.com/rss/articles/example"));
});

Deno.test("editorial detail shows curated outlet reliability separately from fact verification", () => {
  const story = buildCanonicalStories([{
    ...firstStory,
    fact_grounding_score: 0,
    grounding_status: "DISCOVERY_ONLY",
    news_eligible: false,
    source_names: ["BBC Sport"],
    evidence: [{ evidence_id: "discovery:2", source_name: "BBC Sport", claim_text: "기사 후보", status: "REPORTED", canonical_url: "https://bbc.com/story", editorial_role: "DISCOVERY_COMMUNITY", source_reliability_score: 8 }],
  }])[0]!;
  const detail = renderStoryDetail(story);
  assert(detail.text.includes("사실 검증 0.0/10"));
  assert(detail.text.includes("매체 신뢰도: BBC Sport 8.0/10"));
});

Deno.test("trending renderer exposes trend/editorial scores, state, and platform diversity", () => {
  const stories = buildCanonicalStories([{ ...firstStory, trend_score: 94, trend_state: "RISING", platform_count: 3, opportunity_labels: ["🔥 빠르게 뜨는 중"] }]);
  const view = renderTrendingList(paginateStories(stories, 1));
  assert(view.text.includes("📈 지금 뜨는 소재"));
  assert(view.text.includes("Trend 94"));
  assert(view.text.includes("Editorial 91"));
  assert(view.text.includes("RISING"));
  assert(view.text.includes("3개 플랫폼"));
});

Deno.test("evidence view keeps source caveats separate from public copy", () => {
  const view = renderEvidenceView(buildCanonicalStories([firstStory])[0]!);
  assert(view.text.includes("🔎 근거"));
  assert(view.text.includes("BBC Sport"));
  assert(view.text.includes("SUPPORTED"));
  assert(view.text.includes("https://example.test/bbc"));
  assert(!view.text.includes("slides_json"));
});

Deno.test("text reel renderer stays a bounded plan, not a video output", () => {
  const view = renderTextReel(buildCanonicalStories([firstStory])[0]!);
  assert(view.text.includes("0–2초"));
  assert(view.text.includes("3개월째"));
  assert(view.text.includes("TEXT_REEL"));
  assert(!view.text.includes("다운로드"));
});

Deno.test("carousel renderer keeps editor warning outside public slides", () => {
  const draft: ManutdEditorCarouselDraft = {
    style_profile: "manutd_editor",
    style_version: "manutd-editor-v1",
    story_id: firstStory.story_cluster_id,
    creative_brief_id: "brief-1",
    slides: [
      { index: 1, role: "HOOK", headline: "3개월째 소속팀 없는 산초", highlight: "10부 리그에서 개인 훈련 중", body: null, closing_line: null, evidence_ids: ["claim:1"] },
      { index: 2, role: "CONTEXT", headline: "자유 계약만 3개월째", highlight: null, body: "맨유와 계약이 끝난 뒤\n새 팀을 찾지 못하고 있다.", closing_line: null, evidence_ids: ["claim:1"] },
      { index: 3, role: "KEY_FACT", headline: "10부리그 훈련장", highlight: "Flixton FC", body: "현재는 몸 상태를 유지하는 중이다.", closing_line: null, evidence_ids: ["claim:1"] },
    ],
    caption: { body: "산초의 다음 행선지는?", cta: null },
    editor_warning: "현재 근거로는 3장까지 구성하는 것이 적절합니다.",
    internal_grounding: { evidence_ids: ["claim:1"], source_caveats: ["단일 출처"], unsupported_claims: [] },
  };
  const view = renderCarouselDraft(draft);
  assert(view.text.includes("[1장]"));
  assert(view.text.includes("편집자 메모"));
  assert(view.text.includes("3장까지"));
  assert(!view.text.includes("단일 출처"));
  assert(view.inline_keyboard.flat().some((button) => button.callback_data.startsWith("draft:approve:")));
});

Deno.test("repository recovers trend scores from pre-promotion snapshots by content fingerprint", async () => {
  const repository = createEditorialConsoleRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([{ story_cluster_id: firstStory.story_cluster_id, ranking_date: firstStory.ranking_date, ranking_version: firstStory.ranking_version, rank: 1, editorial_score: 91.2, information_gap_score: 94, fact_grounding_score: 87, discovery_audience_signal_score: 88, grounding_status: "VERIFIED", news_eligible: true }]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([{ id: firstStory.story_cluster_id, canonical_title: firstStory.canonical_title, summary: firstStory.summary, signature_json: { content_fingerprints: ["fingerprint-1"] } }]));
      if (url.includes("content_candidates")) return new Response(JSON.stringify([{ id: firstStory.candidate_id, story_cluster_id: firstStory.story_cluster_id }]));
      if (url.includes("story_cluster_sources")) return new Response(JSON.stringify([{ story_cluster_id: firstStory.story_cluster_id, information_source_id: "source-1", information_sources: { canonical_name: "BBC Sport" } }]));
      if (url.includes("story_claims")) return new Response(JSON.stringify([{ id: "claim-1", story_cluster_id: firstStory.story_cluster_id, claim_text: "산초가 새 팀을 찾고 있다.", grounding_status: "VERIFIED" }]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([{ claim_id: "claim-1", source_observation_id: "observation-1", evidence_text: "BBC confirms the status.", is_grounding: true }]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-1", canonical_url: "https://example.test/bbc", title: "BBC Sport", editorial_role: "FACT_PRIMARY" }]));
      if (url.includes("information_sources?")) return new Response(JSON.stringify([{ id: "source-1", canonical_name: "BBC Sport", reliability_score: 8, reliability_rationale: "Curated primary outlet." }]));
      if (url.includes("trend_snapshots")) {
        const select = new URL(url).searchParams.get("select")?.split(",") ?? [];
        return new Response(JSON.stringify([{
          story_cluster_id: null,
          cluster_key: "discovery:source-story-1",
          snapshot_at: "2026-09-27T11:00:00.000Z",
          trend_score: 94,
          trend_state: "RISING",
          source_count: 2,
          platform_count: 3,
          opportunity_labels: ["🔥 빠르게 뜨는 중"],
          ...(select.includes("input_snapshot") ? { input_snapshot: { content_fingerprints: ["fingerprint-1"] } } : {}),
        }]));
      }
      return new Response(JSON.stringify([]));
    },
  });
  const stories = await repository.listCanonicalStories(firstStory.ranking_date);
  assertEquals(stories.length, 1);
  assertEquals(stories[0]?.title, firstStory.canonical_title);
  assertEquals(stories[0]?.source_count, 1);
  assertEquals(stories[0]?.evidence[0]?.status, "SUPPORTED");
  assertEquals(stories[0]?.evidence[0]?.source_reliability_score, 8);
  assertEquals(stories[0]?.trend_score, 94);
  assertEquals(stories[0]?.trend_platform_count, 3);
});
