import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.8";
import {
  ESPN_COMPETITIONS,
  ESPN_MANCHESTER_UNITED_TEAM_ID,
  EspnFixtureProviderError,
  createEspnFixtureProvider,
  normalizeEspnFixture,
} from "../../_shared/m6/espn_fixture_provider.ts";

type JsonObject = Record<string, unknown>;

function event(overrides: JsonObject = {}): JsonObject {
  return {
    id: "401999999",
    date: "2026-09-20T11:30:00Z",
    season: { year: 2026, displayName: "2026-27 English Premier League" },
    competitions: [{
      id: "401999999",
      status: { type: { name: "STATUS_SCHEDULED", state: "pre", completed: false } },
      venue: { fullName: "Old Trafford" },
      competitors: [
        { id: ESPN_MANCHESTER_UNITED_TEAM_ID, homeAway: "home", team: { displayName: "Manchester United" } },
        { id: "42", homeAway: "away", team: { displayName: "Arsenal" } },
      ],
    }],
    ...overrides,
  };
}

function normalized(raw: JsonObject, competition = ESPN_COMPETITIONS.PREMIER_LEAGUE) {
  return normalizeEspnFixture(raw, competition, ESPN_MANCHESTER_UNITED_TEAM_ID, "2026-09-20T12:00:00Z");
}

function scheduleResponse(events: readonly JsonObject[], timestamp = "2026-09-20T12:00:00Z"): Response {
  return new Response(JSON.stringify({
    timestamp,
    team: { id: ESPN_MANCHESTER_UNITED_TEAM_ID, displayName: "Manchester United" },
    events,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

Deno.test("normalizes an ESPN scheduled home fixture", () => {
  assertEquals(normalized(event()), {
    provider: "espn",
    external_match_id: "401999999",
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
    provider_payload: event(),
    provider_updated_at: "2026-09-20T12:00:00.000Z",
  });
});

Deno.test("normalizes ESPN live status", () => {
  assertEquals(normalized(event({ competitions: [{ ...(event().competitions as JsonObject[])[0], status: { type: { name: "STATUS_IN_PROGRESS", state: "in", completed: false } } }] })).status, "LIVE");
});

Deno.test("normalizes a finished fixture and preserves zero scores", () => {
  const fixture = event({ competitions: [{ ...(event().competitions as JsonObject[])[0], status: { type: { name: "STATUS_FULL_TIME", state: "post", completed: true } }, competitors: [
    { id: "42", homeAway: "home", score: "0", team: { displayName: "Arsenal" } },
    { id: ESPN_MANCHESTER_UNITED_TEAM_ID, homeAway: "away", score: "2", team: { displayName: "Manchester United" } },
  ] }] });
  const result = normalized(fixture);
  assertEquals(result.status, "FINISHED");
  assertEquals(result.home_score, 0);
  assertEquals(result.away_score, 2);
  assertEquals(result.is_home, false);
});

Deno.test("maps postponed and cancelled ESPN statuses", () => {
  const competition = (name: string) => [{ ...(event().competitions as JsonObject[])[0], status: { type: { name, state: "post", completed: false } } }];
  assertEquals(normalized(event({ competitions: competition("STATUS_POSTPONED") })).status, "POSTPONED");
  assertEquals(normalized(event({ competitions: competition("STATUS_CANCELED") })).status, "CANCELLED");
});

Deno.test("allows a missing venue without losing the fixture", () => {
  const result = normalized(event({ competitions: [{ ...(event().competitions as JsonObject[])[0], venue: undefined }] }));
  assertEquals(result.venue, null);
});

Deno.test("rejects malformed ESPN payloads and unknown statuses", () => {
  assertRejects(async () => normalized({}), EspnFixtureProviderError, "ESPN_SCHEMA_MISMATCH");
  assertRejects(async () => normalized(event({ competitions: [{ ...(event().competitions as JsonObject[])[0], status: { type: { name: "STATUS_MYSTERY", state: "post", completed: false } } }] })), EspnFixtureProviderError, "UNSUPPORTED_STATUS");
});

Deno.test("filters non-Manchester United events from competition schedules", async () => {
  const other = event({ id: "402000000", competitions: [{ ...(event().competitions as JsonObject[])[0], competitors: [
    { id: "1", homeAway: "home", team: { displayName: "Liverpool" } },
    { id: "2", homeAway: "away", team: { displayName: "Arsenal" } },
  ] }] });
  const provider = createEspnFixtureProvider({ fetch: async () => scheduleResponse([other]) });
  assertEquals(await provider.fetchFixtures(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z")), []);
});

Deno.test("uses the verified team schedule endpoints for every configured competition", async () => {
  const requested: string[] = [];
  const provider = createEspnFixtureProvider({
    fetch: async (input) => {
      requested.push(String(input));
      return scheduleResponse([event()]);
    },
  });
  const fixtures = await provider.fetchFixtures(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
  assertEquals(fixtures.length, Object.keys(ESPN_COMPETITIONS).length);
  for (const competition of Object.values(ESPN_COMPETITIONS)) {
    assertEquals(requested.some((url) => url.includes(`/soccer/${competition.slug}/teams/360/schedule`)), true);
  }
});

Deno.test("retries a transient ESPN response with a bounded request", async () => {
  let attempts = 0;
  const provider = createEspnFixtureProvider({
    maxRetries: 1,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      return attempts === 1 ? new Response("temporary", { status: 503 }) : scheduleResponse([event()]);
    },
  });
  await provider.fetchFixtures(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
  assertEquals(attempts, Object.keys(ESPN_COMPETITIONS).length + 1);
});

Deno.test("classifies an ESPN request timeout without leaking a provider body", async () => {
  const provider = createEspnFixtureProvider({ timeoutMs: 1, maxRetries: 0, fetch: (_input: RequestInfo | URL, init?: globalThis.RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }) });
  await assertRejects(
    () => provider.fetchFixtures(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z")),
    EspnFixtureProviderError,
    "TIMEOUT",
  );
});

Deno.test("fetchMatch resolves an ESPN summary into the same canonical shape", async () => {
  const provider = createEspnFixtureProvider({
    fetch: async (input) => {
      assertStringIncludes(String(input), "/summary?event=401999999");
      return new Response(JSON.stringify({
        meta: { lastUpdatedAt: "2026-09-20T12:01:00Z" },
        header: {
          id: "401999999",
          uid: "s:600~l:700~e:401999999",
          season: { year: 2026 },
          competitions: [{
            date: "2026-09-20T11:30:00Z",
            status: { type: { name: "STATUS_SCHEDULED", state: "pre", completed: false } },
            competitors: [
              { id: "360", homeAway: "home", team: { displayName: "Manchester United" } },
              { id: "42", homeAway: "away", team: { displayName: "Arsenal" } },
            ],
          }],
        },
        gameInfo: { venue: { fullName: "Old Trafford" } },
      }), { status: 200 });
    },
  });
  const result = await provider.fetchMatch("401999999");
  assertEquals(result?.external_match_id, "401999999");
  assertEquals(result?.provider_updated_at, "2026-09-20T12:01:00.000Z");
});
