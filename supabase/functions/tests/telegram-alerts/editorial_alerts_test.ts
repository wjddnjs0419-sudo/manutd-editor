import assert from "node:assert/strict";

import {
  evaluateEditorialStoryAlert,
  materializeEditorialStoryAlerts,
  renderEditorialStoryAlert,
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
  assert.equal(rendered.replyMarkup?.inline_keyboard[0]?.[0]?.callback_data, "idea:carousel:story-1");
  assert.equal(rendered.replyMarkup?.inline_keyboard[0]?.[2]?.callback_data, "idea:evidence:story-1");
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
