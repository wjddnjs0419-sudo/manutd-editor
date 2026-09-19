import type { TelegramClient } from "./telegram_client.ts";

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
  render?: (alert: PendingAlert) => string;
}

function defaultAlertText(alert: PendingAlert): string {
  const payload = alert.payload;
  const prefix = alert.event_type === "FIRST_MOVER" ? "🚨 FIRST_MOVER" : alert.event_type === "MUST_COVER" ? "🚨 MUST_COVER" : "📅 경기 일정 변경";
  const lines = [prefix, typeof payload.title === "string" ? payload.title : "새 알림이 있습니다."];
  if (typeof payload.permalink === "string") lines.push(`🔗 원문: ${payload.permalink}`);
  if (typeof payload.kickoff_at === "string") lines.push(`킥오프: ${payload.kickoff_at}`);
  return lines.join("\n");
}

export async function dispatchPendingAlerts(dependencies: AlertDispatchDependencies): Promise<AlertDispatchSummary> {
  const pending = await dependencies.listPending();
  let sent = 0;
  let failed = 0;
  for (const alert of pending) {
    try {
      const chatId = await dependencies.resolveChatId(alert);
      await dependencies.client.sendText(chatId, dependencies.render?.(alert) ?? defaultAlertText(alert));
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
