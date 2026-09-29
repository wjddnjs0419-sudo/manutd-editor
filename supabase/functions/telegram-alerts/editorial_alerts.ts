import type { TelegramInlineKeyboardMarkup } from "../_shared/m6/telegram_client.ts";

export type StoryAlertState = "RISING" | "BREAKING";
export type EditorialStoryAlertType = "BREAKING_STORY" | "RISING_STORY" | "VERIFIED_STORY";

export interface EditorialStoryAlertRow {
  readonly storyId: string;
  readonly title: string;
  readonly summary: string | null;
  readonly trendState: string | null;
  readonly trendScore: number | null;
  readonly relevanceScore: number | null;
  readonly sourceCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly groundingStatus: string;
  readonly newsEligible: boolean;
  readonly rankingVersion: string | null;
}

export interface StoryAlertStateRecord {
  readonly storyId: string;
  readonly observedState: StoryAlertState | null;
  readonly lastAlertedState: StoryAlertState | null;
  readonly lastAlertedAt: string | null;
  readonly verifiedNotified: boolean;
}

export interface EditorialStoryAlertEvent {
  readonly eventType: EditorialStoryAlertType;
  readonly eventFingerprint: string;
  readonly storyId: string;
  readonly payload: Record<string, unknown>;
}

export interface EditorialStoryAlertRepository {
  readonly threadId: string;
  listStories(now: Date): Promise<readonly EditorialStoryAlertRow[]>;
  getState(storyId: string): Promise<StoryAlertStateRecord | null>;
  saveState(state: StoryAlertStateRecord): Promise<void>;
  insertEvent(event: {
    threadId: string;
    storyId: string;
    eventType: EditorialStoryAlertType;
    eventFingerprint: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface RenderedEditorialStoryAlert {
  readonly text: string;
  readonly replyMarkup: TelegramInlineKeyboardMarkup;
}

export interface EditorialStoryAlertDecision {
  readonly nextState: StoryAlertStateRecord;
  readonly event: EditorialStoryAlertEvent | null;
}

const COOLDOWN_MS = 60 * 60 * 1000;
const FRESHNESS_MS = 6 * 60 * 60 * 1000;
const MIN_RELEVANCE = 70;
const MIN_TREND_SCORE = 65;
const MIN_SOURCE_COUNT = 2;

function isFresh(story: EditorialStoryAlertRow, now: Date): boolean {
  const lastSeen = Date.parse(story.lastSeenAt);
  return Number.isFinite(lastSeen) && lastSeen <= now.getTime() && now.getTime() - lastSeen <= FRESHNESS_MS;
}

function alertState(story: EditorialStoryAlertRow, now: Date): StoryAlertState | null {
  if (!isFresh(story, now) || (story.relevanceScore ?? 0) < MIN_RELEVANCE || (story.trendScore ?? 0) < MIN_TREND_SCORE || story.sourceCount < MIN_SOURCE_COUNT) return null;
  if (story.trendState === "BREAKING" && (story.trendScore ?? 0) >= 75) return "BREAKING";
  if (story.trendState === "RISING" || story.trendState === "HOT") return "RISING";
  return null;
}

function defaultState(storyId: string): StoryAlertStateRecord {
  return { storyId, observedState: null, lastAlertedState: null, lastAlertedAt: null, verifiedNotified: false };
}

function withinCooldown(previous: StoryAlertStateRecord, now: Date): boolean {
  if (!previous.lastAlertedAt) return false;
  const lastAlerted = Date.parse(previous.lastAlertedAt);
  return Number.isFinite(lastAlerted) && now.getTime() - lastAlerted < COOLDOWN_MS;
}

function fingerprint(type: EditorialStoryAlertType, story: EditorialStoryAlertRow): string {
  if (type === "VERIFIED_STORY") return `${type}:${story.storyId}:${story.rankingVersion ?? "current"}`;
  return `${type}:${story.storyId}:${story.lastSeenAt}`;
}

function eventFor(type: EditorialStoryAlertType, story: EditorialStoryAlertRow): EditorialStoryAlertEvent {
  return {
    eventType: type,
    eventFingerprint: fingerprint(type, story),
    storyId: story.storyId,
    payload: {
      story_id: story.storyId,
      title: story.title,
      summary: story.summary,
      source_count: story.sourceCount,
      trend_state: story.trendState,
      trend_score: story.trendScore,
      relevance_score: story.relevanceScore,
      first_seen_at: story.firstSeenAt,
      last_seen_at: story.lastSeenAt,
      grounding_status: story.groundingStatus,
      news_eligible: story.newsEligible,
      ranking_version: story.rankingVersion,
    },
  };
}

export function evaluateEditorialStoryAlert(
  previous: StoryAlertStateRecord | null,
  story: EditorialStoryAlertRow,
  now: Date,
): EditorialStoryAlertDecision {
  const prior = previous ?? defaultState(story.storyId);
  const nextObservedState = alertState(story, now);
  let event: EditorialStoryAlertEvent | null = null;
  let lastAlertedState = prior.lastAlertedState;
  let lastAlertedAt = prior.lastAlertedAt;

  if (nextObservedState && nextObservedState !== prior.observedState && !withinCooldown(prior, now)) {
    const type: EditorialStoryAlertType = nextObservedState === "BREAKING" ? "BREAKING_STORY" : "RISING_STORY";
    event = eventFor(type, story);
    lastAlertedState = nextObservedState;
    lastAlertedAt = now.toISOString();
  }

  if (story.groundingStatus === "VERIFIED" && !prior.verifiedNotified) {
    event = eventFor("VERIFIED_STORY", story);
  }

  return {
    nextState: {
      storyId: story.storyId,
      observedState: nextObservedState,
      lastAlertedState,
      lastAlertedAt,
      verifiedNotified: prior.verifiedNotified || story.groundingStatus === "VERIFIED",
    },
    event,
  };
}

function storyToken(storyId: string): string {
  return storyId.length <= 32 ? storyId : storyId.replaceAll("-", "").slice(0, 12);
}

export function renderEditorialStoryAlert(payload: {
  eventType: EditorialStoryAlertType;
  storyId: string;
  title: string;
  sourceCount: number;
  trendState: string | null;
  groundingStatus: string;
  newsEligible: boolean;
}): RenderedEditorialStoryAlert {
  const token = storyToken(payload.storyId);
  const verified = payload.groundingStatus === "VERIFIED";
  const evidenceLine = verified ? "팩트 확인: VERIFIED" : "팩트 확인: 추가 확인 필요";
  const actionLine = payload.newsEligible
    ? "카드뉴스 생성 조건을 충족했습니다."
    : "검증된 근거가 부족해 카드뉴스를 아직 생성하지 않습니다.";
  const prefix = payload.eventType === "VERIFIED_STORY" ? "✅ 확인된 맨유 이슈" : "🚨 새 맨유 이슈";
  return {
    text: [prefix, "", payload.title, `출처: ${payload.sourceCount}곳`, `상태: ${payload.trendState ?? "DISCOVERY"}`, evidenceLine, actionLine].join("\n"),
    replyMarkup: {
      inline_keyboard: [[
        { text: payload.newsEligible ? "📝 카드뉴스" : "📝 카드뉴스 (검증 필요)", callback_data: `idea:carousel:${token}` },
        { text: "🎬 릴스 초안", callback_data: `idea:reel:${token}` },
        { text: "🔎 근거 확인", callback_data: `idea:evidence:${token}` },
        { text: "❌ 무시", callback_data: `idea:skip:${token}` },
      ]],
    },
  };
}

export async function materializeEditorialStoryAlerts(now: Date, repository: EditorialStoryAlertRepository): Promise<number> {
  let created = 0;
  for (const story of await repository.listStories(now)) {
    const decision = evaluateEditorialStoryAlert(await repository.getState(story.storyId), story, now);
    if (decision.event) {
      const inserted = await repository.insertEvent({ threadId: repository.threadId, storyId: decision.event.storyId, eventType: decision.event.eventType, eventFingerprint: decision.event.eventFingerprint, payload: decision.event.payload });
      if (inserted) created += 1;
    }
    await repository.saveState(decision.nextState);
  }
  return created;
}
