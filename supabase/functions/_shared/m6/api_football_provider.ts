import type { CanonicalFixture, FixtureProvider } from "./fixture_types.ts";

const BASE_URL = "https://v3.football.api-sports.io";

export type ApiFootballErrorCategory =
  | "RATE_LIMITED"
  | "AUTH"
  | "NETWORK"
  | "SERVER"
  | "MALFORMED"
  | "UNSUPPORTED_STATUS"
  | "UNSUPPORTED_FIXTURE_STATUS";

export class ApiFootballProviderError extends Error {
  constructor(
    readonly category: ApiFootballErrorCategory,
    readonly status: number | null = null,
  ) {
    super(category);
    this.name = "ApiFootballProviderError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(value: unknown): JsonObject {
  if (!object(value)) throw new ApiFootballProviderError("MALFORMED");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFootballProviderError("MALFORMED");
  }
  return value;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusFor(short: string): CanonicalFixture["status"] {
  if (["NS", "TBD"].includes(short)) return "SCHEDULED";
  if (["1H", "HT", "2H", "ET", "BT", "P", "INT", "LIVE"].includes(short)) {
    return "LIVE";
  }
  if (["FT", "AET", "PEN", "AWD", "WO"].includes(short)) return "FINISHED";
  if (["PST", "SUSP"].includes(short)) return "POSTPONED";
  if (["CANC", "ABD"].includes(short)) return "CANCELLED";
  throw new ApiFootballProviderError("UNSUPPORTED_FIXTURE_STATUS");
}

export function normalizeApiFootballFixture(
  raw: unknown,
  teamId: number,
): CanonicalFixture {
  const root = requiredObject(raw);
  const fixture = requiredObject(root.fixture);
  const league = requiredObject(root.league);
  const teams = requiredObject(root.teams);
  const home = requiredObject(teams.home);
  const away = requiredObject(teams.away);
  const goals = requiredObject(root.goals);
  const homeId = home.id;
  const awayId = away.id;
  if (typeof homeId !== "number" || typeof awayId !== "number") {
    throw new ApiFootballProviderError("MALFORMED");
  }
  if (homeId !== teamId && awayId !== teamId) {
    throw new ApiFootballProviderError("MALFORMED");
  }
  const fixtureId = fixture.id;
  if (typeof fixtureId !== "number" && typeof fixtureId !== "string") {
    throw new ApiFootballProviderError("MALFORMED");
  }
  const date = requiredString(fixture.date);
  const parsedDate = new Date(date);
  if (!Number.isFinite(parsedDate.getTime())) {
    throw new ApiFootballProviderError("MALFORMED");
  }
  const fixtureStatus = requiredObject(fixture.status);
  const short = requiredString(fixtureStatus.short);
  const homeName = requiredString(home.name);
  const awayName = requiredString(away.name);
  const competition = requiredString(league.name);
  const season = league.season === null || league.season === undefined
    ? null
    : String(league.season);
  const isHome = homeId === teamId;
  const venueObject = object(fixture.venue) ? fixture.venue : null;

  return {
    provider: "API_FOOTBALL",
    external_match_id: String(fixtureId),
    competition,
    season,
    home_team: homeName,
    away_team: awayName,
    opponent: isHome ? awayName : homeName,
    is_home: isHome,
    kickoff_at: parsedDate.toISOString(),
    venue: venueObject && typeof venueObject.name === "string" && venueObject.name.trim() !== ""
      ? venueObject.name
      : null,
    status: statusFor(short),
    home_score: optionalNumber(goals.home),
    away_score: optionalNumber(goals.away),
  };
}

function dateParam(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new ApiFootballProviderError("MALFORMED");
  return value.toISOString().slice(0, 10);
}

function errorCategory(status: number): ApiFootballErrorCategory {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER";
  return "MALFORMED";
}

export interface ApiFootballProviderOptions {
  apiKey: string;
  teamId?: number;
  fetch?: typeof fetch;
}

export type ApiFootballProvider = FixtureProvider & {
  readonly rateLimitRemaining: number | null;
};

export function createApiFootballProvider(
  options: ApiFootballProviderOptions,
): ApiFootballProvider {
  if (!options.apiKey.trim()) throw new Error("API-Football API key is required");
  const teamId = options.teamId ?? 33;
  const fetchImpl = options.fetch ?? fetch;
  let rateLimitRemaining: number | null = null;

  async function request(path: string): Promise<readonly CanonicalFixture[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${BASE_URL}${path}`, {
        headers: { "x-apisports-key": options.apiKey },
      });
    } catch {
      throw new ApiFootballProviderError("NETWORK");
    }
    const remaining = response.headers.get("x-ratelimit-requests-remaining");
    if (remaining !== null && /^\d+$/u.test(remaining)) rateLimitRemaining = Number(remaining);
    if (!response.ok) throw new ApiFootballProviderError(errorCategory(response.status), response.status);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiFootballProviderError("MALFORMED", response.status);
    }
    const root = requiredObject(body);
    if (root.errors !== undefined && root.errors !== null) {
      if (object(root.errors) && Object.keys(root.errors).length > 0) {
        const values = Object.values(root.errors).join(" ").toLowerCase();
        if (values.includes("limit")) throw new ApiFootballProviderError("RATE_LIMITED", response.status);
        throw new ApiFootballProviderError("MALFORMED", response.status);
      }
    }
    if (!Array.isArray(root.response)) throw new ApiFootballProviderError("MALFORMED", response.status);
    return root.response.map((value) => normalizeApiFootballFixture(value, teamId));
  }

  return {
    get rateLimitRemaining() {
      return rateLimitRemaining;
    },
    fetchFixtures(from, to) {
      return request(`/fixtures?team=${teamId}&from=${dateParam(from)}&to=${dateParam(to)}&timezone=UTC`);
    },
    async fetchMatch(externalMatchId) {
      const values = await request(`/fixtures?id=${encodeURIComponent(externalMatchId)}`);
      return values[0] ?? null;
    },
  };
}
