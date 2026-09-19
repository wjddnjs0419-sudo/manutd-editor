import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { normalizeApiFootballFixture } from "../../_shared/m6/api_football_provider.ts";

function rawFixture(status: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixture: {
      id: 12345,
      date: "2026-09-20T11:30:00+00:00",
      timestamp: 1789903800,
      venue: { name: "Old Trafford" },
      status: { short: status, long: "Provider status" },
      ...overrides,
    },
    league: { name: "Premier League", season: 2026 },
    teams: {
      home: { id: 33, name: "Manchester United" },
      away: { id: 42, name: "Arsenal" },
    },
    goals: { home: null, away: null },
  };
}

Deno.test("normalizes API-Football fixture into canonical MU home match", () => {
  assertEquals(normalizeApiFootballFixture(rawFixture("NS"), 33), {
    provider: "API_FOOTBALL",
    external_match_id: "12345",
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
  });
});

Deno.test("maps documented API-Football status codes", () => {
  for (const status of ["NS", "TBD"]) {
    assertEquals(normalizeApiFootballFixture(rawFixture(status), 33).status, "SCHEDULED");
  }
  for (const status of ["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"]) {
    assertEquals(normalizeApiFootballFixture(rawFixture(status), 33).status, "LIVE");
  }
  for (const status of ["FT", "AET", "PEN", "AWD", "WO"]) {
    assertEquals(normalizeApiFootballFixture(rawFixture(status), 33).status, "FINISHED");
  }
  for (const status of ["PST", "SUSP"]) {
    assertEquals(normalizeApiFootballFixture(rawFixture(status), 33).status, "POSTPONED");
  }
  for (const status of ["CANC", "ABD"]) {
    assertEquals(normalizeApiFootballFixture(rawFixture(status), 33).status, "CANCELLED");
  }
});

Deno.test("normalizes a MU away result and scores", () => {
  const raw = rawFixture("FT");
  raw.teams = {
    home: { id: 42, name: "Arsenal" },
    away: { id: 33, name: "Manchester United" },
  };
  raw.goals = { home: 0, away: 2 };
  assertEquals(normalizeApiFootballFixture(raw, 33).opponent, "Arsenal");
  assertEquals(normalizeApiFootballFixture(raw, 33).is_home, false);
  assertEquals(normalizeApiFootballFixture(raw, 33).home_score, 0);
  assertEquals(normalizeApiFootballFixture(raw, 33).away_score, 2);
});

Deno.test("rejects an unknown provider status safely", () => {
  assertThrows(
    () => normalizeApiFootballFixture(rawFixture("MYSTERY"), 33),
    Error,
    "UNSUPPORTED_FIXTURE_STATUS",
  );
});
