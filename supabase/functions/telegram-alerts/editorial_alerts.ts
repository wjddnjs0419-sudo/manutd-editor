import type { TelegramInlineKeyboardMarkup } from "../_shared/m6/telegram_client.ts";
import { callbackData } from "../_shared/m6/editorial_console.ts";

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
  readonly rankingDate?: string | null;
  readonly rankingVersion: string | null;
  readonly candidateId?: string | null;
  readonly primarySourceName?: string | null;
  readonly primarySourceUrl?: string | null;
  readonly primarySourceObservationId?: string | null;
  readonly primaryClaimId?: string | null;
  readonly groundingEvidenceAvailable?: boolean;
  readonly trustState?: "VERIFIED" | "REPORTED" | "DISCOVERY";
  readonly materialFingerprint?: string;
}

export interface CanonicalEditorialEvidence {
  readonly claim_id?: string | null;
  readonly source_observation_id?: string | null;
  readonly source_name?: string | null;
  readonly canonical_url?: string | null;
  readonly editorial_role?: string | null;
  readonly is_grounding?: boolean;
  readonly claim_text?: string | null;
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
  readonly candidateId?: string | null;
  readonly payload: Record<string, unknown>;
}

const FACT_ROLES = new Set(["FACT_PRIMARY", "FACT_INDEPENDENT"]);

function evidencePriority(evidence: CanonicalEditorialEvidence): number {
  if (evidence.is_grounding === true && FACT_ROLES.has(evidence.editorial_role ?? "")) return 0;
  if (evidence.editorial_role === "FACT_PRIMARY") return 1;
  if (evidence.editorial_role === "FACT_INDEPENDENT") return 2;
  return 3;
}

export function selectPrimaryEditorialEvidence(
  evidence: readonly CanonicalEditorialEvidence[],
): CanonicalEditorialEvidence | null {
  return evidence
    .filter((item) => typeof item.source_observation_id === "string" && item.source_observation_id.trim() !== "")
    .map((item, index) => ({ item, index }))
    .sort((left, right) => evidencePriority(left.item) - evidencePriority(right.item) || left.index - right.index)[0]?.item ?? null;
}

export function hasCanonicalGrounding(evidence: readonly CanonicalEditorialEvidence[]): boolean {
  return evidence.some((item) => item.is_grounding === true && FACT_ROLES.has(item.editorial_role ?? ""));
}

export interface EditorialStoryAlertRepository {
  readonly threadId: string;
  listStories(now: Date): Promise<readonly EditorialStoryAlertRow[]>;
  getState(storyId: string): Promise<StoryAlertStateRecord | null>;
  saveState(state: StoryAlertStateRecord): Promise<void>;
  insertEvent(event: {
    threadId: string;
    storyId: string;
    candidateId?: string | null;
    eventType: EditorialStoryAlertType;
    eventFingerprint: string;
    payload: Record<string, unknown>;
  }): Promise<boolean>;
}

export interface RenderedEditorialStoryAlert {
  readonly text: string;
  readonly reply_markup: TelegramInlineKeyboardMarkup;
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
    candidateId: story.candidateId ?? null,
    payload: {
      story_id: story.storyId,
      story_cluster_id: story.storyId,
      candidate_id: story.candidateId ?? null,
      title: story.title,
      summary: story.summary,
      source_count: story.sourceCount,
      trend_state: story.trendState,
      trend_score: story.trendScore,
      relevance_score: story.relevanceScore,
      first_seen_at: story.firstSeenAt,
      last_seen_at: story.lastSeenAt,
      grounding_status: story.groundingStatus,
      news_eligible: story.newsEligible && story.groundingEvidenceAvailable !== false,
      ranking_date: story.rankingDate ?? null,
      ranking_version: story.rankingVersion,
      primary_source_name: story.primarySourceName ?? null,
      primary_source_url: story.primarySourceUrl ?? null,
      primary_source_observation_id: story.primarySourceObservationId ?? null,
      primary_claim_id: story.primaryClaimId ?? null,
      grounding_evidence_available: story.groundingEvidenceAvailable ?? null,
    },
  };
}

