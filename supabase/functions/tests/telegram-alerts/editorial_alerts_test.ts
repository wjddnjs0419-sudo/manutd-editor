import assert from "node:assert/strict";
import { dispatchPendingAlerts } from "../../_shared/m6/alerts.ts";
import type { TelegramClient } from "../../_shared/m6/telegram_client.ts";

import {
  evaluateEditorialStoryAlert,
  editorialAlertMessageMetadata,
  hasCanonicalGrounding,
  materializeEditorialStoryAlerts,
  renderEditorialStoryAlert,
  selectPrimaryEditorialEvidence,
  type EditorialStoryAlertRepository,
  type EditorialStoryAlertRow,
  type StoryAlertStateRecord,
} from "../../telegram-alerts/editorial_alerts.ts";

const baseStory = (overrides: Partial<EditorialStoryAlertRow> = {}): EditorialStoryAlertRow => ({
  storyId: "story-1",
  title: "브루노 페르난데스 부상 우려",
  summary: "맨유 관련 최신 discovery signal",
  trendState: "RISING",
  trendScore: 82,
  relevanceScore: 94,
  sourceCount: 3,
  firstSeenAt: "2026-09-29T08:00:00.000Z",
  lastSeenAt: "2026-09-29T09:55:00.000Z",
  groundingStatus: "DISCOVERY_ONLY",
  newsEligible: false,
  rankingVersion: "m8-c-v1",
  ...overrides,
});

const emptyState = (): StoryAlertStateRecord => ({
  storyId: "story-1",
  observedState: null,
  lastAlertedState: null,
  lastAlertedAt: null,
  verifiedNotified: false,
});

Deno.test("RISING story crosses threshold once and stays quiet on repeat polling", () => {
  const now = new Date("2026-09-29T10:00:00.000Z");
  const first = evaluateEditorialStoryAlert(null, baseStory(), now);
  assert.equal(first.event?.eventType, "RISING_STORY");
  assert.equal(first.nextState.observedState, "RISING");
  assert.match(first.event?.eventFingerprint ?? "", /^RISING_STORY:story-1:/u);

  const repeat = evaluateEditorialStoryAlert(first.nextState, baseStory(), new Date("2026-09-29T10:10:00.000Z"));
  assert.equal(repeat.event, null);
  assert.equal(repeat.nextState.lastAlertedState, "RISING");
});

Deno.test("single trend and VERIFIED transitions each materialize one matching event", () => {
  const now = new Date("2026-09-29T10:00:00.000Z");
  assert.equal(evaluateEditorialStoryAlert(null, baseStory(), now).event?.eventType, "RISING_STORY");
  assert.equal(evaluateEditorialStoryAlert(null, baseStory({ trendState: "BREAKING", trendScore: 96 }), now).event?.eventType, "BREAKING_STORY");
  assert.equal(evaluateEditorialStoryAlert(null, baseStory({ trendState: null, trendScore: 0, groundingStatus: "VERIFIED", newsEligible: true }), now).event?.eventType, "VERIFIED_STORY");
});

Deno.test("state transition is cooldown-protected and VERIFIED is a separate one-time event", () => {
  const now = new Date("2026-09-29T10:00:00.000Z");
  const rising = evaluateEditorialStoryAlert(null, baseStory(), now);
  const breaking = evaluateEditorialStoryAlert(rising.nextState, baseStory({ trendState: "BREAKING", trendScore: 96 }), new Date("2026-09-29T10:20:00.000Z"));
  assert.equal(breaking.event, null);
  assert.equal(breaking.nextState.observedState, "BREAKING");

  const verified = evaluateEditorialStoryAlert(breaking.nextState, baseStory({ trendState: "BREAKING", trendScore: 96, groundingStatus: "VERIFIED", newsEligible: true }), new Date("2026-09-29T11:10:00.000Z"));
  assert.equal(verified.event?.eventType, "VERIFIED_STORY");
  assert.equal(verified.nextState.verifiedNotified, true);

  const repeatVerified = evaluateEditorialStoryAlert(verified.nextState, baseStory({ trendState: "BREAKING", trendScore: 96, groundingStatus: "VERIFIED", newsEligible: true }), new Date("2026-09-29T11:20:00.000Z"));
  assert.equal(repeatVerified.event, null);
});

