import type { DiscoveryObservation } from "../trend-discovery/types.ts";
import type { DiscoveryPromotionRepository, PromotionObservation, PromotionStory, PromotionStoryInput } from "./types.ts";

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function observation(value: unknown): PromotionObservation | null {
  const row = record(value);
  const providerId = string(row.provider_id);
  const sourceCanonicalName = string(row.source_canonical_name);
  const externalId = string(row.external_id);
  const canonicalUrl = string(row.canonical_url);
  const title = string(row.title);
  const observedAt = string(row.last_observed_at);
  const firstObservedAt = string(row.first_observed_at) ?? observedAt;
  const lastObservedAt = observedAt ?? firstObservedAt;
  const sourceRole = row.editorial_role;
  const platform = row.platform;
  const publishedAt = row.published_at === null ? null : string(row.published_at);
  if (!providerId || !sourceCanonicalName || !externalId || !canonicalUrl || !title || !firstObservedAt || !lastObservedAt || typeof sourceRole !== "string" || typeof platform !== "string" || !string(row.content_fingerprint)) return null;
  return {
    id: String(row.id ?? ""),
    providerId,
    sourceCanonicalName,
    sourceRole: sourceRole as DiscoveryObservation["sourceRole"],
    externalId,
    canonicalUrl,
    title,
    excerpt: row.excerpt === null ? null : string(row.excerpt),
    publishedAt,
    observedAt: lastObservedAt,
    firstObservedAt,
    lastObservedAt,
    platform: platform as DiscoveryObservation["platform"],
    engagement: record(row.engagement),
    engagementAvailable: row.engagement_available === true,
    discoveryQueryId: string(row.discovery_query_id) ?? "",
    contentFingerprint: string(row.content_fingerprint)!,
    metadata: record(row.metadata),
    storyClusterId: typeof row.story_cluster_id === "string" ? row.story_cluster_id : null,
  };
}

function story(value: unknown): PromotionStory | null {
  const row = record(value);
  const id = string(row.id);
  const canonicalTitle = string(row.canonical_title);
  const firstSeenAt = string(row.first_seen_at);
  const lastSeenAt = string(row.last_seen_at);
  if (!id || !canonicalTitle || !firstSeenAt || !lastSeenAt) return null;
  return {
    id,
    canonicalTitle,
    summary: row.summary === null ? null : string(row.summary),
    topic: row.topic === null ? null : string(row.topic),
    firstSeenAt,
    lastSeenAt,
    promotionKey: row.discovery_promotion_key === null ? null : string(row.discovery_promotion_key),
    signature: record(row.signature_json),
  };
}

