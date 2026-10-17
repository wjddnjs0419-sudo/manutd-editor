import type { CanonicalFixture, StoredMatch } from "./fixture_types.ts";
import type { FixtureAlertEvent, FixtureSyncRepository, FixtureSyncState } from "./fixture_service.ts";
import type { CandidateReferencePost } from "./reference_media.ts";
import type { IntelligenceReadinessRecord, IntelligenceReadinessStatus } from "./readiness.ts";
import { isManchesterUnitedRelevant } from "../m8/manchester_united_relevance.ts";
import { safePublisherUrl } from "../../trend-discovery/google_news_resolution.ts";

export interface M6RepositoryOptions {
  supabaseUrl: string;
  serviceRoleKey: string;
  fetch?: typeof fetch;
}

export interface BriefingCandidateRow {
  candidate_id: string;
  candidate_type: "SOCIAL" | "FACT_SOURCE";
  readiness_counted?: boolean;
  rank: number | null;
  priority_score: number | null;
  first_mover_flag: boolean;
  must_cover_flag: boolean;
  creative_status: string;
  reference_posts: readonly CandidateReferencePost[];
  story_cluster_id?: string | null;
  editorial_rank: number | null;
  editorial_score?: number | null;
  grounding_status: string | null;
  news_eligible: boolean;
  title?: string | null;
  source_name?: string | null;
  source_url?: string | null;
}

export interface M6Repository extends FixtureSyncRepository {
  listBriefingCandidates(rankingDate: string, readinessStartedAt?: string): Promise<readonly BriefingCandidateRow[]>;
  getIntelligenceReadiness(rankingDate: string): Promise<IntelligenceReadinessRecord | null>;
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

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function postgrestJsonTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().replace(/Z$/u, "+00:00");
}

function canonicalPublisherUrl(value: string | null): string | null {
  if (!value) return null;
  const safe = safePublisherUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  for (const key of [...url.searchParams.keys()]) {
    const normalized = key.toLocaleLowerCase("en-US");
    if (normalized.startsWith("utm_") || ["gclid", "fbclid", "oc", "cmpid", "ref", "referrer"].includes(normalized)) {
      url.searchParams.delete(key);
    }
  }
  return url.toString();
}

