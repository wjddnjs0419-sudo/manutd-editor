import type { NotionClient } from "../../notion-sync/notion_client.ts";
import { businessDate } from "./business_date.ts";
import { deriveMatchDayMode } from "./fixture_service.ts";
import {
  type MatchCalendarProjectionResult,
  type MatchCalendarSyncState,
  projectMatchToCalendar,
} from "./match_calendar.ts";
import type { MatchDayMode, StoredMatch } from "./fixture_types.ts";

export type MatchBriefingPhase = "D_MINUS_1" | "D_DAY" | "NONE";

export interface MatchContext {
  match_id: string;
  opponent: string;
  kickoff_at: string;
  kickoff_local_date: string;
  kickoff_local_time: string;
  kickoff_display: string;
  kickoff_timezone: "Asia/Seoul";
  competition: string;
  home_away: "HOME" | "AWAY";
  venue: string | null;
  fixture_status: StoredMatch["status"];
  current_match_phase: MatchDayMode;
  match_briefing_phase: MatchBriefingPhase;
}

export interface MatchD1BriefingEvent {
  event_type: "MATCH_BRIEFING_D1";
  match_id: string;
  event_fingerprint: string;
}

function localTime(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function localDayNumber(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function getMatchBriefingPhase(
  match: StoredMatch,
  now: Date,
  timezone = "Asia/Seoul",
): MatchBriefingPhase {
  if (match.status !== "SCHEDULED") return "NONE";
  const kickoffDate = businessDate(match.kickoff_at, timezone);
  const today = businessDate(now, timezone);
  if (today === kickoffDate) return "D_DAY";
  if (
    localDayNumber(kickoffDate) - localDayNumber(today) === 24 * 60 * 60 * 1000
  ) return "D_MINUS_1";
  return "NONE";
}

export function buildMatchContext(
  match: StoredMatch,
  now: Date,
): MatchContext {
  const timezone = "Asia/Seoul";
  const kickoffDate = businessDate(match.kickoff_at, timezone);
  const kickoffTime = localTime(new Date(match.kickoff_at), timezone);
  return {
    match_id: match.id,
    opponent: match.opponent,
    kickoff_at: match.kickoff_at,
    kickoff_local_date: kickoffDate,
    kickoff_local_time: kickoffTime,
    kickoff_display: `${kickoffDate} ${kickoffTime} KST`,
    kickoff_timezone: timezone,
    competition: match.competition,
    home_away: match.is_home ? "HOME" : "AWAY",
    venue: match.venue,
    fixture_status: match.status,
    current_match_phase: deriveMatchDayMode([match], now, timezone),
    match_briefing_phase: getMatchBriefingPhase(match, now, timezone),
  };
}

export function decideMatchD1BriefingEvent(
  match: StoredMatch,
  now: Date,
  alreadyQueued = false,
  timezone = "Asia/Seoul",
): MatchD1BriefingEvent | null {
  if (
    alreadyQueued || getMatchBriefingPhase(match, now, timezone) !== "D_MINUS_1"
  ) return null;
  const date = businessDate(now, timezone);
  return {
    event_type: "MATCH_BRIEFING_D1",
    match_id: match.id,
    event_fingerprint: `MATCH_BRIEFING_D1:${match.id}:${date}`,
  };
}

export function isMaterialKickoffChange(
  previousKickoffAt: string,
  nextKickoffAt: string,
  minimumChangeMinutes = 15,
  timezone = "Asia/Seoul",
): boolean {
  const previous = Date.parse(previousKickoffAt);
  const next = Date.parse(nextKickoffAt);
  if (
    !Number.isFinite(previous) || !Number.isFinite(next) || previous === next
  ) return false;
  if (
    businessDate(previousKickoffAt, timezone) !==
      businessDate(nextKickoffAt, timezone)
  ) return true;
  return Math.abs(next - previous) >= minimumChangeMinutes * 60_000;
}

export type NonCriticalMatchCalendarProjectionResult =
  | MatchCalendarProjectionResult
  | {
    status: "SKIPPED";
    notion_page_id: null;
  };

export interface MatchCalendarProjectionDependencies {
  match: StoredMatch;
  mode: MatchDayMode;
  configured: boolean;
  notion:
    | Pick<NotionClient, "createPage" | "updatePage" | "queryDatabase">
    | null;
  getState: (matchId: string) => Promise<MatchCalendarSyncState | null>;
  saveState: (state: MatchCalendarSyncState) => Promise<void>;
  syncedAt?: Date;
}

function matchIdFromPage(
  page: { properties: Record<string, unknown> },
): string | null {
  const property = page.properties["Match ID"];
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    return null;
  }
  const richText = (property as { rich_text?: unknown }).rich_text;
  if (!Array.isArray(richText)) return null;
  for (const item of richText) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const text = (item as { plain_text?: unknown }).plain_text;
    if (typeof text === "string") return text;
    const nested = (item as { text?: { content?: unknown } }).text?.content;
    if (typeof nested === "string") return nested;
  }
  return null;
}

/**
 * Projects canonical Supabase fixture data to Notion without allowing a
 * Notion or projection-state failure to interrupt fixture processing.
 */
export async function projectMatchToCalendarBestEffort(
  dependencies: MatchCalendarProjectionDependencies,
): Promise<NonCriticalMatchCalendarProjectionResult> {
  if (!dependencies.configured || !dependencies.notion) {
    return { status: "SKIPPED", notion_page_id: null };
  }
  const syncedAt = dependencies.syncedAt ?? new Date();
  try {
    let state = await dependencies.getState(dependencies.match.id);
    if (state && state.match_id !== dependencies.match.id) state = null;
    if (!state) {
      const pages = await dependencies.notion.queryDatabase({
        filter: {
          property: "Match ID",
          rich_text: { equals: dependencies.match.id },
        },
        page_size: 1,
      });
      const existingPage = pages.find((page) =>
        matchIdFromPage(page) === dependencies.match.id
      );
      if (existingPage) {
        state = {
          match_id: dependencies.match.id,
          notion_page_id: existingPage.id,
          last_synced_hash: null,
        };
      }
    }
    const projection = await projectMatchToCalendar(
      dependencies.match,
      state,
      dependencies.notion,
      dependencies.mode,
      syncedAt,
    );
    if (projection.status !== "SYNCED" || !projection.sync_state) {
      return projection;
    }
    await dependencies.saveState(projection.sync_state);
    return projection;
  } catch {
    return {
      status: "FAILED",
      notion_page_id: null,
      error_code: "MATCH_CALENDAR_PROJECTION_FAILED",
    };
  }
}
