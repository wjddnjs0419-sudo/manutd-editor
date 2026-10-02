import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1.0.8";
import {
  dispatchEditorialConsoleAction,
  canHandleStaleConsoleCallback,
  parseConsoleCallback,
  parseConsoleIntent,
  type ConsoleActionDependencies,
  type ConsoleState,
} from "../../_shared/m6/editorial_console_actions.ts";
import { buildCanonicalStories, paginateStories, type CanonicalStory } from "../../_shared/m6/editorial_console.ts";
import type { ManutdEditorCarouselDraft } from "../../_shared/editorial-style/types.ts";

const story: CanonicalStory = buildCanonicalStories([{
  story_cluster_id: "11111111-1111-4111-8111-111111111111",
  candidate_id: "21111111-1111-4111-8111-111111111111",
  ranking_date: "2026-09-27",
  ranking_version: "m8-v1",
  canonical_title: "산초, 3개월째 FA",
  summary: "아직 새 팀을 찾지 못하고 있다.",
  rank: 1,
  editorial_score: 91,
  information_gap_score: 94,
  discovery_audience_signal_score: 88,
  fact_grounding_score: 87,
  grounding_status: "VERIFIED",
  news_eligible: true,
  source_names: ["BBC Sport"],
  evidence: [{ evidence_id: "claim:1", source_name: "BBC Sport", claim_text: "산초가 새 팀을 찾고 있다.", status: "SUPPORTED", canonical_url: "https://bbc.test/sancho", editorial_role: "FACT_PRIMARY" }],
  story_fingerprint: "fingerprint-1",
  latest_brief_id: null,
}])[0]!;

const draft: ManutdEditorCarouselDraft = {
  style_profile: "manutd_editor",
  style_version: "manutd-editor-v1",
  story_id: story.id,
  creative_brief_id: "brief-1",
  slides: [
    { index: 1, role: "HOOK", headline: "3개월째 소속팀 없는 산초", highlight: "10부 리그에서 개인 훈련 중", body: null, closing_line: null, evidence_ids: ["claim:1"], visual_direction: { subject: "산초 훈련 사진", image_type: "training photo", layout_intent: "큰 헤드라인 왼쪽 정렬", stat_emphasis: "3개월" } },
    { index: 2, role: "CONTEXT", headline: "자유 계약만 3개월째", highlight: null, body: "새 팀을 찾고 있다.", closing_line: null, evidence_ids: ["claim:1"] },
    { index: 3, role: "KEY_FACT", headline: "10부리그 훈련장", highlight: null, body: "몸 상태를 유지하는 중이다.", closing_line: null, evidence_ids: ["claim:1"] },
  ],
  caption: { body: "산초의 다음 행선지는?", cta: null },
  editor_warning: null,
  internal_grounding: { evidence_ids: ["claim:1"], source_caveats: [], unsupported_claims: [] },
};

function state(overrides: Partial<ConsoleState> = {}): ConsoleState {
  return { view: "HOME", mode: null, page: 1, story_id: null, story_fingerprint: null, brief_id: null, telegram_message_id: 100, state_version: 1, ...overrides };
}

function dependencies(overrides: Partial<ConsoleActionDependencies> = {}): ConsoleActionDependencies {
  return {
    listStories: async (mode, page) => paginateStories(mode === "recommended" ? [story] : [story], page),
    getStoryByToken: async (token) => token === story.id || token === story.id.replaceAll("-", "").slice(0, 12) ? story : null,
    skipStory: async () => undefined,
    generateCarousel: async () => draft,
    selectDraft: async () => undefined,
    ...overrides,
  };
}

Deno.test("parses compact callback actions and rejects stale-shaped payloads", () => {
  assertEquals(parseConsoleCallback("ideas:recommended:2"), { type: "OPEN_RECOMMENDED", page: 2 });
  assertEquals(parseConsoleCallback("idea:open:111111111111"), { type: "OPEN_STORY", token: "111111111111" });
  assertEquals(parseConsoleCallback("idea:carousel:111111111111"), { type: "GENERATE_CAROUSEL", token: "111111111111" });
  assertEquals(parseConsoleCallback("idea:open:긴-스토리-본문"), null);
  assertEquals(parseConsoleCallback("unknown:action"), null);
  assertEquals(parseConsoleCallback("ideas:trending:1"), { type: "OPEN_TRENDING", page: 1 });
  assertEquals(parseConsoleCallback("discovery:more"), { type: "DISCOVER_MORE" });
});

