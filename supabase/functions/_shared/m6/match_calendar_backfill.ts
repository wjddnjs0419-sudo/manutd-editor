import { deriveMatchDayMode } from "./fixture_service.ts";
import type { MatchDayMode, StoredMatch } from "./fixture_types.ts";
import type { NonCriticalMatchCalendarProjectionResult } from "./match_assistant.ts";

export interface MatchCalendarBackfillResult {
  status: "SYNCED" | "PARTIAL" | "SKIPPED_CONFIGURATION";
  matches_seen: number;
  matches_synced: number;
  projection_failures: number;
}

export async function runMatchCalendarBackfill(input: {
  configured: boolean;
  missingConfiguration?: string[];
  now: Date;
  listMatches: (from: Date, to: Date) => Promise<readonly StoredMatch[]>;
  project: (
    match: StoredMatch,
    mode: MatchDayMode,
    syncedAt: Date,
  ) => Promise<NonCriticalMatchCalendarProjectionResult>;
}): Promise<MatchCalendarBackfillResult> {
  if (!input.configured) {
    console.warn(JSON.stringify({
      event: "match_calendar_backfill",
      status: "SKIPPED_CONFIGURATION",
      missing_configuration: input.missingConfiguration ?? [],
    }));
    return {
      status: "SKIPPED_CONFIGURATION",
      matches_seen: 0,
      matches_synced: 0,
      projection_failures: 0,
    };
  }

  const from = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(input.now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const matches = await input.listMatches(from, to);
  const mode = deriveMatchDayMode(matches, input.now, "Asia/Seoul");
  let matchesSynced = 0;
  let projectionFailures = 0;
  for (const match of matches) {
    const projection = await input.project(match, mode, input.now);
    if (projection.status === "SYNCED") matchesSynced += 1;
    else if (
      projection.status === "SCHEMA_MISMATCH" ||
      projection.status === "PROJECTION_FAILED"
    ) {
      projectionFailures += 1;
    }
  }
  return {
    status: projectionFailures === 0 ? "SYNCED" : "PARTIAL",
    matches_seen: matches.length,
    matches_synced: matchesSynced,
    projection_failures: projectionFailures,
  };
}