function publisherHost(value: string): string | null {
  try {
    return new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "");
  } catch {
    return null;
  }
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
    async listBriefingCandidates(rankingDate, readinessStartedAt) {
      const candidateBasePath = `/rest/v1/content_candidates?select=id,rank,priority_score,first_mover_flag,must_cover_flag,story_cluster_id,score_inputs,created_at,creative_briefs(version,status)&ranking_date=eq.${encodeURIComponent(rankingDate)}&order=created_at.desc,rank.asc.nullslast,priority_score.desc&limit=1000`;
      const candidatePaths = readinessStartedAt
        ? [
          `${candidateBasePath}&score_inputs->>run_at=eq.${encodeURIComponent(postgrestJsonTimestamp(readinessStartedAt))}`,
          `${candidateBasePath}&score_inputs->>run_at=is.null`,
        ]
        : [candidateBasePath];
      const [candidateBatches, rawPosts, editorialRankings, factObservations, sources] = await Promise.all([
        Promise.all(candidatePaths.map((path) => request(path))),
        request(`/rest/v1/story_cluster_posts?select=story_cluster_id,raw_post_id,match_confidence,raw_posts(permalink,published_at,media_type,media_product_type,source_accounts(username),media_assets(id,asset_type,carousel_index,storage_path))`),
        request(`/rest/v1/editorial_rankings?select=story_cluster_id,rank,editorial_score,grounding_status,news_eligible&ranking_date=eq.${encodeURIComponent(rankingDate)}&order=rank.asc.nullslast`, {}, "app_private").catch(() => []),
        request(`/rest/v1/source_observations?select=id,information_source_id,editorial_role,title,canonical_url,observed_at&editorial_role=in.(FACT_PRIMARY,FACT_INDEPENDENT)&observed_at=gte.${encodeURIComponent(`${rankingDate}T00:00:00.000Z`)}&observed_at=lt.${encodeURIComponent(`${nextUtcDate(rankingDate)}T00:00:00.000Z`)}&order=observed_at.desc&limit=50`, {}, "app_private").catch(() => []),
        request("/rest/v1/information_sources?select=id,canonical_name,website_url&limit=500").catch(() => []),
      ]);
      if (candidateBatches.some((batch) => !Array.isArray(batch))) throw new M6RepositoryError("RESPONSE");
      const rawCandidates = candidateBatches.flatMap((batch) => Array.isArray(batch) ? batch : []);
      const currentCandidateIds = new Set((Array.isArray(candidateBatches[0]) ? candidateBatches[0] : []).filter(object).flatMap((candidate) => typeof candidate.id === "string" ? [candidate.id] : []));
      if (!Array.isArray(rawPosts)) throw new M6RepositoryError("RESPONSE");
      const rankingByCluster = new Map<string, { rank: number | null; editorialScore: number | null; groundingStatus: string | null; newsEligible: boolean }>();
      if (Array.isArray(editorialRankings)) for (const value of editorialRankings) if (object(value) && typeof value.story_cluster_id === "string") rankingByCluster.set(value.story_cluster_id, { rank: nullableNumber(value.rank), editorialScore: nullableNumber(value.editorial_score), groundingStatus: nullableString(value.grounding_status), newsEligible: value.news_eligible === true });
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
      const sourceNames = new Map<string, string>();
      const sourceNamesByHost = new Map<string, string>();
      if (Array.isArray(sources)) for (const source of sources) if (object(source) && typeof source.id === "string" && typeof source.canonical_name === "string") {
        sourceNames.set(source.id, source.canonical_name);
        if (typeof source.website_url === "string") {
          const host = publisherHost(source.website_url);
          if (host) sourceNamesByHost.set(host, source.canonical_name);
        }
      }

      // Prefer the exact readiness run, then use legacy candidates whose run_at was never recorded.
      // Editorial eligibility below still comes from today's latest ranking, so old scores cannot bypass grounding.
      const candidatesByCluster = new Map<string, BriefingCandidateRow>();
      const candidatesWithoutCluster: BriefingCandidateRow[] = [];
      for (const candidate of rawCandidates.filter(object)) {
        const briefs = Array.isArray(candidate.creative_briefs) ? candidate.creative_briefs.filter(object) : [];
        const latest = briefs.sort((left, right) => (typeof right.version === "number" ? right.version : 0) - (typeof left.version === "number" ? left.version : 0))[0];
        const clusterId = typeof candidate.story_cluster_id === "string" ? candidate.story_cluster_id : null;
        const editorial = clusterId ? rankingByCluster.get(clusterId) : undefined;
        const mapped: BriefingCandidateRow = { candidate_id: typeof candidate.id === "string" ? candidate.id : "", candidate_type: "SOCIAL", readiness_counted: !readinessStartedAt || currentCandidateIds.has(String(candidate.id ?? "")), rank: nullableNumber(candidate.rank), priority_score: nullableNumber(candidate.priority_score), first_mover_flag: candidate.first_mover_flag === true, must_cover_flag: candidate.must_cover_flag === true, creative_status: typeof latest?.status === "string" ? latest.status : "NOT_REQUESTED", reference_posts: postsByCluster.get(clusterId ?? "") ?? [], story_cluster_id: clusterId, editorial_rank: editorial?.rank ?? null, editorial_score: editorial?.editorialScore ?? null, grounding_status: editorial?.groundingStatus ?? (readinessStartedAt ? "INSUFFICIENT" : null), news_eligible: editorial?.newsEligible ?? false };
        if (!mapped.candidate_id) continue;
        if (clusterId) {
          if (!candidatesByCluster.has(clusterId)) candidatesByCluster.set(clusterId, mapped);
        } else candidatesWithoutCluster.push(mapped);
      }
      const candidateRows = [...candidatesByCluster.values(), ...candidatesWithoutCluster];
      const clusterIds = [...candidatesByCluster.keys()].filter((value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
      const [rawGoogleNews, claimEvidence, rawStoryClusters] = await Promise.all([
        clusterIds.length > 0
          ? request(`/rest/v1/discovery_observations?select=id,story_cluster_id,title,article_final_url,resolved_publisher_url,published_at,article_extraction_status,source_observation_id&provider_id=eq.google-news&url_resolution_status=eq.RESOLVED&story_cluster_id=in.${encodeURIComponent(`(${clusterIds.join(",")})`)}&order=published_at.desc.nullslast&limit=1000`, {}, "app_private").catch(() => [])
          : Promise.resolve([]),
        Array.isArray(factObservations) && factObservations.length > 0
          ? request(`/rest/v1/claim_evidence?select=claim_id,source_observation_id,editorial_role,is_grounding&source_observation_id=in.${encodeURIComponent(`(${factObservations.filter(object).flatMap((value) => typeof value.id === "string" ? [value.id] : []).join(",")})`)}&limit=5000`, {}, "app_private").catch(() => [])
          : Promise.resolve([]),
        clusterIds.length > 0
          ? request(`/rest/v1/story_clusters?select=id,canonical_title&id=in.${encodeURIComponent(`(${clusterIds.join(",")})`)}&limit=1000`).catch(() => [])
          : Promise.resolve([]),
      ]);
      const storyTitles = new Map<string, string>();
      if (Array.isArray(rawStoryClusters)) for (const value of rawStoryClusters) if (object(value) && typeof value.id === "string" && typeof value.canonical_title === "string") storyTitles.set(value.id, value.canonical_title);
      const googleNewsByCluster = new Map<string, { title: string; sourceName: string; sourceUrl: string }>();
      if (Array.isArray(rawGoogleNews)) for (const value of rawGoogleNews) {
        if (!object(value) || typeof value.story_cluster_id !== "string" || googleNewsByCluster.has(value.story_cluster_id)) continue;
        const url = canonicalPublisherUrl(nullableString(value.article_final_url) ?? nullableString(value.resolved_publisher_url));
        if (!url) continue;
        const host = publisherHost(url);
        googleNewsByCluster.set(value.story_cluster_id, {
          title: typeof value.title === "string" ? value.title : "",
          sourceName: (host ? sourceNamesByHost.get(host) : null) ?? host ?? "Publisher",
          sourceUrl: url,
        });
      }
      for (const candidate of candidateRows) {
        const linkedArticle = candidate.story_cluster_id ? googleNewsByCluster.get(candidate.story_cluster_id) : undefined;
        if (linkedArticle) {
          candidate.title = storyTitles.get(candidate.story_cluster_id!) ?? linkedArticle.title;
          candidate.source_name = linkedArticle.sourceName;
          candidate.source_url = linkedArticle.sourceUrl;
        } else if (candidate.story_cluster_id) {
          candidate.title = storyTitles.get(candidate.story_cluster_id) ?? candidate.title;
        }
      }

      const relatedClaimIds = Array.isArray(claimEvidence) ? claimEvidence.filter(object).flatMap((value) => typeof value.claim_id === "string" ? [value.claim_id] : []) : [];
      const relatedClaims = relatedClaimIds.length > 0
        ? await request(`/rest/v1/story_claims?select=id,story_cluster_id&id=in.${encodeURIComponent(`(${[...new Set(relatedClaimIds)].join(",")})`)}&limit=5000`, {}, "app_private").catch(() => [])
        : [];
      const clusterByClaim = new Map<string, string>();
      if (Array.isArray(relatedClaims)) for (const claim of relatedClaims) if (object(claim) && typeof claim.id === "string" && typeof claim.story_cluster_id === "string") clusterByClaim.set(claim.id, claim.story_cluster_id);
      const sourceCandidates = Array.isArray(factObservations) ? factObservations.filter(object).flatMap((observation) => {
        if (typeof observation.id !== "string" || typeof observation.information_source_id !== "string" || typeof observation.editorial_role !== "string" || !["FACT_PRIMARY", "FACT_INDEPENDENT"].includes(observation.editorial_role) || typeof observation.title !== "string" || typeof observation.canonical_url !== "string") return [];
        if (!isManchesterUnitedRelevant({ canonicalTitle: observation.title })) return [];
        const claimRows = Array.isArray(claimEvidence) ? claimEvidence.filter((value) => object(value) && value.source_observation_id === observation.id) : [];
        const clusterId = claimRows.flatMap((value) => typeof value.claim_id === "string" && clusterByClaim.has(value.claim_id) ? [clusterByClaim.get(value.claim_id)!] : []).find((id) => rankingByCluster.get(id)?.newsEligible === true && rankingByCluster.get(id)?.groundingStatus === "VERIFIED");
        if (!clusterId) return [];
        const editorial = rankingByCluster.get(clusterId)!;
        const link = googleNewsByCluster.get(clusterId);
        return [{ candidate_id: `source:${observation.id}`, candidate_type: "FACT_SOURCE" as const, readiness_counted: false, rank: null, priority_score: null, first_mover_flag: false, must_cover_flag: false, creative_status: "NOT_REQUESTED", reference_posts: [], story_cluster_id: clusterId, editorial_rank: editorial.rank, editorial_score: editorial.editorialScore, grounding_status: editorial.groundingStatus, news_eligible: editorial.newsEligible, title: storyTitles.get(clusterId) ?? link?.title ?? observation.title, source_name: link?.sourceName ?? sourceNames.get(observation.information_source_id) ?? "Fact source", source_url: link?.sourceUrl ?? canonicalPublisherUrl(observation.canonical_url) }];
      }) : [];
      const factSourceByCluster = new Map<string, BriefingCandidateRow>();
      for (const candidate of sourceCandidates) if (candidate.story_cluster_id && candidate.source_url && !factSourceByCluster.has(candidate.story_cluster_id)) factSourceByCluster.set(candidate.story_cluster_id, candidate);
      for (const candidate of candidateRows) {
        if (!candidate.story_cluster_id || candidate.source_url) continue;
        const factSource = factSourceByCluster.get(candidate.story_cluster_id);
        if (!factSource) continue;
        candidate.title = storyTitles.get(candidate.story_cluster_id) ?? factSource.title ?? candidate.title;
        candidate.source_name = factSource.source_name;
        candidate.source_url = factSource.source_url;
      }
      const candidates: BriefingCandidateRow[] = [...candidateRows, ...sourceCandidates];
      if (candidates.some((candidate) => candidate.editorial_rank !== null)) {
        candidates.sort((left, right) => (left.editorial_rank === null ? 1 : right.editorial_rank === null ? -1 : left.editorial_rank - right.editorial_rank)
          || ((right.editorial_score ?? -1) - (left.editorial_score ?? -1))
          || (left.source_url ? 0 : 1) - (right.source_url ? 0 : 1)
          || (left.rank === null ? 1 : right.rank === null ? -1 : left.rank - right.rank)
          || ((right.priority_score ?? -1) - (left.priority_score ?? -1)));
      }
      return candidates;
    },
    async getIntelligenceReadiness(rankingDate): Promise<IntelligenceReadinessRecord | null> {
      const result = await request(`/rest/v1/intelligence_readiness?select=ranking_date,status,candidate_count,started_at,completed_at,error_category&ranking_date=eq.${encodeURIComponent(rankingDate)}&limit=1`, {}, "app_private");
      if (!Array.isArray(result) || !object(result[0])) return null;
      const value = result[0];
      const status = value.status;
      if (typeof value.ranking_date !== "string" || (status !== "RUNNING" && status !== "SUCCEEDED" && status !== "FAILED") || typeof value.candidate_count !== "number" || typeof value.started_at !== "string") throw new M6RepositoryError("RESPONSE");
      return {
        ranking_date: value.ranking_date,
        status: status as IntelligenceReadinessStatus,
        candidate_count: value.candidate_count,
        started_at: value.started_at,
        completed_at: nullableString(value.completed_at),
        error_category: nullableString(value.error_category),
      };
    },
  };
}
