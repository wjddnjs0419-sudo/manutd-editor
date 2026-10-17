import type { TelegramClient, TelegramInlineKeyboardMarkup } from "./telegram_client.ts";
import { displayStoryTitle } from "../m8/story_display.ts";
import { renderEditorialStoryAlert } from "../../telegram-alerts/editorial_alerts.ts";
import { renderEditorialDigest } from "../../telegram-alerts/editorial_digest.ts";

export interface CandidateAlertState {
  first_mover_flag: boolean;
  must_cover_flag: boolean;
  first_mover_transition: number;
  must_cover_transition: number;
}

export interface CandidateAlertEvent {
  type: "FIRST_MOVER" | "MUST_COVER";
  transition: number;
  fingerprint: string;
}

export function applyCandidateAlertTransition(
  previous: CandidateAlertState,
  next: Pick<CandidateAlertState, "first_mover_flag" | "must_cover_flag">,
  candidateId = "candidate-1",
): { state: CandidateAlertState; events: CandidateAlertEvent[] } {
  const firstTransition = !previous.first_mover_flag && next.first_mover_flag ? previous.first_mover_transition + 1 : previous.first_mover_transition;
  const mustTransition = !previous.must_cover_flag && next.must_cover_flag ? previous.must_cover_transition + 1 : previous.must_cover_transition;
  const events: CandidateAlertEvent[] = [];
  if (!previous.first_mover_flag && next.first_mover_flag) events.push({ type: "FIRST_MOVER", transition: firstTransition, fingerprint: `FIRST_MOVER:${candidateId}:${firstTransition}` });
  if (!previous.must_cover_flag && next.must_cover_flag) events.push({ type: "MUST_COVER", transition: mustTransition, fingerprint: `MUST_COVER:${candidateId}:${mustTransition}` });
  return { state: { ...previous, ...next, first_mover_transition: firstTransition, must_cover_transition: mustTransition }, events };
}

export interface PendingAlert {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  thread_id?: string | null;
  attempt_count?: number;
  max_attempt_count?: number;
}

export interface IntelligenceSummaryStory {
  story_id: string;
  title: string;
  rank: number | null;
  editorial_score: number;
  information_gap_score: number;
  discovery_audience_signal_score: number;
  grounding_status: string;
  news_eligible: boolean;
}

export interface IntelligenceSummaryInput {
  business_date: string;
  ranking_version: string;
  stories: readonly IntelligenceSummaryStory[];
}

export interface RenderedAlert {
  text: string;
  reply_markup?: TelegramInlineKeyboardMarkup;
}

export function buildIntelligenceCompleteFingerprint(input: IntelligenceSummaryInput): string {
  const stableStories = [...input.stories].map((story) => ({
    story_id: story.story_id,
    rank: story.rank,
    editorial_score: story.editorial_score,
    information_gap_score: story.information_gap_score,
    discovery_audience_signal_score: story.discovery_audience_signal_score,
    grounding_status: story.grounding_status,
    news_eligible: story.news_eligible,
  }));
  return `INTELLIGENCE_COMPLETE:${input.business_date}:${input.ranking_version}:${JSON.stringify(stableStories)}`;
}

function intelligenceSummary(input: IntelligenceSummaryInput): RenderedAlert {
  const stories = [...input.stories].sort((left, right) => (left.rank === null ? 1 : right.rank === null ? -1 : left.rank - right.rank));
  const recommended = stories.filter((story) => story.rank !== null && story.rank <= 5);
  const top = stories[0];
  const text = [
    "📡 오늘의 맨유 인텔리전스",
    "",
    `새롭게 확인된 소재 ${stories.length}개`,
    `추천 후보 ${recommended.length}개`,
    top ? `\n🔥 가장 유력한 소재\n${displayStoryTitle(top.title)}` : "",
  ].filter((line) => line !== "").join("\n");
  return {
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: "🔥 추천 소재", callback_data: "ideas:recommended:1" },
        { text: "📚 전체 소재", callback_data: "ideas:all:1" },
      ]],
    },
  };
}

export function renderIntelligenceCompleteSummary(input: IntelligenceSummaryInput): RenderedAlert {
  return intelligenceSummary(input);
}

export interface AlertDispatchSummary {
  attempted: number;
  sent: number;
  failed: number;
}

export interface AlertDispatchDependencies {
  listPending: () => Promise<readonly PendingAlert[]>;
  resolveChatId: (alert: PendingAlert) => Promise<string | number>;
  client: TelegramClient;
  markSent: (id: string, sentAt: string) => Promise<void>;
  markFailed: (id: string, message: string) => Promise<void>;
  render?: (alert: PendingAlert) => string | RenderedAlert;
  persistSentMessage?: (alert: PendingAlert, telegramMessageId: number | null, rendered: RenderedAlert) => Promise<void>;
}

