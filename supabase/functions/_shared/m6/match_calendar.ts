import type { NotionClient } from "../../notion-sync/notion_client.ts";
import type { NotionProperty } from "../../notion-sync/mapper.ts";
import type { MatchDayMode, StoredMatch } from "./fixture_types.ts";

export interface MatchCalendarSyncState {
  match_id: string;
  notion_page_id: string | null;
  last_synced_hash: string | null;
  last_synced_at?: string | null;
}

export interface MatchCalendarProjectionResult {
  status: "SYNCED" | "FAILED";
  notion_page_id: string | null;
  sync_state?: MatchCalendarSyncState;
  error_code?: "MATCH_CALENDAR_SCHEMA_MISMATCH" | "MATCH_CALENDAR_PROJECTION_FAILED";
}

function richText(content: string): NotionProperty {
  return { rich_text: [{ type: "text", text: { content } }] };
}

function select(name: string): NotionProperty {
  return { select: { name } };
}

function result(match: StoredMatch): string {
  if (match.home_score === null || match.away_score === null) return "미정";
  const muScore = match.is_home ? match.home_score : match.away_score;
  const opponentScore = match.is_home ? match.away_score : match.home_score;
  if (muScore > opponentScore) return "승";
  if (muScore < opponentScore) return "패";
  return "무";
}

function score(match: StoredMatch): string {
  return match.home_score === null || match.away_score === null
    ? "미정"
    : `${match.home_score}-${match.away_score}`;
}

export function buildMatchCalendarProperties(
  match: StoredMatch,
  mode: MatchDayMode,
  syncedAt = new Date(),
): Record<string, NotionProperty> {
  return {
    경기: { title: [{ type: "text", text: { content: `Manchester United vs ${match.opponent}` } }] },
    날짜: { date: { start: match.kickoff_at } },
    상대팀: richText(match.opponent),
    결과: select(result(match)),
    "Match ID": richText(match.id),
    Competition: richText(match.competition),
    "Home/Away": select(match.is_home ? "HOME" : "AWAY"),
    Status: select(match.status),
    Score: richText(score(match)),
    "Content Phase": select(mode),
    "Last Synced At": { date: { start: syncedAt.toISOString() } },
  };
}

async function payloadHash(payload: Record<string, NotionProperty>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function projectMatchToCalendar(
  match: StoredMatch,
  existingState: MatchCalendarSyncState | null,
  notion: Pick<NotionClient, "createPage" | "updatePage">,
  mode: MatchDayMode = "NORMAL_DAY",
  syncedAt = new Date(),
): Promise<MatchCalendarProjectionResult> {
  const properties = buildMatchCalendarProperties(match, mode, syncedAt);
  try {
    const page = existingState?.notion_page_id
      ? await notion.updatePage(existingState.notion_page_id, { properties })
      : await notion.createPage({ properties, children: [] });
    const hash = await payloadHash(properties);
    return {
      status: "SYNCED",
      notion_page_id: page.id,
      sync_state: {
        match_id: match.id,
        notion_page_id: page.id,
        last_synced_hash: hash,
        last_synced_at: syncedAt.toISOString(),
      },
    };
  } catch (error) {
    const category = typeof error === "object" && error !== null && "category" in error ? String(error.category) : "";
    return {
      status: "FAILED",
      notion_page_id: existingState?.notion_page_id ?? null,
      error_code: category === "BAD_REQUEST" ? "MATCH_CALENDAR_SCHEMA_MISMATCH" : "MATCH_CALENDAR_PROJECTION_FAILED",
    };
  }
}
