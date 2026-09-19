import type { CanonicalFixture, StoredMatch } from "./fixture_types.ts";
import type { FixtureAlertEvent, FixtureSyncRepository, FixtureSyncState } from "./fixture_service.ts";

export interface M6RepositoryOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

export class M6RepositoryError extends Error {
  constructor(readonly category: "CONFIGURATION" | "NETWORK" | "HTTP" | "RESPONSE") {
    super(category);
    this.name = "M6RepositoryError";
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function row(value: unknown): JsonObject {
  if (!object(value)) throw new M6RepositoryError("RESPONSE");
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function parseMatch(value: unknown): StoredMatch {
  const source = row(value);
  if (typeof source.id !== "string" || typeof source.provider !== "string" || typeof source.external_match_id !== "string" ||
    typeof source.competition !== "string" || typeof source.home_team !== "string" || typeof source.away_team !== "string" ||
    typeof source.opponent !== "string" || typeof source.is_home !== "boolean" || typeof source.kickoff_at !== "string" ||
    typeof source.status !== "string") throw new M6RepositoryError("RESPONSE");
  return {
    id: source.id,
    provider: source.provider,
    external_match_id: source.external_match_id,
    competition: source.competition,
    season: nullableString(source.season),
    home_team: source.home_team,
    away_team: source.away_team,
    opponent: source.opponent,
    is_home: source.is_home,
    kickoff_at: source.kickoff_at,
    venue: nullableString(source.venue),
    status: source.status as StoredMatch["status"],
    home_score: nullableNumber(source.home_score),
    away_score: nullableNumber(source.away_score),
    provider_payload: object(source.provider_payload) ? source.provider_payload : {},
  };
}

export function createM6Repository(options: M6RepositoryOptions): FixtureSyncRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new M6RepositoryError("CONFIGURATION");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}`, accept: "application/json" };

  async function request(path: string, init: RequestInit = {}, profile?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}), ...(init.headers ?? {}) } });
    } catch {
      throw new M6RepositoryError("NETWORK");
    }
    if (!response.ok) throw new M6RepositoryError("HTTP");
    if (response.status === 204) return null;
    try {
      const body = await response.text();
      return body.trim() === "" ? null : JSON.parse(body);
    } catch {
      throw new M6RepositoryError("RESPONSE");
    }
  }

  async function listUpcomingMatches(from: Date, to: Date): Promise<readonly StoredMatch[]> {
    const result = await request(`/rest/v1/matches?select=*&kickoff_at=gte.${encodeURIComponent(from.toISOString())}&kickoff_at=lte.${encodeURIComponent(to.toISOString())}&order=kickoff_at.asc`);
    if (!Array.isArray(result)) throw new M6RepositoryError("RESPONSE");
    return result.map(parseMatch);
  }

  return {
    async listUpcomingMatches(from, to) { return listUpcomingMatches(from, to); },
    async getMatchByExternalId(externalMatchId) {
      const result = await request(`/rest/v1/matches?select=*&external_match_id=eq.${encodeURIComponent(externalMatchId)}&provider=eq.API_FOOTBALL&limit=1`);
      if (!Array.isArray(result)) throw new M6RepositoryError("RESPONSE");
      return result[0] ? parseMatch(result[0]) : null;
    },
    async upsertMatch(fixture, syncedAt) {
      const result = await request(`/rest/v1/matches?on_conflict=provider,external_match_id`, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ ...fixture, provider_payload: {}, last_synced_at: syncedAt.toISOString() }),
      });
      if (!Array.isArray(result) || !result[0]) throw new M6RepositoryError("RESPONSE");
      return parseMatch(result[0]);
    },
    async getFixtureSyncState(provider) {
      const result = await request(`/rest/v1/fixture_sync_state?select=*&provider=eq.${encodeURIComponent(provider)}&limit=1`, {}, "app_private");
      if (!Array.isArray(result)) throw new M6RepositoryError("RESPONSE");
      const value = result[0];
      if (!value) return null;
      const source = row(value);
      return {
        provider: typeof source.provider === "string" ? source.provider : provider,
        last_full_sync_at: nullableString(source.last_full_sync_at),
        last_attempt_at: nullableString(source.last_attempt_at),
        last_success_at: nullableString(source.last_success_at),
        last_error_category: nullableString(source.last_error_category),
        rate_limit_remaining: nullableNumber(source.rate_limit_remaining),
      } satisfies FixtureSyncState;
    },
    async saveFixtureSyncState(state) {
      await request(`/rest/v1/fixture_sync_state?on_conflict=provider`, { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(state) }, "app_private");
    },
    async insertAlertEventIfAbsent(event: FixtureAlertEvent) {
      const result = await request(`/rest/v1/telegram_alert_events?on_conflict=event_fingerprint`, { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(event) }, "app_private");
      return Array.isArray(result) && result.length > 0;
    },
  };
}
