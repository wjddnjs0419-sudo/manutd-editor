import type { DiscoveryObservation } from "../trend-discovery/types.ts";
import { isGoogleNewsArticleUrl, safePublisherUrl } from "../trend-discovery/google_news_resolution.ts";
import { matchReviewedPublisher, type PublisherRegistryEntry } from "./publisher_evidence.ts";
import { articleEvidenceSentences, inferClaimModality } from "../ground-claims/matcher.ts";
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
  const googleNewsOriginalUrl = providerId === "google-news"
    ? string(row.google_news_original_url) ?? string(record(row.metadata).google_news_url) ?? canonicalUrl
    : null;
  const articleExtractionStatus = string(row.article_extraction_status) ?? "NOT_ATTEMPTED";
  const articleFetchStatus = string(row.article_fetch_status) ?? "NOT_ATTEMPTED";
  const publisherCanonicalUrl = providerId === "google-news"
    ? safePublisherUrl(string(row.article_final_url) ?? string(row.resolved_publisher_url) ?? "")
    : safePublisherUrl(canonicalUrl);
  const excerpt = providerId === "google-news"
    ? articleExtractionStatus === "EXTRACTED" ? string(row.article_content_excerpt) : null
    : row.excerpt === null ? null : string(row.excerpt);
  const metadata = {
    ...record(row.metadata),
    ...(providerId === "google-news" ? {
      google_news_original_url: googleNewsOriginalUrl,
      google_news_article_id: string(row.google_news_article_id),
      resolved_publisher_url: publisherCanonicalUrl,
      url_resolution_status: string(row.url_resolution_status),
      article_fetch_status: articleFetchStatus,
      article_extraction_status: articleExtractionStatus,
    } : {}),
  };
  return {
    id: String(row.id ?? ""),
    providerId,
    sourceCanonicalName,
    sourceRole: sourceRole as DiscoveryObservation["sourceRole"],
    externalId,
    canonicalUrl,
    title,
    excerpt,
    publishedAt,
    observedAt: lastObservedAt,
    firstObservedAt,
    lastObservedAt,
    platform: platform as DiscoveryObservation["platform"],
    engagement: record(row.engagement),
    engagementAvailable: row.engagement_available === true,
    discoveryQueryId: string(row.discovery_query_id) ?? "",
    contentFingerprint: string(row.content_fingerprint)!,
    metadata,
    publisherCanonicalUrl,
    googleNewsOriginalUrl,
    articleFetchStatus,
    articleExtractionStatus,
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
      const responseBody = await response.text();
      if (response.status === 400) {
        try {
          const error = record(JSON.parse(responseBody));
          if (error.code === "42703" || error.code === "PGRST204" || (typeof error.message === "string" && /column .+(?:does not exist|not found in the schema cache)/iu.test(error.message))) {
            throw new Error("DATABASE_SCHEMA_COLUMNS_MISSING");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "DATABASE_SCHEMA_COLUMNS_MISSING") throw error;
        }
      }
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
    async listFreshUnassigned(asOf, limit, promotionJobId, promotionObservationId) {
      const since = new Date(asOf.getTime() - 72 * 60 * 60 * 1000).toISOString();
      const query = new URLSearchParams({
        select: promotionObservationId
          ? "id,provider_id,source_canonical_name,editorial_role,external_id,canonical_url,title,excerpt,published_at,first_observed_at,last_observed_at,platform,engagement,engagement_available,discovery_query_id,content_fingerprint,metadata,story_cluster_id"
          : "id,provider_id,source_canonical_name,editorial_role,external_id,canonical_url,google_news_original_url,google_news_article_id,resolved_publisher_url,article_final_url,url_resolution_status,article_fetch_status,article_extraction_status,article_content_excerpt,title,excerpt,published_at,first_observed_at,last_observed_at,platform,engagement,engagement_available,discovery_query_id,content_fingerprint,metadata,story_cluster_id",
        last_observed_at: `gte.${since}`,
        order: "last_observed_at.desc,id.asc",
        limit: String(promotionObservationId ? 1 : Math.max(1, Math.min(500, limit))),
      });
      if (promotionObservationId) {
        if (!promotionJobId) throw new Error("PROMOTION_OBSERVATION_REQUIRES_JOB_ID");
        query.set("id", `eq.${promotionObservationId}`);
        query.set("promotion_job_id", `eq.${promotionJobId}`);
        query.set("provider_id", "neq.google-news");
      } else {
        const andFilters = ["or(provider_id.neq.google-news,url_resolution_status.eq.RESOLVED)"];
        if (promotionJobId) andFilters.push(`or(story_cluster_id.is.null,promotion_job_id.eq.${promotionJobId})`);
        else andFilters.push("story_cluster_id.is.null");
        query.set("and", `(${andFilters.join(",")})`);
      }
      query.append("last_observed_at", `lte.${asOf.toISOString()}`);
      let rows: unknown;
      try {
        rows = await request(`/rest/v1/discovery_observations?${query}`, {}, "app_private");
      } catch (error) {
        if (promotionObservationId || !(error instanceof Error) || error.message !== "DATABASE_SCHEMA_COLUMNS_MISSING") throw error;
        const legacyQuery = new URLSearchParams({
          select: "id,provider_id,source_canonical_name,editorial_role,external_id,canonical_url,title,excerpt,published_at,first_observed_at,last_observed_at,platform,engagement,engagement_available,discovery_query_id,content_fingerprint,metadata,story_cluster_id",
          provider_id: "neq.google-news",
          last_observed_at: `gte.${since}`,
          order: "last_observed_at.desc,id.asc",
          limit: String(Math.max(1, Math.min(500, limit))),
        });
        if (promotionJobId) legacyQuery.set("and", `(or(story_cluster_id.is.null,promotion_job_id.eq.${promotionJobId}))`);
        else legacyQuery.set("story_cluster_id", "is.null");
        legacyQuery.append("last_observed_at", `lte.${asOf.toISOString()}`);
        rows = await request(`/rest/v1/discovery_observations?${legacyQuery}`, {}, "app_private");
      }
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
    async assignObservation(observationId, storyClusterId, sourceObservationId, promotionJobId) {
      const query = new URLSearchParams({
        id: `eq.${observationId}`,
        source_observation_id: "is.null",
        or: `(story_cluster_id.is.null,story_cluster_id.eq.${storyClusterId})`,
      });
      if (promotionJobId) query.set("promotion_job_id", `eq.${promotionJobId}`);
      await request(`/rest/v1/discovery_observations?${query}`, { method: "PATCH", headers: { prefer: "return=minimal" }, body: JSON.stringify({ story_cluster_id: storyClusterId, source_observation_id: sourceObservationId, ...(promotionJobId ? { promotion_job_id: promotionJobId } : {}) }) }, "app_private");
    },
    async ensureSourceObservation(item) {
      const isGoogleNews = item.providerId === "google-news";
      const sourceCanonicalName = isGoogleNews ? "Google News" : item.sourceCanonicalName;
      const sourceUrl = isGoogleNews ? item.canonicalUrl : item.publisherCanonicalUrl ?? item.canonicalUrl;
      const sourceQuery = new URLSearchParams({ select: "id", canonical_name: `eq.${sourceCanonicalName}`, limit: "1" });
      let source = await first(`/rest/v1/information_sources?${sourceQuery}`);
      if (!source || typeof source.id !== "string") {
        source = await first("/rest/v1/information_sources", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify({ canonical_name: sourceCanonicalName, entity_type: "MEDIA_OUTLET", aliases: [], website_url: isGoogleNews ? "https://news.google.com" : new URL(sourceUrl).origin, reliability_score: 0, reliability_rationale: "Discovery provider; not a verification source.", editorial_role: isGoogleNews ? "DISCOVERY_COMMUNITY" : item.sourceRole, active: true }) });
      }
      if (!source || typeof source.id !== "string") throw new Error("SOURCE_REGISTRY_PERSISTENCE_ERROR");
      const payload = { information_source_id: source.id, editorial_role: item.sourceRole, external_id: item.externalId, canonical_url: sourceUrl, title: item.title, excerpt: item.excerpt, published_at: item.publishedAt, observed_at: item.lastObservedAt, discovery_signal: 0.7, content_fingerprint: item.contentFingerprint, metadata: { ...item.metadata, discovery_observation_id: item.id, discovery_provider_id: item.providerId, discovery_external_id: item.externalId, ...(isGoogleNews ? { google_news_original_url: item.googleNewsOriginalUrl ?? item.canonicalUrl, google_news_article_id: item.metadata.google_news_article_id ?? null, resolved_publisher_url: item.publisherCanonicalUrl, article_extraction_status: item.articleExtractionStatus, article_fetch_status: item.articleFetchStatus, article_body_present: item.articleExtractionStatus === "EXTRACTED" && Boolean(item.excerpt?.trim()) } : {}) } };
      const saved = await first("/rest/v1/source_observations?on_conflict=information_source_id%2Cexternal_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) }, "app_private");
      if (!saved || typeof saved.id !== "string") throw new Error("SOURCE_OBSERVATION_PERSISTENCE_ERROR");
      return saved.id;
    },
    async ensureReviewedPublisherObservation(item) {
      if (item.providerId !== "google-news" || item.articleExtractionStatus !== "EXTRACTED" || !item.excerpt?.trim()) return null;
      const publisherUrl = safePublisherUrl(item.publisherCanonicalUrl ?? "");
      const originalGoogleNewsUrl = item.googleNewsOriginalUrl ?? item.canonicalUrl;
      if (!publisherUrl || !isGoogleNewsArticleUrl(originalGoogleNewsUrl)) return null;
      const registryQuery = new URLSearchParams({
        select: "id,canonical_name,website_url,editorial_role,reliability_score,active",
        active: "eq.true",
        editorial_role: "in.(FACT_PRIMARY,FACT_INDEPENDENT)",
        reliability_score: "gte.8",
        limit: "500",
      });
      const registryValue = await request(`/rest/v1/information_sources?${registryQuery}`);
      const registry = Array.isArray(registryValue) ? registryValue.flatMap((value) => {
        const row = record(value);
        if (typeof row.id !== "string" || typeof row.canonical_name !== "string" || typeof row.editorial_role !== "string" || typeof row.reliability_score !== "number" || typeof row.active !== "boolean") return [];
        return [{ id: row.id, canonical_name: row.canonical_name, website_url: string(row.website_url), editorial_role: row.editorial_role, reliability_score: row.reliability_score, active: row.active } satisfies PublisherRegistryEntry];
      }) : [];
      const match = matchReviewedPublisher(publisherUrl, registry);
      if (!match) return null;
      const excerpt = item.excerpt.trim().slice(0, 2_000);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${match.id}\u0000${publisherUrl}\u0000${excerpt}`));
      const contentFingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const rawSupportingSentence = string(item.metadata.supporting_sentence);
      const supportingSentence = rawSupportingSentence && excerpt.includes(rawSupportingSentence) ? rawSupportingSentence : null;
      const metadata = {
        google_news_original_url: originalGoogleNewsUrl,
        resolved_publisher_url: publisherUrl,
        article_fetch_status: item.articleFetchStatus,
        article_extraction_status: item.articleExtractionStatus,
        publisher_canonical_name: match.canonical_name,
        publisher_report_only: true,
        supporting_sentence: supportingSentence,
      };
      const payload = {
        information_source_id: match.id,
        editorial_role: match.editorial_role,
        external_id: publisherUrl,
        canonical_url: publisherUrl,
        title: item.title,
        excerpt,
        published_at: item.publishedAt,
        observed_at: item.lastObservedAt,
        discovery_signal: 0,
        content_fingerprint: contentFingerprint,
        metadata,
      };
      const saved = await first("/rest/v1/source_observations?on_conflict=information_source_id%2Cexternal_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(payload) }, "app_private");
      if (saved && typeof saved.id === "string") return saved.id;
      const lookup = new URLSearchParams({ select: "id", information_source_id: `eq.${match.id}`, external_id: `eq.${publisherUrl}`, limit: "1" });
      const existing = await first(`/rest/v1/source_observations?${lookup}`, {}, "app_private");
      return existing && typeof existing.id === "string" ? existing.id : null;
    },
    async ensurePublisherReportClaims(input) {
      const observation = input.observation;
      if (observation.providerId !== "google-news" || observation.articleExtractionStatus !== "EXTRACTED" || !observation.excerpt?.trim()) return;
      const publisherName = string(observation.metadata.publisher_canonical_name) ?? string(observation.metadata.publisher_name) ?? observation.sourceCanonicalName;
      const sentences = articleEvidenceSentences(observation.excerpt).filter((sentence) =>
        /\b(?:manchester united|manchester utd|man utd|man united|mufc)\b|맨유/iu.test(sentence)
      ).slice(0, 4);
      for (const sentence of sentences) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${input.storyClusterId}\u0000${input.publisherSourceObservationId}\u0000${sentence}`));
        const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        await request("/rest/v1/story_claims?on_conflict=story_cluster_id%2Cclaim_fingerprint%2Cgrounding_version", {
          method: "POST",
          headers: { prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            story_cluster_id: input.storyClusterId,
            raw_post_id: null,
            discovery_observation_id: observation.id,
            publisher_source_observation_id: input.publisherSourceObservationId,
            claim_fingerprint: fingerprint,
            subject: "Manchester United",
            predicate: "reported",
            object: sentence,
            claim_text: `${publisherName} reports: ${sentence}`,
            origin: "publisher_article",
            claim_scope: "PUBLISHER_REPORT",
            claim_modality: inferClaimModality(sentence),
            extraction_confidence: null,
            grounding_status: "INSUFFICIENT",
            grounding_confidence: null,
            grounding_version: "m8-b-v1",
            decision_reason: "PUBLISHER_REPORT_PENDING_GROUNDING",
          }),
        }, "app_private");
      }
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
  };
}
