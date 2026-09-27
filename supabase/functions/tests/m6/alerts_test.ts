import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import {
  applyCandidateAlertTransition,
  buildIntelligenceCompleteFingerprint,
  dispatchPendingAlerts,
  renderIntelligenceCompleteSummary,
  type CandidateAlertState,
  type IntelligenceSummaryInput,
} from "../../_shared/m6/alerts.ts";
import type { TelegramClient } from "../../_shared/m6/telegram_client.ts";

Deno.test("candidate alert transitions only emit on false to true", () => {
  let state: CandidateAlertState = { first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 0 };
  let result = applyCandidateAlertTransition(state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events, [{ type: "FIRST_MOVER", transition: 1, fingerprint: "FIRST_MOVER:candidate-1:1" }]);
  state = result.state;
  result = applyCandidateAlertTransition(state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events, []);
  state = result.state;
  result = applyCandidateAlertTransition(state, { first_mover_flag: false, must_cover_flag: false });
  assertEquals(result.events, []);
  result = applyCandidateAlertTransition(result.state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events[0]?.fingerprint, "FIRST_MOVER:candidate-1:2");
});

Deno.test("MUST_COVER transition has independent counter", () => {
  const result = applyCandidateAlertTransition(
    { first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 3 },
    { first_mover_flag: false, must_cover_flag: true },
    "candidate-2",
  );
  assertEquals(result.events[0]?.fingerprint, "MUST_COVER:candidate-2:4");
});

const summary: IntelligenceSummaryInput = {
  business_date: "2026-09-27",
  ranking_version: "m8-v1",
  stories: [
    { story_id: "story-1", title: "산초, 3개월째 FA", rank: 1, editorial_score: 91.2, information_gap_score: 94, discovery_audience_signal_score: 88, grounding_status: "VERIFIED", news_eligible: true },
    { story_id: "story-2", title: "가르나초 최근 4경기 0분", rank: 6, editorial_score: 88.1, information_gap_score: 88, discovery_audience_signal_score: 90, grounding_status: "DISCOVERY_ONLY", news_eligible: false },
  ],
};

Deno.test("intelligence summary fingerprint ignores run metadata and changes on canonical story changes", () => {
  assertEquals(buildIntelligenceCompleteFingerprint(summary), buildIntelligenceCompleteFingerprint({ ...summary, stories: summary.stories.map((story) => ({ ...story })) }));
  assert(buildIntelligenceCompleteFingerprint(summary) !== buildIntelligenceCompleteFingerprint({ ...summary, stories: [{ ...summary.stories[0]!, information_gap_score: 95 }, summary.stories[1]!] }));
});

Deno.test("intelligence summary is one compact message with two navigation buttons", () => {
  const rendered = renderIntelligenceCompleteSummary({ ...summary, stories: [{ ...summary.stories[0]!, title: "sir_alex_ferguson pep_guardiola manchester_united" }, summary.stories[1]!] });
  assert(rendered.text.includes("새롭게 확인된 소재 2개"));
  assert(rendered.text.includes("추천 후보 1개"));
  assert(rendered.text.includes("퍼거슨 · 과르디올라 · 맨유 관련 소재"));
  assert(!rendered.text.includes("sir_alex_ferguson"));
  assertEquals(rendered.reply_markup!.inline_keyboard[0], [
    { text: "🔥 추천 소재", callback_data: "ideas:recommended:1" },
    { text: "📚 전체 소재", callback_data: "ideas:all:1" },
  ]);
});

Deno.test("summary alert dispatch sends inline markup and marks one event sent", async () => {
  let markup: unknown;
  let sent = 0;
  const client: TelegramClient = {
    sendText: async (_chatId, _text, replyMarkup) => { markup = replyMarkup; sent += 1; return { message_id: 1 }; },
    sendPhoto: async () => ({ message_id: 1 }),
    editMessageText: async () => ({ message_id: 1 }),
    answerCallbackQuery: async () => undefined,
  };
  const result = await dispatchPendingAlerts({
    listPending: async () => [{ id: "event-1", event_type: "INTELLIGENCE_COMPLETE", payload: summary as unknown as Record<string, unknown> }],
    resolveChatId: async () => "chat-1",
    client,
    markSent: async () => undefined,
    markFailed: async () => undefined,
  });
  assertEquals(result, { attempted: 1, sent: 1, failed: 0 });
  assertEquals(sent, 1);
  assertEquals(markup, renderIntelligenceCompleteSummary(summary).reply_markup);
});