export function editorialAlertMessageMetadata(eventType: string, payload: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;
  return {
    message_kind: "EDITORIAL_STORY_ALERT",
    story_cluster_id: text(payload.story_cluster_id) ?? text(payload.story_id),
    candidate_id: text(payload.candidate_id),
    primary_source_observation_id: text(payload.primary_source_observation_id),
    event_type: eventType,
    ranking_date: text(payload.ranking_date),
    ranking_version: text(payload.ranking_version),
    evidence_ids: [],
  };
}

export function evaluateEditorialStoryAlert(
  previous: StoryAlertStateRecord | null,
  story: EditorialStoryAlertRow,
  now: Date,
): EditorialStoryAlertDecision {
  const prior = previous ?? defaultState(story.storyId);
  const nextObservedState = alertState(story, now);
  const trendTransition = nextObservedState !== null && nextObservedState !== prior.observedState;
  const verifiedTransition = story.groundingStatus === "VERIFIED" && !prior.verifiedNotified;
  let trendEvent: EditorialStoryAlertEvent | null = null;
  let lastAlertedState = prior.lastAlertedState;
  let lastAlertedAt = prior.lastAlertedAt;

  if (trendTransition && !withinCooldown(prior, now)) {
    const type: EditorialStoryAlertType = nextObservedState === "BREAKING" ? "BREAKING_STORY" : "RISING_STORY";
    trendEvent = eventFor(type, story);
    lastAlertedState = nextObservedState;
    lastAlertedAt = now.toISOString();
  }

  if (trendTransition && verifiedTransition) {
    lastAlertedState = nextObservedState;
    lastAlertedAt = now.toISOString();
  }

  const event = verifiedTransition ? eventFor("VERIFIED_STORY", story) : trendEvent;

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

export function renderEditorialStoryAlert(payload: {
  eventType: EditorialStoryAlertType;
  storyId: string;
  title: string;
  sourceCount: number;
  trendState: string | null;
  groundingStatus: string;
  newsEligible: boolean;
  groundingEvidenceAvailable?: boolean;
  primarySourceName?: string | null;
  primarySourceUrl?: string | null;
}): RenderedEditorialStoryAlert {
  const verified = payload.groundingStatus === "VERIFIED" && payload.groundingEvidenceAvailable === true;
  const canGenerate = verified && payload.newsEligible;
  const evidenceLine = verified ? "팩트 확인: VERIFIED" : "팩트 확인: 추가 확인 필요";
  const actionLine = canGenerate
    ? "카드뉴스 생성 조건을 충족했습니다."
    : "검증된 근거가 부족해 카드뉴스를 아직 생성하지 않습니다.";
  const prefix = payload.eventType === "VERIFIED_STORY" ? "✅ 확인된 맨유 이슈" : "🚨 새 맨유 이슈";
  const sourceName = payload.primarySourceName?.trim() || (payload.sourceCount > 0 ? `${payload.sourceCount}곳` : "확인 중");
  const sourceUrl = payload.primarySourceUrl?.trim() || null;
  return {
    text: [prefix, "", payload.title, `출처: ${sourceName}`, ...(sourceUrl ? [`🔗 원문: ${sourceUrl}`] : []), `상태: ${payload.trendState ?? "DISCOVERY"}`, evidenceLine, actionLine].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: canGenerate ? "📝 카드뉴스 생성" : "📝 카드뉴스 (검증 필요)", callback_data: callbackData("idea:carousel", payload.storyId) },
          { text: "🎬 릴스 초안", callback_data: callbackData("idea:reel", payload.storyId) },
        ],
        [
          { text: "🔎 근거 확인", callback_data: callbackData("idea:evidence", payload.storyId) },
          { text: "❌ 무시", callback_data: callbackData("idea:skip", payload.storyId) },
        ],
      ],
    },
  };
}

export async function materializeEditorialStoryAlerts(now: Date, repository: EditorialStoryAlertRepository): Promise<number> {
  let created = 0;
  for (const story of await repository.listStories(now)) {
    const decision = evaluateEditorialStoryAlert(await repository.getState(story.storyId), story, now);
    const event = decision.event;
    if (event) {
      const inserted = await repository.insertEvent({ threadId: repository.threadId, storyId: event.storyId, candidateId: event.candidateId ?? null, eventType: event.eventType, eventFingerprint: event.eventFingerprint, payload: event.payload });
      if (inserted) created += 1;
    }
    await repository.saveState(decision.nextState);
  }
  return created;
}
