import type { DiscoveryObservation, DiscoveryQuery, DiscoveryRunSummary, DiscoveryMode, DiscoverySearchProfile, TrendSnapshot } from "./types.ts";

export interface UpsertObservationResult {
  readonly inserted: boolean;
  readonly observationId: string;
  readonly storyClusterId: string | null;
}

export interface TrendDiscoveryRepository {
  createRun(input: { mode: DiscoveryMode; startedAt: string; searchProfile?: DiscoverySearchProfile }): Promise<string>;
  saveQuery(runId: string, query: DiscoveryQuery): Promise<string>;
  upsertObservation(observation: DiscoveryObservation, runId?: string): Promise<UpsertObservationResult>;
  saveSnapshot(snapshot: TrendSnapshot): Promise<boolean>;
  completeRun(runId: string, summary: DiscoveryRunSummary): Promise<void>;
}

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly fetch?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

interface DatabaseHttpDiagnostic {
  readonly code: string | null;
  readonly reason: string;
}

class DatabaseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly diagnostic: DatabaseHttpDiagnostic,
  ) {
    super(`DATABASE_HTTP_ERROR status=${status} code=${diagnostic.code ?? "UNKNOWN"} reason=${diagnostic.reason}`);
    this.name = "DatabaseHttpError";
  }
}