Deno.test("stale or low-relevance stories do not alert", () => {
  const now = new Date("2026-09-29T10:00:00.000Z");
  assert.equal(evaluateEditorialStoryAlert(null, baseStory({ relevanceScore: 69 }), now).event, null);
  assert.equal(evaluateEditorialStoryAlert(null, baseStory({ lastSeenAt: "2026-09-28T10:00:00.000Z" }), now).event, null);
  assert.equal(evaluateEditorialStoryAlert(null, baseStory({ sourceCount: 1 }), now).event, null);
});

Deno.test("story alert action remains grounded when carousel evidence is insufficient", () => {
  const rendered = renderEditorialStoryAlert({
    eventType: "RISING_STORY",
    storyId: "story-1",
    title: "브루노 페르난데스 부상 우려",
    sourceCount: 3,
    trendState: "RISING",
    groundingStatus: "DISCOVERY_ONLY",
    newsEligible: false,
  });
  assert.match(rendered.text, /추가 확인 필요/u);
  assert.match(rendered.text, /검증된 근거가 부족/u);
  assert.equal(rendered.reply_markup?.inline_keyboard[0]?.[0]?.callback_data, "idea:carousel:story1");
  assert.equal(rendered.reply_markup?.inline_keyboard[1]?.[0]?.callback_data, "idea:evidence:story1");
});

Deno.test("materialization persists state and deduplicates event insertion", async () => {
  const states = new Map<string, StoryAlertStateRecord>();
  const inserted: string[] = [];
  const repository: EditorialStoryAlertRepository = {
    threadId: "thread-1",
    async listStories() { return [baseStory()]; },
    async getState(storyId) { return states.get(storyId) ?? null; },
    async saveState(state) { states.set(state.storyId, state); },
    async insertEvent(event) {
      if (inserted.includes(event.eventFingerprint)) return false;
      inserted.push(event.eventFingerprint);
      return true;
    },
  };
  const now = new Date("2026-09-29T10:00:00.000Z");
  assert.equal(await materializeEditorialStoryAlerts(now, repository), 1);
  assert.equal(await materializeEditorialStoryAlerts(new Date("2026-09-29T10:10:00.000Z"), repository), 0);
  assert.equal(inserted.length, 1);
});

Deno.test("story alert dispatch passes its inline keyboard to Telegram", async () => {
  let sentMarkup: unknown;
  let persisted: { messageId: number | null; eventType: string; storyId: string | null } | null = null;
  const client: TelegramClient = {
    sendText: async (_chatId, _text, markup) => { sentMarkup = markup; return { message_id: 42 }; },
    sendPhoto: async () => ({ message_id: 42 }),
    editMessageText: async () => ({ message_id: 42 }),
    answerCallbackQuery: async () => undefined,
  };
  const result = await dispatchPendingAlerts({
    listPending: async () => [{ id: "event-1", event_type: "RISING_STORY", payload: { story_id: "story-1", title: "Story", source_count: 2, trend_state: "RISING", grounding_status: "DISCOVERY_ONLY", news_eligible: false } }],
    resolveChatId: async () => "chat-1",
    client,
    markSent: async () => undefined,
    markFailed: async () => undefined,
    persistSentMessage: async (alert, messageId) => { persisted = { messageId, eventType: alert.event_type, storyId: typeof alert.payload.story_cluster_id === "string" ? alert.payload.story_cluster_id : null }; },
  });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  const keyboard = (sentMarkup as { inline_keyboard?: { callback_data: string }[][] } | undefined)?.inline_keyboard ?? [];
  assert.deepEqual(keyboard.flat().map((button) => button.callback_data), [
    "idea:carousel:story1",
    "idea:reel:story1",
    "idea:evidence:story1",
    "idea:skip:story1",
  ]);
  assert.deepEqual(persisted, { messageId: 42, eventType: "RISING_STORY", storyId: null });
});

