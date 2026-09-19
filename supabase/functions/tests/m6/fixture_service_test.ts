import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  deriveMatchDayMode,
  runFixtureSync,
  shouldSyncFixtures,
  type FixtureSyncRepository,
} from "../../_shared/m6/fixture_service.ts";
import type {
  CanonicalFixture,
  FixtureProvider,
  StoredMatch,
} from "../../_shared/m6/fixture_types.ts";

const match = (overrides: Partial<StoredMatch> = {}): StoredMatch => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  provider: "API_FOOTBALL",
  external_match_id: "123",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Arsenal",
  opponent: "Arsenal",
  is_home: true,
  kickoff_at: "2026-09-20T11:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null,
  ...overrides,
});

const fixture = (overrides: Partial<CanonicalFixture> = {}): CanonicalFixture => ({
  provider: "API_FOOTBALL",
  external_match_id: "123",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Arsenal",
  opponent: "Arsenal",
  is_home: true,
  kickoff_at: "2026-09-20T11:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null,
  ...overrides,
});

Deno.test("uses exact normal, pre-match, and live refresh cadences", () => {
  const old = (value: string) => new Date(value);
  assertEquals(shouldSyncFixtures({ now: old("2026-09-19T00:00:00Z"), mode: "NORMAL_DAY", lastSyncAt: null }), true);
  assertEquals(shouldSyncFixtures({ now: old("2026-09-19T06:00:00Z"), mode: "NORMAL_DAY", lastSyncAt: old("2026-09-19T00:00:00Z") }), true);
  assertEquals(shouldSyncFixtures({ now: old("2026-09-19T06:15:00Z"), mode: "NORMAL_DAY", lastSyncAt: old("2026-09-19T06:00:00Z") }), false);
  assertEquals(shouldSyncFixtures({ now: old("2026-09-19T11:00:00Z"), mode: "MATCH_DAY_PRE", lastSyncAt: old("2026-09-19T09:59:00Z") }), true);
  assertEquals(shouldSyncFixtures({ now: old("2026-09-19T11:15:00Z"), mode: "MATCH_LIVE", lastSyncAt: old("2026-09-19T11:00:00Z") }), true);
});

Deno.test("derives lifecycle mode from canonical match state", () => {
  const now = new Date("2026-09-20T10:00:00Z");
  assertEquals(deriveMatchDayMode([match({ kickoff_at: "2026-09-20T11:30:00.000Z" })], now, "Asia/Seoul"), "MATCH_DAY_PRE");
  assertEquals(deriveMatchDayMode([match({ status: "LIVE" })], now, "Asia/Seoul"), "MATCH_LIVE");
  assertEquals(deriveMatchDayMode([match({ status: "FINISHED", kickoff_at: "2026-09-20T08:00:00.000Z" })], now, "Asia/Seoul"), "MATCH_POST");
  assertEquals(deriveMatchDayMode([], now, "Asia/Seoul"), "NORMAL_DAY");
});

function repository(initial: StoredMatch[]): FixtureSyncRepository & { alerts: string[]; rows: StoredMatch[] } {
  const rows = [...initial];
  const alerts: string[] = [];
  return {
    rows,
    alerts,
    async listUpcomingMatches() { return rows; },
    async getMatchByExternalId(externalMatchId) { return rows.find((row) => row.external_match_id === externalMatchId) ?? null; },
    async upsertMatch(value) {
      const existing = rows.find((row) => row.external_match_id === value.external_match_id);
      const saved = match({ ...value, id: existing?.id ?? match().id });
      if (existing) rows[rows.indexOf(existing)] = saved;
      else rows.push(saved);
      return saved;
    },
    async getFixtureSyncState() { return null; },
    async saveFixtureSyncState() {},
    async insertAlertEventIfAbsent(event) {
      if (alerts.includes(event.event_fingerprint)) return false;
      alerts.push(event.event_fingerprint);
      return true;
    },
  };
}

function provider(values: readonly CanonicalFixture[], error?: Error): FixtureProvider {
  return {
    async fetchFixtures() {
      if (error) throw error;
      return values;
    },
    async fetchMatch() { return values[0] ?? null; },
  };
}

Deno.test("creates one alert per fixture transition and deduplicates identical resync", async () => {
  const repo = repository([match()]);
  const deps = { provider: provider([fixture({ status: "LIVE", venue: "Old Trafford" })]), repository: repo, alertThreadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" };
  const first = await runFixtureSync({ mode: "FORCE", now: new Date("2026-09-20T10:00:00Z") }, deps);
  const second = await runFixtureSync({ mode: "FORCE", now: new Date("2026-09-20T10:01:00Z") }, deps);
  assertEquals(first.matches_changed, 1);
  assertEquals(first.alerts_created, 1);
  assertEquals(second.matches_changed, 0);
  assertEquals(second.alerts_created, 0);
  assertEquals(repo.alerts, [`MATCH_STATUS:${match().id}:LIVE`]);
});

Deno.test("preserves canonical rows when fixture provider fails", async () => {
  const before = match();
  const repo = repository([before]);
  const result = await runFixtureSync(
    { mode: "FORCE", now: new Date("2026-09-20T10:00:00Z") },
    { provider: provider([], new Error("upstream")), repository: repo, alertThreadId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
  );
  assertEquals(result.status, "FAILED");
  assertEquals(repo.rows[0], before);
});