Deno.test("allows stale callbacks only for actions that re-resolve canonical story state", () => {
  assertEquals(canHandleStaleConsoleCallback({ type: "OPEN_STORY", token: story.id }), true);
  assertEquals(canHandleStaleConsoleCallback({ type: "OPEN_EVIDENCE", token: story.id }), true);
  assertEquals(canHandleStaleConsoleCallback({ type: "GENERATE_CAROUSEL", token: story.id }), true);
  assertEquals(canHandleStaleConsoleCallback({ type: "SKIP_STORY", token: story.id }), true);
  assertEquals(canHandleStaleConsoleCallback({ type: "SELECT_DRAFT", token: "brief-1" }), false);
  assertEquals(canHandleStaleConsoleCallback({ type: "EDIT_DRAFT", token: "brief-1" }), false);
});

Deno.test("natural-language console intents resolve to the same business actions as buttons", () => {
  assertEquals(parseConsoleIntent("/today"), { type: "OPEN_RECOMMENDED", page: 1 });
  assertEquals(parseConsoleIntent("오늘 뭐 있어?"), { type: "OPEN_RECOMMENDED", page: 1 });
  assertEquals(parseConsoleIntent("오늘 새로 올라온 맨유 소식 뭐 있어?"), { type: "OPEN_RECOMMENDED", page: 1 });
  assertEquals(parseConsoleIntent("오늘 맨유 뉴스 요약해줘"), { type: "OPEN_RECOMMENDED", page: 1 });
  assertEquals(parseConsoleIntent("전체 수집한 거 보여줘"), { type: "OPEN_ALL", page: 1 });
  assertEquals(parseConsoleIntent("1"), { type: "OPEN_STORY", token: "1" });
  assertEquals(parseConsoleIntent("1번 소재 선택"), { type: "OPEN_STORY", token: "1" });
  assertEquals(parseConsoleIntent("첫 번째 소재"), { type: "OPEN_STORY", token: "1" });
  assertEquals(parseConsoleIntent("이거 카드뉴스로 만들어줘", story.id), { type: "GENERATE_CAROUSEL", token: story.id });
  assertEquals(parseConsoleIntent("이거 카드뉴스로 만들거야", story.id), { type: "GENERATE_CAROUSEL", token: story.id });
  assertEquals(parseConsoleIntent("카드뉴스 생성"), { type: "GENERATE_CAROUSEL", token: null });
  assertEquals(parseConsoleIntent("다음 거 보여줘"), { type: "NEXT_PAGE" });
  assertEquals(parseConsoleIntent("지금 뭐 뜨고 있어?"), { type: "OPEN_TRENDING", page: 1 });
  assertEquals(parseConsoleIntent("요즘 맨유 뭐가 핫해?"), { type: "OPEN_TRENDING", page: 1 });
  assertEquals(parseConsoleIntent("좀 더 찾아봐"), { type: "DISCOVER_MORE" });
  assertEquals(parseConsoleIntent("다른 거 더 없어?"), { type: "DISCOVER_MORE" });
  assertEquals(parseConsoleIntent("새로운 소재 찾아줘"), { type: "DISCOVER_MORE" });
  assertEquals(parseConsoleIntent("이건 그냥 의견이야"), null);
});

Deno.test("trending action uses injected trend ranking and keeps editorial actions separate", async () => {
  const trending = { ...story, trend_score: 94, trend_state: "RISING", platform_count: 3, opportunity_labels: ["🔥 빠르게 뜨는 중"] };
  const result = await dispatchEditorialConsoleAction({ type: "OPEN_TRENDING", page: 1 }, state(), dependencies({ listTrendingStories: async () => paginateStories([trending], 1) }));
  assert(result.view.text.includes("📈 지금 뜨는 소재"));
  assert(result.view.text.includes("Trend 94"));
  assert(result.view.text.includes("Editorial 91"));
  assertEquals(result.next_state.mode, "trending");
});

Deno.test("discover more invokes a fresh discovery run and returns deterministic status", async () => {
  let calls = 0;
  const result = await dispatchEditorialConsoleAction({ type: "DISCOVER_MORE" }, state(), dependencies({ discoverMore: async () => { calls += 1; return { status: "PARTIAL", run_id: "run-1", new_story_count: 2, provider_failures: 1 }; } }));
  assertEquals(calls, 1);
  assert(result.view.text.includes("새 discovery run"));
  assert(result.view.text.includes("2개"));
  assertEquals(result.event.action, "DISCOVERY_MORE_COMPLETED");
});

Deno.test("queued discovery tells the editor that results are pending", async () => {
  const result = await dispatchEditorialConsoleAction({ type: "DISCOVER_MORE" }, state(), dependencies({ discoverMore: async () => ({ status: "QUEUED", run_id: "job-1" }) }));
  assert(result.view.text.includes("대기열 등록됨"));
  assert(result.view.text.includes("백그라운드"));
  assertEquals(result.event.action, "DISCOVERY_MORE_QUEUED");
  assertEquals(result.event.status, "COMPLETED");
});