Deno.test("sent alert stays delivered when canonical message persistence fails", async () => {
  let sent = 0;
  let failed = 0;
  const result = await dispatchPendingAlerts({
    listPending: async () => [{ id: "event-1", event_type: "RISING_STORY", payload: { story_id: "story-1", title: "Story", source_count: 1, trend_state: "RISING", grounding_status: "DISCOVERY_ONLY", news_eligible: false } }],
    resolveChatId: async () => "chat-1",
    client: { sendText: async () => ({ message_id: 43 }), sendPhoto: async () => ({ message_id: 43 }), editMessageText: async () => ({ message_id: 43 }), answerCallbackQuery: async () => undefined },
    markSent: async () => { sent += 1; },
    markFailed: async () => { failed += 1; },
    persistSentMessage: async () => { throw new Error("PERSISTENCE_UNAVAILABLE"); },
  });
  assert.deepEqual(result, { attempted: 1, sent: 1, failed: 0 });
  assert.equal(sent, 1);
  assert.equal(failed, 0);
});

Deno.test("simultaneous BREAKING and VERIFIED transitions emit one VERIFIED event and preserve trend state", async () => {
  const inserted: string[] = [];
  let state: StoryAlertStateRecord = emptyState();
  const repository: EditorialStoryAlertRepository = {
    threadId: "thread-1",
    async listStories() { return [baseStory({ trendState: "BREAKING", trendScore: 96, groundingStatus: "VERIFIED", newsEligible: true })]; },
    async getState() { return state; },
    async saveState(next) { state = next; },
    async insertEvent(event) { inserted.push(event.eventType); return true; },
  };
  assert.equal(await materializeEditorialStoryAlerts(new Date("2026-09-29T10:00:00.000Z"), repository), 1);
  assert.deepEqual(inserted, ["VERIFIED_STORY"]);
  assert.equal(state.observedState, "BREAKING");
  assert.equal(state.lastAlertedState, "BREAKING");
  assert.equal(state.verifiedNotified, true);
  assert.equal(await materializeEditorialStoryAlerts(new Date("2026-09-29T10:10:00.000Z"), repository), 0);
});

Deno.test("simultaneous RISING and VERIFIED transitions emit one VERIFIED event and do not resend trend", async () => {
  const inserted: string[] = [];
  let state: StoryAlertStateRecord = emptyState();
  const repository: EditorialStoryAlertRepository = {
    threadId: "thread-1",
    async listStories() { return [baseStory({ trendState: "RISING", trendScore: 82, groundingStatus: "VERIFIED", newsEligible: true })]; },
    async getState() { return state; },
    async saveState(next) { state = next; },
    async insertEvent(event) { inserted.push(event.eventType); return true; },
  };
  assert.equal(await materializeEditorialStoryAlerts(new Date("2026-09-29T10:00:00.000Z"), repository), 1);
  assert.deepEqual(inserted, ["VERIFIED_STORY"]);
  assert.equal(state.observedState, "RISING");
  assert.equal(state.lastAlertedState, "RISING");
  assert.equal(await materializeEditorialStoryAlerts(new Date("2026-09-29T10:10:00.000Z"), repository), 0);
  assert.deepEqual(inserted, ["VERIFIED_STORY"]);
});

Deno.test("news eligibility alone never invites carousel generation without VERIFIED grounding", () => {
  const rendered = renderEditorialStoryAlert({ eventType: "RISING_STORY", storyId: "story-1", title: "Story", sourceCount: 2, trendState: "RISING", groundingStatus: "DISCOVERY_ONLY", newsEligible: true });
  assert.match(rendered.text, /카드뉴스를 아직 생성하지 않습니다/u);
  assert.match(rendered.reply_markup.inline_keyboard[0]?.[0]?.text ?? "", /검증 필요/u);
});