function defaultAlert(alert: PendingAlert): RenderedAlert {
  if (alert.event_type === "EDITORIAL_DIGEST") return renderEditorialDigest(alert.payload);
  if (alert.event_type === "INTELLIGENCE_COMPLETE") {
    const payload = alert.payload;
    const stories = Array.isArray(payload.stories) ? payload.stories.filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)).flatMap((value) => {
      if (typeof value.story_id !== "string" || typeof value.title !== "string" || typeof value.editorial_score !== "number" || typeof value.information_gap_score !== "number" || typeof value.discovery_audience_signal_score !== "number" || typeof value.grounding_status !== "string" || typeof value.news_eligible !== "boolean") return [];
      return [{ story_id: value.story_id, title: value.title, rank: typeof value.rank === "number" ? value.rank : null, editorial_score: value.editorial_score, information_gap_score: value.information_gap_score, discovery_audience_signal_score: value.discovery_audience_signal_score, grounding_status: value.grounding_status, news_eligible: value.news_eligible }];
    }) : [];
    return intelligenceSummary({ business_date: typeof payload.business_date === "string" ? payload.business_date : "", ranking_version: typeof payload.ranking_version === "string" ? payload.ranking_version : "", stories });
  }
  if (alert.event_type === "BREAKING_STORY" || alert.event_type === "RISING_STORY" || alert.event_type === "VERIFIED_STORY") {
    const payload = alert.payload;
    return renderEditorialStoryAlert({
      eventType: alert.event_type,
      storyId: typeof payload.story_id === "string" ? payload.story_id : "story",
      title: typeof payload.title === "string" ? payload.title : "맨유 관련 소재",
      sourceCount: typeof payload.source_count === "number" ? payload.source_count : 0,
      trendState: typeof payload.trend_state === "string" ? payload.trend_state : null,
      groundingStatus: typeof payload.grounding_status === "string" ? payload.grounding_status : "DISCOVERY_ONLY",
      newsEligible: payload.news_eligible === true,
      groundingEvidenceAvailable: payload.grounding_evidence_available === true,
      primarySourceName: typeof payload.primary_source_name === "string" ? payload.primary_source_name : null,
      primarySourceUrl: typeof payload.primary_source_url === "string" ? payload.primary_source_url : null,
    });
  }
  const payload = alert.payload;
  if (alert.event_type === "MATCH_BRIEFING_D1") {
    const opponent = typeof payload.opponent === "string" ? payload.opponent : "상대팀";
    const competition = typeof payload.competition === "string" ? payload.competition : "경기";
    const kickoff = typeof payload.kickoff_display === "string"
      ? payload.kickoff_display
      : typeof payload.kickoff_at === "string"
      ? payload.kickoff_at
      : "킥오프 미정";
    const venue = typeof payload.venue === "string" ? payload.venue : "장소 미정";
    return { text: `⚽ 내일 맨유 경기\n\nManchester United vs ${opponent}\n${competition}\n킥오프: ${kickoff}\n${venue}\n\n최근 관련 이슈는 검증된 canonical story에서 확인해 주세요.` };
  }
  const prefix = alert.event_type === "FIRST_MOVER" ? "🚨 FIRST_MOVER" : alert.event_type === "MUST_COVER" ? "🚨 MUST_COVER" : "📅 경기 일정 변경";
  const lines = [prefix, typeof payload.title === "string" ? payload.title : "새 알림이 있습니다."];
  if (typeof payload.permalink === "string") lines.push(`🔗 원문: ${payload.permalink}`);
  if (typeof payload.kickoff_at === "string") lines.push(`킥오프: ${payload.kickoff_at}`);
  return { text: lines.join("\n") };
}

export async function dispatchPendingAlerts(dependencies: AlertDispatchDependencies): Promise<AlertDispatchSummary> {
  const pending = await dependencies.listPending();
  let sent = 0;
  let failed = 0;
  for (const alert of pending) {
    try {
      const chatId = await dependencies.resolveChatId(alert);
      const custom = dependencies.render?.(alert);
      const rendered = typeof custom === "string" ? { text: custom } : custom ?? defaultAlert(alert);
      const sentMessage = await dependencies.client.sendText(chatId, rendered.text, rendered.reply_markup);
      if (dependencies.persistSentMessage) {
        try {
          await dependencies.persistSentMessage(alert, sentMessage.message_id, rendered);
        } catch (error) {
          console.error(JSON.stringify({ event: "telegram_alert_message_persistence_failed", alert_id: alert.id, error: error instanceof Error ? error.name : "PERSISTENCE_FAILED" }));
        }
      }
      await dependencies.markSent(alert.id, new Date().toISOString());
      sent += 1;
    } catch (error) {
      failed += 1;
      await dependencies.markFailed(alert.id, error instanceof Error ? error.name : "DELIVERY_FAILED");
    }
  }
  return { attempted: pending.length, sent, failed };
}

export interface CandidateAlertRow {
  candidate_id: string;
  first_mover_flag: boolean;
  must_cover_flag: boolean;
  priority_score?: number | null;
  candidate_calculated_at?: string | null;
  title?: string | null;
  permalink?: string | null;
}

export interface CandidateAlertRepository {
  listCandidates: () => Promise<readonly CandidateAlertRow[]>;
  getState: (candidateId: string) => Promise<CandidateAlertState | null>;
  saveState: (candidateId: string, state: CandidateAlertState, calculatedAt: string | null) => Promise<void>;
  insertEvent: (event: PendingAlert & { event_fingerprint: string; candidate_id: string }) => Promise<boolean>;
  threadId: string;
}

export async function scanCandidateAlertTransitions(now: Date, dependencies?: CandidateAlertRepository): Promise<number> {
  if (!dependencies) return 0;
  let created = 0;
  for (const candidate of await dependencies.listCandidates()) {
    const previous = await dependencies.getState(candidate.candidate_id) ?? { first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 0 };
    const transition = applyCandidateAlertTransition(previous, candidate, candidate.candidate_id);
    await dependencies.saveState(candidate.candidate_id, transition.state, candidate.candidate_calculated_at ?? now.toISOString());
    for (const event of transition.events) {
      if (await dependencies.insertEvent({
        id: "",
        event_type: event.type,
        payload: { candidate_id: candidate.candidate_id, title: candidate.title, permalink: candidate.permalink, priority_score: candidate.priority_score, transition: event.transition },
        event_fingerprint: event.fingerprint,
        candidate_id: candidate.candidate_id,
      })) created += 1;
    }
  }
  return created;
}
