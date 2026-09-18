import type { CandidateProjectionInput } from "./mapper.ts";
import type { NotionSyncRepository, SyncState } from "./orchestrator.ts";

export type NotionSyncRepositoryErrorCode =
  | "DATABASE_CONFIGURATION_ERROR"
  | "DATABASE_NETWORK_ERROR"
  | "DATABASE_HTTP_ERROR"
  | "DATABASE_RESPONSE_ERROR";

export class NotionSyncRepositoryError extends Error {
  constructor(
    readonly code: NotionSyncRepositoryErrorCode,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "NotionSyncRepositoryError";
  }
}

export interface NotionSyncRepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey?: string;
  readonly secretKey?: string;
  readonly fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

const CANDIDATE_FIELDS = [
  "id",
  "story_cluster_id",
  "ranking_date",
  "rank",
  "priority_score",
  "data_confidence",
  "first_mover_flag",
  "must_cover_flag",
  "korea_coverage_status",
  "global_spread_score",
  "engagement_outperformance_score",
  "engagement_velocity_score",
  "velocity_acceleration_score",
  "korea_gap_score",
  "first_mover_score",
  "korean_saturation_score",
  "reliability_score",
  "source_diversity_score",
  "freshness_score",
  "score_inputs",
  "calculated_at",
].join(",");

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR");
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function clusterIds(values: readonly CandidateProjectionInput[]): string[] {
  return [...new Set(values.map((value) => value.candidate.story_cluster_id))].sort();
}

function inFilter(values: readonly string[]): string {
  return `in.(${values.join(",")})`;
}

function nestedObject(value: unknown): JsonObject | null {
  if (object(value)) return value;
  if (Array.isArray(value) && object(value[0])) return value[0];
  return null;
}