function databaseHttpDiagnostic(body: unknown): DatabaseHttpDiagnostic {
  const error = object(body);
  const rawCode = typeof error.code === "string" ? error.code : "";
  const code = /^[A-Za-z0-9_]{4,16}$/u.test(rawCode) ? rawCode : null;
  const message = typeof error.message === "string" ? error.message : "";
  const constraint = message.match(/\bconstraint\s+["']([a-z][a-z0-9_]{0,127})["']/iu)?.[1];
  const column = message.match(/\bcolumn\s+["']([a-z][a-z0-9_]{0,127})["']/iu)?.[1];
  if (constraint) return { code, reason: `constraint:${constraint}` };
  if (column) return { code, reason: `column:${column}` };

  const reason = message
    .replace(/\b(?:authorization|api[_-]?key|token|secret|password)\b\s*[:=]\s*\S+/giu, "[credential redacted]")
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/\S+/giu, "[url redacted]")
    .replace(/"(?:[^"]|"")*"/gu, '"[redacted]"')
    .replace(/'(?:[^']|'')*'/gu, "'[redacted]'")
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return { code, reason: reason || "database rejected request" };
}

export function createTrendDiscoveryRepository(options: RepositoryOptions): TrendDiscoveryRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("DATABASE_CONFIGURATION_ERROR");
  const base = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        apikey: options.serviceRoleKey,
        authorization: `Bearer ${options.serviceRoleKey}`,
        "content-type": "application/json",
        "accept-profile": "app_private",
        "content-profile": "app_private",
        ...init.headers,
      },
    });
    if (!response.ok) {
      let body: unknown = null;
      try {
        body = JSON.parse(await response.text());
      } catch {
        // Keep the response body out of logs when it is not a known JSON error shape.
      }
      throw new DatabaseHttpError(response.status, databaseHttpDiagnostic(body));
    }
    const text = await response.text();
    return text.trim() ? JSON.parse(text) : null;
  }
  return {
    async createRun(input) {
      const rows = await request("/rest/v1/discovery_runs", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ mode: input.mode, started_at: input.startedAt, search_profile: input.searchProfile ?? "MANUAL" }) });
      const id = Array.isArray(rows) && object(rows[0]).id;
      if (typeof id !== "string") throw new Error("DISCOVERY_RUN_PERSISTENCE_ERROR");
      return id;
    },
    async saveQuery(runId, query) {
      const rows = await request("/rest/v1/discovery_queries", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ run_id: runId, query_id: query.queryId, query_text: query.text, family: query.family, mode: query.mode, observation_window: query.window, window_start: query.windowStart, window_end: query.windowEnd, priority: query.priority, search_profile: query.searchProfile ?? "MANUAL" }) });
      const id = Array.isArray(rows) && object(rows[0]).id;
      if (typeof id !== "string") throw new Error("DISCOVERY_QUERY_PERSISTENCE_ERROR");
      return id;
    },
    async upsertObservation(observation, runId) {
      const query = new URLSearchParams({ select: "id,story_cluster_id", provider_id: `eq.${observation.providerId}`, external_id: `eq.${observation.externalId}`, limit: "1" });
      const existing = await request(`/rest/v1/discovery_observations?${query}`);
      const existingRow = Array.isArray(existing) && object(existing[0]) ? existing[0] : null;
      const payload = { provider_id: observation.providerId, source_canonical_name: observation.sourceCanonicalName, editorial_role: observation.sourceRole, external_id: observation.externalId, canonical_url: observation.canonicalUrl, title: observation.title, excerpt: observation.excerpt, published_at: observation.publishedAt, last_observed_at: observation.observedAt, platform: observation.platform, engagement: observation.engagement, engagement_available: observation.engagementAvailable, content_fingerprint: observation.contentFingerprint, metadata: { ...observation.metadata, ...(runId ? { last_run_id: runId } : {}) }, observation_count: existingRow ? undefined : 1 };
      let result: unknown;
      try {
        result = await request("/rest/v1/discovery_observations?on_conflict=provider_id%2Cexternal_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) });
      } catch (error) {
        if (error instanceof DatabaseHttpError) {
          console.error(JSON.stringify({
            event: "trend_discovery_observation_upsert_rejected",
            status: error.status,
            database_code: error.diagnostic.code,
            reason: error.diagnostic.reason,
            provider_id: observation.providerId,
            content_fingerprint_prefix: observation.contentFingerprint.slice(0, 16),
          }));
        }
        throw error;
      }
      const row = Array.isArray(result) && object(result[0]) ? result[0] : existingRow;
      if (!row || typeof row.id !== "string") throw new Error("DISCOVERY_OBSERVATION_PERSISTENCE_ERROR");
      return { inserted: !existingRow, observationId: row.id, storyClusterId: typeof row.story_cluster_id === "string" ? row.story_cluster_id : null };
    },
    async saveSnapshot(snapshot) {
      const rows = await request("/rest/v1/trend_snapshots?on_conflict=cluster_key%2Csnapshot_at", { method: "POST", headers: { prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ story_cluster_id: snapshot.storyClusterId, cluster_key: snapshot.clusterKey, snapshot_at: snapshot.snapshotAt, trend_score: snapshot.trendScore, velocity_score: snapshot.velocityScore, cross_source_score: snapshot.crossSourceScore, engagement_score: snapshot.engagementScore, freshness_score: snapshot.freshnessScore, novelty_score: snapshot.noveltyScore, manutd_relevance_score: snapshot.manutdRelevanceScore, trend_state: snapshot.state, opportunity_labels: snapshot.opportunityLabels, mention_count: snapshot.mentionCount, source_count: snapshot.sourceCount, platform_count: snapshot.platformCount, engagement_available: snapshot.engagementAvailable, input_snapshot: snapshot.inputSnapshot }) });
      return Array.isArray(rows) && rows.length > 0;
    },
    async completeRun(runId, summary) {
      await request(`/rest/v1/discovery_runs?id=eq.${encodeURIComponent(runId)}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ status: summary.status, completed_at: new Date().toISOString(), query_count: summary.queryCount, observation_count: summary.observationCount, new_observation_count: summary.newObservationCount, new_story_count: summary.newStoryCount, updated_story_count: summary.updatedStoryCount, provider_statuses: summary.providerStatuses, provider_failures: summary.providerStatuses.filter((item) => item.status === "FAILED"), duration_ms: summary.durationMs }) });
    },
  };
}
