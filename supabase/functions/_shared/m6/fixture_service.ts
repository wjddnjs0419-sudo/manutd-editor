import type {
  CanonicalFixture,
  FixtureProvider,
  MatchDayMode,
  StoredMatch,
} from "./fixture_types.ts";

export interface FixtureSyncState {
  provider: string;
  last_full_sync_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_category: string | null;
}

export interface FixtureAlertEvent {
  thread_id: string;
  event_type: string;
  candidate_id?: string | null;
  match_id?: string | null;
  event_fingerprint: string;
  payload: Record<string, unknown>;
  status: "PENDING";
}

export interface FixtureSyncRepository {
  listUpcomingMatches(from: Date, to: Date): Promise<readonly StoredMatch[]>;
  getMatchByExternalId(externalMatchId: string): Promise<StoredMatch | null>;
  upsertMatch(fixture: CanonicalFixture, syncedAt: Date): Promise<StoredMatch>;
  getFixtureSyncState(provider: string): Promise<FixtureSyncState | null>;
  saveFixtureSyncState(state: FixtureSyncState): Promise<void>;
  insertAlertEventIfAbsent(event: FixtureAlertEvent): Promise<boolean>;
}

export interface FixtureSyncDependencies {
  provider: FixtureProvider;
  repository: FixtureSyncRepository;
  alertThreadId: string;
}

export interface FixtureSyncContext {
  now: Date;
  mode: MatchDayMode;
  lastSyncAt: Date | null;
}

export interface FixtureSyncResult {
  status: "SYNCED" | "NOOP" | "FAILED";
  matches_seen: number;
  matches_changed: number;
  alerts_created: number;
  match_day_mode: MatchDayMode;
  error_category?: string;
}

function localHour(now: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0");
}

function sameLocalHour(left: Date, right: Date, timezone: string): boolean {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  return formatter.format(left) === formatter.format(right);
}

export function shouldSyncFixtures(
  context: FixtureSyncContext,
  timezone = "Asia/Seoul",
): boolean {
  if (!context.lastSyncAt) return true;
  const elapsed = context.now.getTime() - context.lastSyncAt.getTime();
  if (elapsed < 0) return true;
  if (context.mode === "MATCH_LIVE") return elapsed >= 15 * 60 * 1000;
  if (context.mode === "MATCH_EVE" || context.mode === "MATCH_DAY_PRE") {
    return elapsed >= 60 * 60 * 1000;
  }
  const hour = localHour(context.now, timezone);
  return (hour === 3 || hour === 15) && !sameLocalHour(context.now, context.lastSyncAt, timezone);
}