Deno.test("canonical evidence prefers grounded fact sources and keeps source identity", () => {
  const evidence = [
    { claim_id: "claim-discovery", source_observation_id: "obs-community", source_name: "Reddit", canonical_url: "https://reddit.example/story", editorial_role: "DISCOVERY_COMMUNITY", is_grounding: false },
    { claim_id: "claim-fact", source_observation_id: "obs-yahoo", source_name: "Yahoo Sports", canonical_url: "https://sports.yahoo.com/story", editorial_role: "FACT_PRIMARY", is_grounding: true },
  ];
  assert.equal(selectPrimaryEditorialEvidence(evidence)?.source_observation_id, "obs-yahoo");
  assert.equal(selectPrimaryEditorialEvidence(evidence)?.source_name, "Yahoo Sports");
  assert.equal(hasCanonicalGrounding(evidence), true);
});

Deno.test("discovery-only evidence never qualifies as canonical grounding", () => {
  const evidence = [{ claim_id: "claim-discovery", source_observation_id: "obs-community", source_name: "Reddit", canonical_url: "https://reddit.example/story", editorial_role: "DISCOVERY_COMMUNITY", is_grounding: false }];
  assert.equal(hasCanonicalGrounding(evidence), false);
  const rendered = renderEditorialStoryAlert({ eventType: "VERIFIED_STORY", storyId: "story-1", title: "Story", sourceCount: 1, trendState: "RISING", groundingStatus: "VERIFIED", newsEligible: true, groundingEvidenceAvailable: false, primarySourceName: "Reddit", primarySourceUrl: evidence[0].canonical_url });
  assert.match(rendered.text, /팩트 확인: 추가 확인 필요/u);
  assert.doesNotMatch(rendered.text, /카드뉴스 생성 조건을 충족했습니다/u);
});

Deno.test("missing canonical URL renders safely without inventing a link", () => {
  const rendered = renderEditorialStoryAlert({ eventType: "VERIFIED_STORY", storyId: "story-1", title: "Story", sourceCount: 1, trendState: "BREAKING", groundingStatus: "VERIFIED", newsEligible: true, groundingEvidenceAvailable: true, primarySourceName: "Yahoo Sports", primarySourceUrl: null });
  assert.match(rendered.text, /출처: Yahoo Sports/u);
  assert.doesNotMatch(rendered.text, /https?:\/\//u);
});

Deno.test("materialized alert payload carries canonical story, candidate, and source identity", async () => {
  const stored: Record<string, unknown>[] = [];
  const repository: EditorialStoryAlertRepository = {
    threadId: "thread-1",
    async listStories() {
      return [baseStory({ candidateId: "candidate-1", primarySourceName: "Yahoo Sports", primarySourceUrl: "https://sports.yahoo.com/story", primarySourceObservationId: "observation-1", primaryClaimId: "claim-1", groundingStatus: "VERIFIED", newsEligible: true, groundingEvidenceAvailable: true, rankingDate: "2026-09-29" })];
    },
    async getState() { return null; },
    async saveState() { return undefined; },
    async insertEvent(event) { stored.push(event.payload); return true; },
  };
  await materializeEditorialStoryAlerts(new Date("2026-09-29T10:00:00.000Z"), repository);
  assert.equal(stored.length, 1);
  const payload = stored[0]!;
  assert.equal(payload.story_cluster_id, "story-1");
  assert.equal(payload.candidate_id, "candidate-1");
  assert.equal(payload.primary_source_name, "Yahoo Sports");
  assert.equal(payload.primary_source_url, "https://sports.yahoo.com/story");
  assert.equal(payload.primary_source_observation_id, "observation-1");
  assert.equal(payload.ranking_date, "2026-09-29");
  assert.equal(payload.ranking_version, "m8-c-v1");
});

Deno.test("editorial alert message metadata preserves ranking identity", () => {
  assert.deepEqual(editorialAlertMessageMetadata("VERIFIED_STORY", {
    story_cluster_id: "story-1",
    candidate_id: "candidate-1",
    primary_source_observation_id: "observation-1",
    ranking_date: "2026-09-29",
    ranking_version: "m8-v1",
  }), {
    message_kind: "EDITORIAL_STORY_ALERT",
    story_cluster_id: "story-1",
    candidate_id: "candidate-1",
    primary_source_observation_id: "observation-1",
    event_type: "VERIFIED_STORY",
    ranking_date: "2026-09-29",
    ranking_version: "m8-v1",
    evidence_ids: [],
  });
});