Deno.test("failed discovery enqueue returns a safe failure view", async () => {
  const result = await dispatchEditorialConsoleAction({ type: "DISCOVER_MORE" }, state(), dependencies({ discoverMore: async () => { throw new Error("queue unavailable"); } }));
  assert(result.view.text.includes("대기열에 등록하지 못했습니다"));
  assertEquals(result.event.action, "DISCOVERY_MORE_FAILED");
  assertEquals(result.event.status, "FAILED");
});

Deno.test("opening a story reloads canonical state and renders detail", async () => {
  const result = await dispatchEditorialConsoleAction({ type: "OPEN_STORY", token: story.id.replaceAll("-", "").slice(0, 12) }, state(), dependencies());
  assert(result.view.text.includes("산초, 3개월째 FA"));
  assertEquals(result.next_state.view, "DETAIL");
  assertEquals(result.next_state.story_id, story.id);
  assertEquals(result.event.action, "STORY_OPENED");
});

Deno.test("skip records an editorial decision and never deletes the canonical story", async () => {
  let skipped: string | null = null;
  const result = await dispatchEditorialConsoleAction({ type: "SKIP_STORY", token: story.id.replaceAll("-", "").slice(0, 12) }, state({ view: "DETAIL", story_id: story.id }), dependencies({ skipStory: async (value) => { skipped = value.story_fingerprint; } }));
  assertEquals(skipped, story.story_fingerprint);
  assert(result.view.text.includes("추천 소재"));
  assertEquals(result.event.action, "STORY_SKIPPED");
  assertFalse(result.event.metadata?.deleted === true);
});

Deno.test("card generation action calls the injected canonical service exactly once", async () => {
  let calls = 0;
  const result = await dispatchEditorialConsoleAction({ type: "GENERATE_CAROUSEL", token: story.id.replaceAll("-", "").slice(0, 12) }, state({ view: "DETAIL", story_id: story.id }), dependencies({ generateCarousel: async (value) => { calls += 1; assertEquals(value.id, story.id); return draft; } }));
  assertEquals(calls, 1);
  assert(result.view.text.includes("📱 카드뉴스 초안"));
  assertEquals(result.next_state.view, "DRAFT");
  assertEquals(result.next_state.brief_id, "brief-1");
  assertEquals(result.event.action, "CREATIVE_GENERATION_COMPLETED");
  assert(result.view.text.includes(story.title));
});

Deno.test("card generation tells the editor when the provider is rate limited", async () => {
  const result = await dispatchEditorialConsoleAction(
    { type: "GENERATE_CAROUSEL", token: story.id },
    state({ view: "DETAIL", story_id: story.id }),
    dependencies({ generateCarousel: async () => { throw new Error("PROVIDER_HTTP_429"); } }),
  );

  assert(result.view.text.includes("요청 한도"));
  assertEquals(result.event.action, "CREATIVE_GENERATION_FAILED");
  assertEquals(result.event.metadata?.error_code, "PROVIDER_HTTP_429");
});

Deno.test("card generation without a selected story never invokes the canonical generator", async () => {
  let calls = 0;
  const result = await dispatchEditorialConsoleAction({ type: "GENERATE_CAROUSEL", token: null }, state(), dependencies({ generateCarousel: async () => { calls += 1; return draft; } }));
  assertEquals(calls, 0);
  assert(result.view.text.includes("먼저 소재를 열어 주세요"));
  assertEquals(result.event.action, "CREATIVE_GENERATION_FAILED");
});

Deno.test("natural-language generation can reuse the story currently open in the console", async () => {
  let calls = 0;
  const result = await dispatchEditorialConsoleAction({ type: "GENERATE_CAROUSEL", token: null }, state({ view: "DETAIL", story_id: story.id }), dependencies({ generateCarousel: async (value) => { calls += 1; assertEquals(value.id, story.id); return draft; } }));
  assertEquals(calls, 1);
  assert(result.view.text.includes("📱 카드뉴스 초안"));
});