export function createDiscoveryPromotionRepository(options: RepositoryOptions): DiscoveryPromotionRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("DATABASE_CONFIGURATION_ERROR");
  const base = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.request ?? fetch;
  async function request(path: string, init: RequestInit = {}, profile?: "app_private"): Promise<unknown> {
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: {
        apikey: options.serviceRoleKey,
        authorization: `Bearer ${options.serviceRoleKey}`,
        accept: "application/json",
        ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("DATABASE_HTTP_ERROR");
    }
    const body = await response.text();
    return body.trim() ? JSON.parse(body) : null;
  }

  async function first(path: string, init: RequestInit = {}, profile?: "app_private"): Promise<Record<string, unknown> | null> {
    const value = await request(path, init, profile);
    return Array.isArray(value) && record(value[0]) ? value[0] : null;
  }

  return {
    async listFreshUnassigned(asOf, limit, promotionJobId) {
      const since = new Date(asOf.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const query = new URLSearchParams({
        select: "id,provider_id,source_canonical_name,editorial_role,external_id,canonical_url,title,excerpt,published_at,first_observed_at,last_observed_at,platform,engagement,engagement_available,discovery_query_id,content_fingerprint,metadata,story_cluster_id",
        last_observed_at: `gte.${since}`,
        order: "last_observed_at.asc,id.asc",
        limit: String(Math.max(1, Math.min(500, limit))),
      });
      if (promotionJobId) query.set("or", `(story_cluster_id.is.null,promotion_job_id.eq.${promotionJobId})`);
      else query.set("story_cluster_id", "is.null");
      query.append("last_observed_at", `lte.${asOf.toISOString()}`);
      const rows = await request(`/rest/v1/discovery_observations?${query}`, {}, "app_private");
      return Array.isArray(rows) ? rows.flatMap((value) => { const item = observation(value); return item?.id ? [item] : []; }) : [];
    },
    async listStories() {
      const query = new URLSearchParams({ select: "id,canonical_title,summary,topic,first_seen_at,last_seen_at,signature_json,discovery_promotion_key", status: "neq.ARCHIVED", limit: "2000" });
      const rows = await request(`/rest/v1/story_clusters?${query}`);
      return Array.isArray(rows) ? rows.flatMap((value) => { const item = story(value); return item ? [item] : []; }) : [];
    },
    async upsertStory(input: PromotionStoryInput) {
      const key = encodeURIComponent(input.promotionKey);
      const existing = await first(`/rest/v1/story_clusters?select=id&discovery_promotion_key=eq.${key}&limit=1`);
      const payload = {
        canonical_title: input.canonicalTitle,
        summary: input.summary,
        topic: input.topic,
        first_seen_at: input.firstSeenAt,
        last_seen_at: input.lastSeenAt,
        status: "OPEN",
        signature_json: input.signature,
        signature_version: "m8-6-v1",
        discovery_promotion_key: input.promotionKey,
      };
      if (existing && typeof existing.id === "string") {
        await request(`/rest/v1/story_clusters?id=eq.${encodeURIComponent(existing.id)}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify(payload) });
        return { id: existing.id, created: false };
      }
      const inserted = await first("/rest/v1/story_clusters", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(payload) });
      if (!inserted || typeof inserted.id !== "string") throw new Error("STORY_PROMOTION_PERSISTENCE_ERROR");
      return { id: inserted.id, created: true };
    },
    async assignObservation(observationId, storyClusterId, promotionJobId) {
      await request(`/rest/v1/discovery_observations?id=eq.${encodeURIComponent(observationId)}&story_cluster_id=is.null`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ story_cluster_id: storyClusterId, ...(promotionJobId ? { promotion_job_id: promotionJobId } : {}) }) }, "app_private");
    },
    async ensureSourceObservation(item) {
      const sourceQuery = new URLSearchParams({ select: "id", canonical_name: `eq.${item.sourceCanonicalName}`, limit: "1" });
      let source = await first(`/rest/v1/information_sources?${sourceQuery}`);
      if (!source || typeof source.id !== "string") {
        source = await first("/rest/v1/information_sources", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ canonical_name: item.sourceCanonicalName, entity_type: "MEDIA_OUTLET", aliases: [], website_url: new URL(item.canonicalUrl).origin, reliability_score: 0, reliability_rationale: "Discovery provider; not a verification source.", editorial_role: item.sourceRole, active: true }) });
      }
      if (!source || typeof source.id !== "string") throw new Error("SOURCE_REGISTRY_PERSISTENCE_ERROR");
      const payload = { information_source_id: source.id, editorial_role: item.sourceRole, external_id: item.externalId, canonical_url: item.canonicalUrl, title: item.title, excerpt: item.excerpt, published_at: item.publishedAt, observed_at: item.lastObservedAt, discovery_signal: 0.7, content_fingerprint: item.contentFingerprint, metadata: { ...item.metadata, discovery_observation_id: item.id } };
      const saved = await first("/rest/v1/source_observations?on_conflict=information_source_id%2Cexternal_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) }, "app_private");
      if (!saved || typeof saved.id !== "string") throw new Error("SOURCE_OBSERVATION_PERSISTENCE_ERROR");
      return saved.id;
    },
    async ensureDiscoveryClaim(input) {
      const source = await first(`/rest/v1/discovery_observations?select=title,excerpt,editorial_role&id=eq.${encodeURIComponent(input.observationId)}&limit=1`, {}, "app_private");
      const title = string(source?.title) ?? `Discovery observation ${input.observationId}`;
      const role = string(source?.editorial_role) ?? "DISCOVERY_COMMUNITY";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.storyClusterId}\u0000${input.observationId}\u0000${title}`));
      const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const claim = await first("/rest/v1/story_claims?on_conflict=story_cluster_id%2Cclaim_fingerprint%2Cgrounding_version", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ story_cluster_id: input.storyClusterId, raw_post_id: null, discovery_observation_id: input.observationId, claim_fingerprint: fingerprint, subject: "Manchester United", predicate: "reported", object: title, claim_text: title, origin: "discovery_observation", extraction_confidence: null, grounding_status: input.status, grounding_confidence: null, grounding_version: "m8-6-discovery-v1", decision_reason: "DISCOVERY_SIGNAL_WITHOUT_FACT_GROUNDING" }) }, "app_private");
      if (!claim || typeof claim.id !== "string") throw new Error("DISCOVERY_CLAIM_PERSISTENCE_ERROR");
      await request("/rest/v1/claim_evidence?on_conflict=claim_id%2Csource_observation_id%2Crelation", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ claim_id: claim.id, source_observation_id: input.sourceObservationId, relation: "SUPPORTS", editorial_role: role, evidence_text: title, evidence_confidence: 0.5, is_grounding: false }) }, "app_private");
    },
    async ensureEditorialCandidate(input) {
      const scoring = await first("/rest/v1/scoring_configs?select=id&is_active=eq.true&limit=1");
      if (!scoring || typeof scoring.id !== "string") throw new Error("SCORING_CONFIG_UNAVAILABLE");
      const zero = { story_cluster_id: input.storyClusterId, scoring_config_id: scoring.id, global_spread_score: 0, engagement_outperformance_score: 0, engagement_velocity_score: 0, velocity_acceleration_score: 0, korea_gap_score: 0, first_mover_score: 0, korean_saturation_score: 0, reliability_score: 0, source_diversity_score: 0, freshness_score: 0, data_confidence: 0, first_mover_flag: false, must_cover_flag: false, rank: null, ranking_date: input.rankingDate, recommendation_reason: "DISCOVERY_LEAD", score_inputs: { source: input.observation.providerId, content_fingerprint: input.observation.contentFingerprint } };
      await request("/rest/v1/content_candidates?on_conflict=story_cluster_id%2Cranking_date%2Cscoring_config_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(zero) });
    },
  };
}