export function deriveMatchDayMode(
  matches: readonly StoredMatch[],
  now: Date,
  _timezone: string,
): MatchDayMode {
  if (matches.some((match) => match.status === "LIVE")) return "MATCH_LIVE";
  const finishedRecently = matches.some((match) => {
    if (match.status !== "FINISHED") return false;
    const age = now.getTime() - new Date(match.kickoff_at).getTime();
    return age >= 0 && age <= 24 * 60 * 60 * 1000;
  });
  if (finishedRecently) return "MATCH_POST";
  const upcoming = matches
    .filter((match) => match.status === "SCHEDULED" || match.status === "POSTPONED")
    .map((match) => new Date(match.kickoff_at).getTime() - now.getTime())
    .filter((value) => value >= 0)
    .sort((left, right) => left - right)[0];
  if (upcoming !== undefined && upcoming <= 24 * 60 * 60 * 1000) return "MATCH_DAY_PRE";
  if (upcoming !== undefined && upcoming <= 48 * 60 * 60 * 1000) return "MATCH_EVE";
  return "NORMAL_DAY";
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function changed(left: StoredMatch, right: CanonicalFixture): boolean {
  return left.kickoff_at !== right.kickoff_at || left.venue !== right.venue ||
    left.status !== right.status || left.home_score !== right.home_score ||
    left.away_score !== right.away_score;
}

export async function runFixtureSync(
  request: { mode: "AUTO" | "FORCE"; now: Date },
  dependencies: FixtureSyncDependencies,
): Promise<FixtureSyncResult> {
  const providerName = "espn";
  const from = new Date(request.now.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(request.now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const existing = await dependencies.repository.listUpcomingMatches(from, to);
  const currentMode = deriveMatchDayMode(existing, request.now, "Asia/Seoul");
  const state = await dependencies.repository.getFixtureSyncState(providerName);
  const lastAttempt = state?.last_success_at ? new Date(state.last_success_at) : null;
  if (request.mode === "AUTO" && !shouldSyncFixtures({ now: request.now, mode: currentMode, lastSyncAt: lastAttempt })) {
    return { status: "NOOP", matches_seen: existing.length, matches_changed: 0, alerts_created: 0, match_day_mode: currentMode };
  }

  await dependencies.repository.saveFixtureSyncState({
    provider: providerName,
    last_full_sync_at: state?.last_full_sync_at ?? null,
    last_attempt_at: request.now.toISOString(),
    last_success_at: state?.last_success_at ?? null,
    last_error_category: null,
  });

  let fetched: readonly CanonicalFixture[];
  try {
    fetched = await dependencies.provider.fetchFixtures(from, to);
  } catch (error) {
    const category = typeof error === "object" && error !== null && "category" in error && typeof error.category === "string"
      ? error.category
      : "NETWORK_ERROR";
    await dependencies.repository.saveFixtureSyncState({
      provider: providerName,
      last_full_sync_at: state?.last_full_sync_at ?? null,
      last_attempt_at: request.now.toISOString(),
      last_success_at: state?.last_success_at ?? null,
      last_error_category: category,
    });
    return { status: "FAILED", matches_seen: existing.length, matches_changed: 0, alerts_created: 0, match_day_mode: currentMode, error_category: category };
  }

  const previousByExternal = new Map(existing.map((match) => [match.external_match_id, match]));
  let matchesChanged = 0;
  let alertsCreated = 0;
  for (const next of fetched) {
    const previous = previousByExternal.get(next.external_match_id);
    if (previous && !changed(previous, next)) continue;
    const saved = await dependencies.repository.upsertMatch(next, request.now);
    if (!previous) continue;
    matchesChanged += 1;
    const events: FixtureAlertEvent[] = [];
    if (previous.status !== next.status) {
      events.push({
        thread_id: dependencies.alertThreadId,
        event_type: "MATCH_STATUS",
        match_id: saved.id,
        event_fingerprint: `MATCH_STATUS:${saved.id}:${next.status}`,
        payload: { match_id: saved.id, previous_status: previous.status, status: next.status },
        status: "PENDING",
      });
    }
    if (previous.kickoff_at !== next.kickoff_at) {
      events.push({
        thread_id: dependencies.alertThreadId,
        event_type: "FIXTURE_KICKOFF_CHANGED",
        match_id: saved.id,
        event_fingerprint: `FIXTURE_KICKOFF_CHANGED:${saved.id}:${next.kickoff_at}`,
        payload: { match_id: saved.id, previous_kickoff_at: previous.kickoff_at, kickoff_at: next.kickoff_at },
        status: "PENDING",
      });
    }
    if (previous.venue !== next.venue) {
      events.push({
        thread_id: dependencies.alertThreadId,
        event_type: "FIXTURE_VENUE_CHANGED",
        match_id: saved.id,
        event_fingerprint: `FIXTURE_VENUE_CHANGED:${saved.id}:${await sha256(next.venue ?? "")}`,
        payload: { match_id: saved.id, previous_venue: previous.venue, venue: next.venue },
        status: "PENDING",
      });
    }
    for (const event of events) {
      if (await dependencies.repository.insertAlertEventIfAbsent(event)) alertsCreated += 1;
    }
  }

  const merged = [...existing.filter((row) => !fetched.some((item) => item.external_match_id === row.external_match_id)), ...fetched.map((item) => ({
    ...item,
    id: previousByExternal.get(item.external_match_id)?.id ?? crypto.randomUUID(),
  }))];
  const finalMode = deriveMatchDayMode(merged, request.now, "Asia/Seoul");
  await dependencies.repository.saveFixtureSyncState({
    provider: providerName,
    last_full_sync_at: request.now.toISOString(),
    last_attempt_at: request.now.toISOString(),
    last_success_at: request.now.toISOString(),
    last_error_category: null,
  });
  return { status: "SYNCED", matches_seen: fetched.length, matches_changed: matchesChanged, alerts_created: alertsCreated, match_day_mode: finalMode };
}
