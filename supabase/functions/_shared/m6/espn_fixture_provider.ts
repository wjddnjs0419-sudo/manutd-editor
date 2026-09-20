import type { CanonicalFixture, FixtureProvider } from "./fixture_types.ts";

// The web API host serves the same JSON schema but is reachable from hosted
// serverless egress where site.api.espn.com may return an IP-based 403.
const BASE_URL = "https://site.web.api.espn.com/apis/site/v2/sports/soccer";

export const ESPN_MANCHESTER_UNITED_TEAM_ID = "360";

export const ESPN_COMPETITIONS = {
  PREMIER_LEAGUE: { slug: "eng.1", leagueId: "700", name: "Premier League" },
  FA_CUP: { slug: "eng.fa", leagueId: "3918", name: "FA Cup" },
  EFL_CUP: { slug: "eng.league_cup", leagueId: "3920", name: "Carabao Cup" },
  CHAMPIONS_LEAGUE: { slug: "uefa.champions", leagueId: "775", name: "UEFA Champions League" },
  EUROPA_LEAGUE: { slug: "uefa.europa", leagueId: "776", name: "UEFA Europa League" },
} as const;

export type EspnCompetition = typeof ESPN_COMPETITIONS[keyof typeof ESPN_COMPETITIONS];

export type EspnFixtureErrorCategory =
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "ESPN_BAD_RESPONSE"
  | "ESPN_SCHEMA_MISMATCH"
  | "MATCH_NOT_FOUND"
  | "UNSUPPORTED_STATUS";

export class EspnFixtureProviderError extends Error {
  constructor(
    readonly category: EspnFixtureErrorCategory,
    readonly status: number | null = null,
  ) {
    super(category);
    this.name = "EspnFixtureProviderError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(value: unknown): JsonObject {
  if (!object(value)) throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function dateString(value: unknown): string {
  const raw = requiredString(value);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  return parsed.toISOString();
}

function optionalScore(value: unknown): number | null {
  const raw = typeof value === "string" ? value : object(value) ? value.value : value;
  if (raw === null || raw === undefined || raw === "") return null;
  const score = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(score) || score < 0) throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  return score;
}

function statusFor(status: JsonObject): CanonicalFixture["status"] {
  const type = requiredObject(status.type);
  const state = requiredString(type.state).toLowerCase();
  const name = requiredString(type.name).toUpperCase();
  if (name === "STATUS_POSTPONED") return "POSTPONED";
  if (["STATUS_CANCELED", "STATUS_CANCELLED", "STATUS_ABANDONED"].includes(name)) return "CANCELLED";
  if (state === "pre" && ["STATUS_SCHEDULED", "STATUS_PRE_GAME", "STATUS_DELAYED"].includes(name)) return "SCHEDULED";
  if (state === "in" && [
    "STATUS_IN_PROGRESS",
    "STATUS_FIRST_HALF",
    "STATUS_HALFTIME",
    "STATUS_SECOND_HALF",
    "STATUS_END_PERIOD",
    "STATUS_EXTRA_TIME",
    "STATUS_PENALTY_SHOOTOUT",
    "STATUS_BREAK",
  ].includes(name)) return "LIVE";
  if (state === "post" && ["STATUS_FULL_TIME", "STATUS_FINAL", "STATUS_AET", "STATUS_PENALTY_SHOOTOUT"].includes(name)) return "FINISHED";
  throw new EspnFixtureProviderError("UNSUPPORTED_STATUS");
}

function teamId(value: unknown): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
}

function seasonValue(value: unknown): string | null {
  if (!object(value)) return null;
  if (typeof value.year === "number" && Number.isSafeInteger(value.year)) return String(value.year);
  if (typeof value.year === "string" && value.year.trim() !== "") return value.year;
  return null;
}

function competitorList(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length !== 2) throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  return value.map(requiredObject);
}

function eventCompetition(raw: JsonObject): JsonObject {
  if (!Array.isArray(raw.competitions) || raw.competitions.length === 0) {
    throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  }
  return requiredObject(raw.competitions[0]);
}

function containsTeam(competition: JsonObject, configuredTeamId: string): boolean {
  if (!Array.isArray(competition.competitors)) return false;
  return competition.competitors.some((value) => object(value) && teamId(value.id) === configuredTeamId);
}

export function normalizeEspnFixture(
  raw: unknown,
  competition: EspnCompetition,
  configuredTeamId = ESPN_MANCHESTER_UNITED_TEAM_ID,
  providerUpdatedAt: string | null = null,
): CanonicalFixture {
  const event = requiredObject(raw);
  const externalMatchId = requiredString(event.id);
  const eventCompetitionValue = eventCompetition(event);
  const competitors = competitorList(eventCompetitionValue.competitors);
  const home = competitors.find((value) => value.homeAway === "home");
  const away = competitors.find((value) => value.homeAway === "away");
  if (!home || !away || !containsTeam(eventCompetitionValue, configuredTeamId)) {
    throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  }
  const homeId = teamId(home.id);
  const awayId = teamId(away.id);
  const homeTeam = requiredObject(home.team);
  const awayTeam = requiredObject(away.team);
  const homeName = requiredString(homeTeam.displayName);
  const awayName = requiredString(awayTeam.displayName);
  const isHome = homeId === configuredTeamId;
  if (!isHome && awayId !== configuredTeamId) throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
  const venue = object(eventCompetitionValue.venue) ? optionalString(eventCompetitionValue.venue.fullName) : null;
  const updatedAt = providerUpdatedAt === null ? null : dateString(providerUpdatedAt);

  return {
    provider: "espn",
    external_match_id: externalMatchId,
    competition: competition.name,
    season: seasonValue(event.season),
    home_team: homeName,
    away_team: awayName,
    opponent: isHome ? awayName : homeName,
    is_home: isHome,
    kickoff_at: dateString(event.date),
    venue,
    status: statusFor(requiredObject(eventCompetitionValue.status)),
    home_score: optionalScore(home.score),
    away_score: optionalScore(away.score),
    provider_payload: event,
    provider_updated_at: updatedAt,
  };
}

function providerTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
}

function rangeContains(value: string, from: Date, to: Date): boolean {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= from.getTime() && timestamp <= to.getTime();
}

function eventFromSummary(body: JsonObject): { event: JsonObject; competition: EspnCompetition; updatedAt: string | null } {
  const header = requiredObject(body.header);
  const competitions = Array.isArray(header.competitions) ? header.competitions : [];
  const summaryCompetition = requiredObject(competitions[0]);
  const uid = requiredString(header.uid);
  const leagueId = uid.match(/~l:(\d+)~/u)?.[1];
  const competition = Object.values(ESPN_COMPETITIONS).find((candidate) => candidate.leagueId === leagueId);
  if (!competition) throw new EspnFixtureProviderError("MATCH_NOT_FOUND");
  const gameInfo = object(body.gameInfo) ? body.gameInfo : {};
  const venue = object(gameInfo.venue) ? gameInfo.venue : undefined;
  const event: JsonObject = {
    id: header.id,
    date: summaryCompetition.date,
    season: header.season,
    competitions: [{ ...summaryCompetition, ...(venue ? { venue } : {}) }],
  };
  const meta = object(body.meta) ? body.meta : {};
  return { event, competition, updatedAt: providerTimestamp(meta.lastUpdatedAt) };
}

export interface EspnFixtureProviderOptions {
  teamId?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type EspnFixtureProvider = FixtureProvider;

export function createEspnFixtureProvider(options: EspnFixtureProviderOptions = {}): EspnFixtureProvider {
  const configuredTeamId = options.teamId ?? ESPN_MANCHESTER_UNITED_TEAM_ID;
  if (!/^\d+$/u.test(configuredTeamId)) throw new Error("ESPN team id must be numeric");
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/u, "");
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxRetries = Math.max(0, Math.min(options.maxRetries ?? 2, 3));
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  async function request(url: string): Promise<{ body: JsonObject; updatedAt: string | null }> {
    let lastError: EspnFixtureProviderError | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(url, { signal: controller.signal });
        } catch {
          lastError = new EspnFixtureProviderError(timedOut ? "TIMEOUT" : "NETWORK_ERROR");
          console.error(JSON.stringify({
            event: "espn_request_failed",
            category: lastError.category,
            attempt,
            url,
          }));
          if (attempt < maxRetries) {
            await sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          throw lastError;
        }
        if (!response.ok) {
          lastError = new EspnFixtureProviderError("ESPN_BAD_RESPONSE", response.status);
          console.error(JSON.stringify({
            event: "espn_request_failed",
            category: lastError.category,
            attempt,
            status: response.status,
            url,
          }));
          if (attempt < maxRetries && (response.status === 429 || response.status >= 500)) {
            await sleep(Math.min(250 * 2 ** attempt, 2_000));
            continue;
          }
          throw lastError;
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          console.error(JSON.stringify({
            event: "espn_request_failed",
            category: "ESPN_BAD_RESPONSE",
            attempt,
            status: response.status,
            url,
          }));
          throw new EspnFixtureProviderError("ESPN_BAD_RESPONSE", response.status);
        }
        const root = requiredObject(body);
        return { body: root, updatedAt: providerTimestamp(root.timestamp) };
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new EspnFixtureProviderError("NETWORK_ERROR");
  }

  async function fetchCompetition(competition: EspnCompetition, from: Date, to: Date): Promise<readonly CanonicalFixture[]> {
    const url = `${baseUrl}/${competition.slug}/teams/${configuredTeamId}/schedule`;
    const response = await request(url);
    if (!Array.isArray(response.body.events) || !object(response.body.team) || teamId(response.body.team.id) !== configuredTeamId) {
      throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
    }
    return response.body.events
      .map(requiredObject)
      .filter((value) => {
        const candidateCompetition = eventCompetition(value);
        return containsTeam(candidateCompetition, configuredTeamId) && rangeContains(requiredString(value.date), from, to);
      })
      .map((value) => normalizeEspnFixture(value, competition, configuredTeamId, response.updatedAt));
  }

  return {
    async fetchFixtures(from, to) {
      if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
        throw new EspnFixtureProviderError("ESPN_SCHEMA_MISMATCH");
      }
      const batches = await Promise.all(Object.values(ESPN_COMPETITIONS).map((competition) => fetchCompetition(competition, from, to)));
      return batches.flat();
    },
    async fetchMatch(externalMatchId) {
      if (!externalMatchId.trim()) throw new EspnFixtureProviderError("MATCH_NOT_FOUND");
      const url = `${baseUrl}/${ESPN_COMPETITIONS.PREMIER_LEAGUE.slug}/summary?event=${encodeURIComponent(externalMatchId)}`;
      let response: { body: JsonObject; updatedAt: string | null };
      try {
        response = await request(url);
      } catch (error) {
        if (error instanceof EspnFixtureProviderError && error.status === 404) throw new EspnFixtureProviderError("MATCH_NOT_FOUND", 404);
        throw error;
      }
      const parsed = eventFromSummary(response.body);
      if (parsed.event.id !== externalMatchId) throw new EspnFixtureProviderError("MATCH_NOT_FOUND");
      if (!containsTeam(eventCompetition(parsed.event), configuredTeamId)) return null;
      return normalizeEspnFixture(parsed.event, parsed.competition, configuredTeamId, parsed.updatedAt ?? response.updatedAt);
    },
  };
}