export function createNotionSyncRepository(
  options: NotionSyncRepositoryOptions,
): NotionSyncRepository {
  const serviceRoleKey = options.serviceRoleKey ?? options.secretKey;
  if (!options.supabaseUrl.trim() || !serviceRoleKey?.trim()) {
    throw new NotionSyncRepositoryError("DATABASE_CONFIGURATION_ERROR");
  }

  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    accept: "application/json",
  };

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      });
    } catch {
      throw new NotionSyncRepositoryError("DATABASE_NETWORK_ERROR");
    }
    if (!response.ok) throw new NotionSyncRepositoryError("DATABASE_HTTP_ERROR", response.status);
    if (response.status === 204) return null;
    try {
      const body = await response.text();
      return body.trim() === "" ? null : JSON.parse(body);
    } catch {
      throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR", response.status);
    }
  }

  async function listCandidates(): Promise<readonly CandidateProjectionInput[]> {
    const rawCandidates = await request(
      `/rest/v1/content_candidates?select=${encodeURIComponent(CANDIDATE_FIELDS)}&order=ranking_date.desc,rank.asc.nullslast&limit=1000`,
    );
    if (!Array.isArray(rawCandidates)) throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR");

    const rows = rawCandidates.filter(object).map((row) => ({
      id: stringValue(row.id, "id"),
      story_cluster_id: stringValue(row.story_cluster_id, "story_cluster_id"),
      ranking_date: stringValue(row.ranking_date, "ranking_date"),
      rank: typeof row.rank === "number" ? row.rank : null,
      priority_score: nullableNumber(row.priority_score),
      data_confidence: nullableNumber(row.data_confidence),
      first_mover_flag: booleanValue(row.first_mover_flag),
      must_cover_flag: booleanValue(row.must_cover_flag),
      korea_coverage_status: row.korea_coverage_status === "KNOWN" ? "KNOWN" as const : "UNCERTAIN" as const,
      global_spread_score: nullableNumber(row.global_spread_score),
      engagement_outperformance_score: nullableNumber(row.engagement_outperformance_score),
      engagement_velocity_score: nullableNumber(row.engagement_velocity_score),
      velocity_acceleration_score: nullableNumber(row.velocity_acceleration_score),
      korea_gap_score: nullableNumber(row.korea_gap_score),
      first_mover_score: nullableNumber(row.first_mover_score),
      korean_saturation_score: nullableNumber(row.korean_saturation_score),
      reliability_score: nullableNumber(row.reliability_score),
      source_diversity_score: nullableNumber(row.source_diversity_score),
      freshness_score: nullableNumber(row.freshness_score),
      score_inputs: object(row.score_inputs) ? row.score_inputs : {},
      calculated_at: stringValue(row.calculated_at, "calculated_at"),
    }));
    const ids = clusterIds(rows.map((candidate) => ({ candidate, cluster: {} as never, references: [] })));
    if (ids.length === 0) return [];

    const [rawClusters, rawPosts] = await Promise.all([
      request(`/rest/v1/story_clusters?select=id,canonical_title,status,first_seen_at,last_seen_at&id=${inFilter(ids)}`),
      request(`/rest/v1/story_cluster_posts?select=story_cluster_id,raw_post_id,raw_posts(permalink,published_at,source_accounts(username,region))&story_cluster_id=${inFilter(ids)}`),
    ]);
    if (!Array.isArray(rawClusters) || !Array.isArray(rawPosts)) {
      throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR");
    }

    const clusters = new Map<string, JsonObject>();
    for (const value of rawClusters) {
      if (object(value)) clusters.set(stringValue(value.id, "cluster.id"), value);
    }
    const references = new Map<string, CandidateProjectionInput["references"]>();
    for (const value of rawPosts) {
      if (!object(value)) continue;
      const clusterId = stringValue(value.story_cluster_id, "story_cluster_posts.story_cluster_id");
      const post = nestedObject(value.raw_posts);
      const account = nestedObject(post?.source_accounts);
      if (!post || !account) continue;
      const existing = references.get(clusterId) ?? [];
      existing.push({
        username: stringValue(account.username, "source_accounts.username"),
        region: stringValue(account.region, "source_accounts.region"),
        permalink: typeof post.permalink === "string" ? post.permalink : null,
        published_at: typeof post.published_at === "string" ? post.published_at : null,
      });
      references.set(clusterId, existing);
    }

    return rows.map((candidate) => {
      const cluster = clusters.get(candidate.story_cluster_id);
      if (!cluster) throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR");
      return {
        candidate,
        cluster: {
          id: candidate.story_cluster_id,
          canonical_title: typeof cluster.canonical_title === "string" ? cluster.canonical_title : null,
          status: stringValue(cluster.status, "story_clusters.status"),
          first_seen_at: stringValue(cluster.first_seen_at, "story_clusters.first_seen_at"),
          last_seen_at: stringValue(cluster.last_seen_at, "story_clusters.last_seen_at"),
        },
        references: references.get(candidate.story_cluster_id) ?? [],
      };
    });
  }

  async function listStates(): Promise<readonly SyncState[]> {
    const raw = await request(
      "/rest/v1/notion_sync_state?select=sync_identity,candidate_id,story_cluster_id,ranking_date,notion_page_id,last_synced_hash,last_synced_at,sync_status,last_error_category&order=ranking_date.desc&limit=5000",
      { headers: { "accept-profile": "app_private" } },
    );
    if (!Array.isArray(raw)) throw new NotionSyncRepositoryError("DATABASE_RESPONSE_ERROR");
    return raw.filter(object).map((value) => ({
      sync_identity: stringValue(value.sync_identity, "sync_identity"),
      candidate_id: stringValue(value.candidate_id, "candidate_id"),
      story_cluster_id: stringValue(value.story_cluster_id, "story_cluster_id"),
      ranking_date: stringValue(value.ranking_date, "ranking_date"),
      notion_page_id: typeof value.notion_page_id === "string" ? value.notion_page_id : null,
      last_synced_hash: typeof value.last_synced_hash === "string" ? value.last_synced_hash : null,
      last_synced_at: typeof value.last_synced_at === "string" ? value.last_synced_at : null,
      sync_status: value.sync_status === "DROPPED" || value.sync_status === "EXPIRED" || value.sync_status === "FAILED"
        ? value.sync_status
        : "CURRENT",
      last_error_category: typeof value.last_error_category === "string" ? value.last_error_category : null,
    }));
  }

  async function saveState(state: SyncState): Promise<void> {
    await request("/rest/v1/notion_sync_state?on_conflict=sync_identity", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "prefer": "resolution=merge-duplicates,return=minimal",
        "accept-profile": "app_private",
        "content-profile": "app_private",
      },
      body: JSON.stringify(state),
    });
  }

  return { listCandidates, listStates, saveState };
}