Deno.test("generation keeps VERIFIED, REPORTED, and DISCOVERY trust visible without changing canonical eligibility", async () => {
  const cases = [
    { trust: "VERIFIED", candidate: story },
    {
      trust: "REPORTED",
      candidate: { ...story, grounding_status: "INSUFFICIENT", news_eligible: false, evidence: [{ ...story.evidence[0]!, status: "REPORTED" as const, editorial_role: "FACT_PRIMARY", canonical_url: "https://bbc.test/sancho" }] },
    },
    {
      trust: "DISCOVERY",
      candidate: { ...story, grounding_status: "DISCOVERY_ONLY", news_eligible: false, evidence: [{ ...story.evidence[0]!, status: "REPORTED" as const, editorial_role: "DISCOVERY_COMPETITOR", canonical_url: "https://social.test/rumor" }] },
    },
  ] as Array<{ trust: string; candidate: CanonicalStory }>;

  for (const entry of cases) {
    let generationCalls = 0;
    const result = await dispatchEditorialConsoleAction(
      { type: "GENERATE_CAROUSEL", token: story.id },
      state({ view: "DETAIL", story_id: story.id }),
      dependencies({
        getStoryByToken: async () => entry.candidate,
        generateCarousel: async () => { generationCalls += 1; return draft; },
      }),
    );
    assertEquals(result.event.status, "COMPLETED");
    assertEquals(generationCalls, 1);
    assert(result.view.text.includes(entry.trust === "VERIFIED" ? "🟢 근거 매칭됨" : entry.trust === "REPORTED" ? "🟡 보도됨" : "🔴 미확인"));
    if (entry.trust !== "VERIFIED") assert(result.view.text.includes(entry.candidate.evidence[0]?.canonical_url ?? ""));
    assert(result.view.text.includes("산초 훈련 사진"));
    assertEquals(entry.candidate.news_eligible, entry.trust === "VERIFIED");
  }
});

Deno.test("card generation falls back to the console-selected story when the agent candidate is stale", async () => {
  let calls = 0;
  const result = await dispatchEditorialConsoleAction(
    { type: "GENERATE_CAROUSEL", token: "stale-agent-candidate" },
    state({ view: "DETAIL", story_id: story.id }),
    dependencies({
      getStoryByToken: async (token) => token === story.id ? story : null,
      generateCarousel: async (value) => { calls += 1; assertEquals(value.id, story.id); return draft; },
    }),
  );
  assertEquals(calls, 1);
  assert(result.view.text.includes("📱 카드뉴스 초안"));
});

Deno.test("card generation blocks candidates without verified public evidence", async () => {
  let calls = 0;
  const unsupported = { ...story, news_eligible: false, information_gap_score: 0, hook_strength: 0, shareability: 0, source_confidence: 0, evidence: [] };
  const result = await dispatchEditorialConsoleAction(
    { type: "GENERATE_CAROUSEL", token: story.id.replaceAll("-", "").slice(0, 12) },
    state({ view: "DETAIL", story_id: story.id }),
    dependencies({ getStoryByToken: async () => unsupported, generateCarousel: async () => { calls += 1; return draft; } }),
  );
  assertEquals(calls, 0);
  assert(result.view.text.includes("연결된 원문 근거"));
  assertEquals(result.event.action, "CREATIVE_GENERATION_BLOCKED");
});

Deno.test("card generation allows a linked discovery source but labels it unconfirmed", async () => {
  let calls = 0;
  const linkedButIneligible = { ...story, news_eligible: false, evidence: [{ ...story.evidence[0]!, editorial_role: "DISCOVERY_COMMUNITY", canonical_url: "https://example.test/source" }] };
  const result = await dispatchEditorialConsoleAction(
    { type: "GENERATE_CAROUSEL", token: story.id },
    state({ view: "DETAIL", story_id: story.id }),
    dependencies({ getStoryByToken: async () => linkedButIneligible, generateCarousel: async () => { calls += 1; return draft; } }),
  );
  assertEquals(calls, 1);
  assert(result.view.text.includes("🔴 미확인"));
  assert(result.view.text.includes("https://example.test/source"));
});

Deno.test("linked discovery source can generate a cautious draft even when all editorial scores are zero", async () => {
  let calls = 0;
  const linkedButUnscored = { ...story, news_eligible: false, information_gap_score: 0, hook_strength: 0, shareability: 0, evidence: [{ ...story.evidence[0]!, editorial_role: "DISCOVERY_COMMUNITY", canonical_url: "https://example.test/source" }] };
  const result = await dispatchEditorialConsoleAction(
    { type: "GENERATE_CAROUSEL", token: story.id },
    state({ view: "DETAIL", story_id: story.id }),
    dependencies({ getStoryByToken: async () => linkedButUnscored, generateCarousel: async () => { calls += 1; return draft; } }),
  );
  assertEquals(calls, 1);
  assert(result.view.text.includes("🔴 미확인"));
  assertEquals(result.event.action, "CREATIVE_GENERATION_COMPLETED");
});

Deno.test("back navigation returns from evidence and draft to the current story list safely", async () => {
  const evidence = await dispatchEditorialConsoleAction({ type: "BACK" }, state({ view: "EVIDENCE", story_id: story.id }), dependencies());
  assertEquals(evidence.next_state.view, "DETAIL");
  const draftBack = await dispatchEditorialConsoleAction({ type: "BACK" }, state({ view: "DRAFT", story_id: story.id, brief_id: "brief-1" }), dependencies());
  assertEquals(draftBack.next_state.view, "DETAIL");
});
