import type { CanonicalFixture, StoredMatch } from "./fixture_types.ts";
import type { FixtureAlertEvent, FixtureSyncRepository, FixtureSyncState } from "./fixture_service.ts";
import type { CandidateReferencePost } from "./reference_media.ts";

export interface M6RepositoryOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

export interface BriefingCandidateRow {
  candidate_id: string;
  rank: number | null;
  priority_score: number | null;
  first_mover_flag: boolean;
  must_cover_flag: boolean;
  creative_status: string;
  reference_posts: readonly CandidateReferencePost[];
}

export interface M6Repository extends FixtureSyncRepository {
  listBriefingCandidates(rankingDate: string): Promise<readonly BriefingCandidateRow[]>;
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
    provider_updated_at: nullableString(source.provider_updated_at),
  };
}

export function createM6Repository(options: M6RepositoryOptions): M6Repository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new M6RepositoryError("CONFIGURATION");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}`, accept: "application/json" };

  async function request(path: string, init: RequestInit = {}, profile?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          ...headers,
          ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}),
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      });
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
      const result = await request(`/rest/v1/matches?select=*&external_match_id=eq.${encodeURIComponent(externalMatchId)}&provider=eq.espn&limit=1`);
      if (!Array.isArray(result)) throw new M6RepositoryError("RESPONSE");
      return result[0] ? parseMatch(result[0]) : null;
    },
    async upsertMatch(fixture, syncedAt) {
      const result = await request(`/rest/v1/matches?on_conflict=provider,external_match_id`, {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({ ...fixture, last_synced_at: syncedAt.toISOString() }),
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
      } satisfies FixtureSyncState;
    },
    async saveFixtureSyncState(state) {
      await request(`/rest/v1/fixture_sync_state?on_conflict=provider`, { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(state) }, "app_private");
    },
    async insertAlertEventIfAbsent(event: FixtureAlertEvent) {
      const result = await request(`/rest/v1/telegram_alert_events?on_conflict=event_fingerprint`, { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify(event) }, "app_private");
      return Array.isArray(result) && result.length > 0;
    },
    async listBriefingCandidates(rankingDate) {
      const rawCandidates = await request(`/rest/v1/content_candidates?select=id,rank,priority_score,first_mover_flag,must_cover_flag,story_cluster_id,creative_briefs(version,status)&ranking_date=eq.${encodeURIComponent(rankingDate)}&order=rank.asc.nullslast,priority_score.desc`);
      if (!Array.isArray(rawCandidates)) throw new M6RepositoryError("RESPONSE");
      const rawPosts = await request(`/rest/v1/story_cluster_posts?select=story_cluster_id,raw_post_id,match_confidence,raw_posts(permalink,published_at,media_type,media_product_type,source_accounts(username),media_assets(id,asset_type,carousel_index,storage_path))`);
      if (!Array.isArray(rawPosts)) throw new M6RepositoryError("RESPONSE");
      const postsByCluster = new Map<string, CandidateReferencePost[]>();
      for (const value of rawPosts) {
        if (!object(value) || typeof value.story_cluster_id !== "string" || typeof value.raw_post_id !== "string") continue;
        const rawPost = object(value.raw_posts) ? value.raw_posts : null;
        const account = rawPost && object(rawPost.source_accounts) ? rawPost.source_accounts : null;
        if (!rawPost || !account || typeof account.username !== "string") continue;
        const assets = Array.isArray(rawPost.media_assets) ? rawPost.media_assets.filter(object).flatMap((asset) => typeof asset.id === "string" && typeof asset.asset_type === "string" ? [{ id: asset.id, asset_type: asset.asset_type as CandidateReferencePost["media_assets"][number]["asset_type"], carousel_index: nullableNumber(asset.carousel_index), storage_path: nullableString(asset.storage_path) }] : []) : [];
        const existing = postsByCluster.get(value.story_cluster_id) ?? [];
        existing.push({ raw_post_id: value.raw_post_id, username: account.username, permalink: nullableString(rawPost.permalink), published_at: typeof rawPost.published_at === "string" ? rawPost.published_at : "1970-01-01T00:00:00Z", media_type: typeof rawPost.media_type === "string" ? rawPost.media_type : "UNKNOWN", media_product_type: nullableString(rawPost.media_product_type), match_confidence: nullableNumber(value.match_confidence), cited_source_reliability: null, media_assets: assets });
        postsByCluster.set(value.story_cluster_id, existing);
      }
      return rawCandidates.filter(object).map((candidate) => {
        const briefs = Array.isArray(candidate.creative_briefs) ? candidate.creative_briefs.filter(object) : [];
        const latest = briefs.sort((left, right) => (typeof right.version === "number" ? right.version : 0) - (typeof left.version === "number" ? left.version : 0))[0];
        return { candidate_id: typeof candidate.id === "string" ? candidate.id : "", rank: nullableNumber(candidate.rank), priority_score: nullableNumber(candidate.priority_score), first_mover_flag: candidate.first_mover_flag === true, must_cover_flag: candidate.must_cover_flag === true, creative_status: typeof latest?.status === "string" ? latest.status : "NOT_REQUESTED", reference_posts: postsByCluster.get(typeof candidate.story_cluster_id === "string" ? candidate.story_cluster_id : "") ?? [] };
      }).filter((candidate) => candidate.candidate_id !== "");
    },
  };
}
