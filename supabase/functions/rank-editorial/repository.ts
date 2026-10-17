import type { EditorialRankingInput, EditorialRankingRepository } from "./types.ts";
import { classifyManchesterUnitedRelevance } from "../_shared/m8/manchester_united_relevance.ts";

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (entry: Record<string, unknown>) => void;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function bounded(value: number): number { return Math.max(0, Math.min(100, value)); }
function date(value: unknown): Date | null { if (typeof value !== "string") return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; }
interface ClusterRow {
  readonly id: string;
  readonly last_seen_at: string | null;
  readonly canonical_title?: string;
  readonly summary?: string | null;
  readonly topic?: string | null;
  readonly signature_json?: unknown;
}

export function createEditorialRankingRepository(options: RepositoryOptions): EditorialRankingRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("Database configuration is required");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.request ?? fetch;
  const now = options.now ?? (() => new Date());
  const safeTables = new Set(["story_claims", "claim_evidence", "source_observations", "information_sources", "story_clusters", "story_cluster_posts", "matches", "editorial_rankings", "scoring_configs", "content_candidates", "discovery_observations"]);
  async function request(path: string, init: RequestInit, profile?: string, requestId?: string): Promise<unknown> {
    const startedAt = performance.now();
    const rawTable = path.match(/^\/rest\/v1\/([a-z_]+)/u)?.[1] ?? "unknown";
    const table = safeTables.has(rawTable) ? rawTable : "unknown";
    let statusClass = "0xx";
    let failureCode = "DATA_API_NETWORK_ERROR";
    const emit = (outcome: string, code?: string) => {
      try {
        options.log?.({ requestId: requestId ?? null, event: "rank_editorial_data_api", table, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), statusClass, outcome, ...(code ? { code } : {}) });
      } catch { /* Diagnostics must not change repository behavior. */ }
    };
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}`, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}), ...init.headers } });
      statusClass = `${Math.floor(response.status / 100)}xx`;
      if (!response.ok) {
        await response.body?.cancel();
        failureCode = "DATA_API_HTTP_ERROR";
        throw new Error("DATABASE_HTTP_ERROR");
      }
      const text = await response.text();
      const result = text.trim() === "" ? null : JSON.parse(text);
      emit("completed");
      return result;
    } catch (error) {
      emit("failed", failureCode);
      throw error;
    }
  }
  return {
    async listInputs(asOf, rankingDate, requestId) {
      const [claimsValue, evidenceValue, observationsValue, informationSourcesValue, clustersValue, clusterPostsValue, matchesValue, discoveryValue] = await Promise.all([
        request("/rest/v1/story_claims?select=id,story_cluster_id,grounding_status,grounding_confidence&limit=2000", { method: "GET" }, "app_private", requestId),
        request("/rest/v1/claim_evidence?select=claim_id,editorial_role,source_observation_id&limit=5000", { method: "GET" }, "app_private", requestId),
        request("/rest/v1/source_observations?select=id,information_source_id,discovery_signal,observed_at&limit=5000", { method: "GET" }, "app_private", requestId),
        request("/rest/v1/information_sources?select=id,reliability_score&limit=500", { method: "GET" }, undefined, requestId),
        request("/rest/v1/story_clusters?select=id,last_seen_at,canonical_title,summary,topic,signature_json&limit=1000", { method: "GET" }, undefined, requestId),
        request("/rest/v1/story_cluster_posts?select=story_cluster_id,raw_posts(source_accounts(username,priority_weight))&limit=5000", { method: "GET" }, undefined, requestId),
        request("/rest/v1/matches?select=id,status,kickoff_at&status=in.(SCHEDULED,LIVE)&limit=20", { method: "GET" }, undefined, requestId),
        request("/rest/v1/discovery_observations?select=story_cluster_id,article_content_excerpt,metadata&story_cluster_id=not.is.null&limit=1000", { method: "GET" }, "app_private", requestId),
      ]);
      const clusterRows = Array.isArray(clustersValue) ? clustersValue.filter((item): item is ClusterRow => record(item) && typeof item.id === "string") : [];
      const sourceUsernamesByCluster = new Map<string, string[]>();
      const rawDiscoveryByCluster = new Map<string, { count: number; signal: number }>();
      if (Array.isArray(clusterPostsValue)) for (const item of clusterPostsValue) {
        if (!record(item) || typeof item.story_cluster_id !== "string") continue;
        const rawPost = record(item.raw_posts) ? item.raw_posts : null;
        const sourceAccount = rawPost && record(rawPost.source_accounts) ? rawPost.source_accounts : null;
        if (sourceAccount && typeof sourceAccount.username === "string") {
          sourceUsernamesByCluster.set(item.story_cluster_id, [
            ...(sourceUsernamesByCluster.get(item.story_cluster_id) ?? []),
            sourceAccount.username,
          ]);
        }
        const priorityWeight = sourceAccount && typeof sourceAccount.priority_weight === "number" && Number.isFinite(sourceAccount.priority_weight)
          ? Math.max(0, Math.min(1, sourceAccount.priority_weight))
          : 1;
        const current = rawDiscoveryByCluster.get(item.story_cluster_id) ?? { count: 0, signal: 0 };
        current.count += 1;
        current.signal += 0.7 * priorityWeight;
        rawDiscoveryByCluster.set(item.story_cluster_id, current);
      }
      const discoveryByCluster = new Map<string, { body: string[]; entities: string[]; topics: string[] }>();
      if (Array.isArray(discoveryValue)) for (const item of discoveryValue) {
        if (!record(item) || typeof item.story_cluster_id !== "string") continue;
        const metadata = record(item.metadata) ? item.metadata : {};
        const current = discoveryByCluster.get(item.story_cluster_id) ?? { body: [], entities: [], topics: [] };
        if (typeof item.article_content_excerpt === "string") current.body.push(item.article_content_excerpt);
        if (Array.isArray(metadata.entities)) current.entities.push(...metadata.entities.filter((entry): entry is string => typeof entry === "string"));
        if (typeof metadata.topic_family === "string") current.topics.push(metadata.topic_family);
        discoveryByCluster.set(item.story_cluster_id, current);
      }
      const relevantClusterIds = new Set(clusterRows.filter((cluster) => {
        const discovery = discoveryByCluster.get(cluster.id) ?? { body: [], entities: [], topics: [] };
        const signature = record(cluster.signature_json) ? cluster.signature_json : {};
        const signatureEntities = Array.isArray(signature.entities) ? signature.entities.filter((entry): entry is string => typeof entry === "string") : [];
        const result = classifyManchesterUnitedRelevance({
          title: cluster.canonical_title,
          body: discovery.body.join(" "),
          entities: [...signatureEntities, ...discovery.entities],
          topic: [cluster.topic ?? "", ...discovery.topics].join(" "),
          sourceUsernames: sourceUsernamesByCluster.get(cluster.id),
        });
        return result.autoEligible;
      }).map((cluster) => cluster.id));
      const reliabilityBySourceId = new Map<string, number>();
      if (Array.isArray(informationSourcesValue)) for (const item of informationSourcesValue) {
        if (record(item) && typeof item.id === "string" && typeof item.reliability_score === "number" && Number.isFinite(item.reliability_score)) {
          reliabilityBySourceId.set(item.id, bounded(item.reliability_score * 10));
        }
      }
      const observationById = new Map<string, { signal: number; observedAt: Date | null; reliabilityScore: number | null }>();
      if (Array.isArray(observationsValue)) for (const item of observationsValue) if (record(item) && typeof item.id === "string") observationById.set(item.id, {
        signal: bounded(number(item.discovery_signal)),
        observedAt: date(item.observed_at),
        reliabilityScore: typeof item.information_source_id === "string" ? reliabilityBySourceId.get(item.information_source_id) ?? null : null,
      });
      const claimById = new Map<string, { clusterId: string; status: string; confidence: number }>();
      const claimRows = Array.isArray(claimsValue) ? claimsValue : [];
      for (const item of claimRows) if (record(item) && typeof item.id === "string" && typeof item.story_cluster_id === "string" && relevantClusterIds.has(item.story_cluster_id)) claimById.set(item.id, { clusterId: item.story_cluster_id, status: typeof item.grounding_status === "string" ? item.grounding_status : "INSUFFICIENT", confidence: bounded(number(item.grounding_confidence) * 100) });
      const stats = new Map<string, { verified: number; contradicted: number; factScore: number; discoveryCount: number; discoverySignal: number; freshness: Date | null }>();
      const ensure = (clusterId: string) => { const current = stats.get(clusterId) ?? { verified: 0, contradicted: 0, factScore: 0, discoveryCount: 0, discoverySignal: 0, freshness: null }; stats.set(clusterId, current); return current; };
      for (const claim of claimById.values()) { const current = ensure(claim.clusterId); if (claim.status === "VERIFIED") { current.verified += 1; current.factScore = Math.max(current.factScore, claim.confidence || 100); } if (claim.status === "CONTRADICTED") current.contradicted += 1; }
      if (Array.isArray(evidenceValue)) for (const item of evidenceValue) if (record(item) && typeof item.claim_id === "string" && typeof item.editorial_role === "string") {
        const claim = claimById.get(item.claim_id);
        const observation = typeof item.source_observation_id === "string" ? observationById.get(item.source_observation_id) : undefined;
        if (!claim || !observation) continue;
        const current = ensure(claim.clusterId);
        if (item.editorial_role.startsWith("DISCOVERY_")) {
          current.discoveryCount += 1;
          current.discoverySignal += observation.signal;
        }
        if (claim.status === "VERIFIED" && (item.editorial_role === "FACT_PRIMARY" || item.editorial_role === "FACT_INDEPENDENT")) {
          current.factScore = Math.max(current.factScore, observation.reliabilityScore ?? claim.confidence);
        }
      }
      for (const [clusterId, discovery] of rawDiscoveryByCluster) { if (!relevantClusterIds.has(clusterId)) continue; const current = ensure(clusterId); current.discoveryCount += discovery.count; current.discoverySignal += discovery.signal; }
      for (const item of clusterRows) if (relevantClusterIds.has(item.id)) { const current = ensure(item.id); current.freshness = date(item.last_seen_at); }
      const hasMatchContext = Array.isArray(matchesValue) && matchesValue.length > 0;
      const reference = asOf ?? now();
      const targetDate = rankingDate ?? reference.toISOString().slice(0, 10);
      return [...stats.entries()].map(([storyClusterId, current]): EditorialRankingInput => {
        const freshnessHours = current.freshness ? Math.max(0, (reference.getTime() - current.freshness.getTime()) / 3_600_000) : 72;
        const freshnessScore = bounded(100 - (freshnessHours / 48) * 100);
        const factGroundingScore = bounded(current.factScore);
        const groundingStatus = current.contradicted > 0 ? "CONTRADICTED" : current.verified > 0 ? "VERIFIED" : current.discoveryCount > 0 ? "DISCOVERY_ONLY" : "INSUFFICIENT";
        return { storyClusterId, rankingDate: targetDate, groundingStatus, factGroundingScore, discoveryAudienceSignalScore: bounded(current.discoverySignal * 100), matchContextScore: hasMatchContext ? 100 : 0, freshnessScore, informationGapScore: bounded(current.discoveryCount > 0 ? 100 - factGroundingScore : 0), verifiedClaimCount: current.verified, contradictedClaimCount: current.contradicted, discoveryObservationCount: current.discoveryCount };
      });
    },
    async clearRankings(rankingDate, rankingVersion, requestId) {
      await request(`/rest/v1/editorial_rankings?ranking_date=eq.${encodeURIComponent(rankingDate)}&ranking_version=eq.${encodeURIComponent(rankingVersion)}`, { method: "DELETE", headers: { prefer: "return=minimal" } }, "app_private", requestId);
    },
    async upsertRanking(ranking, requestId) {
      await request("/rest/v1/editorial_rankings?on_conflict=story_cluster_id%2Cranking_date%2Cranking_version", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ story_cluster_id: ranking.storyClusterId, ranking_date: ranking.rankingDate, ranking_version: ranking.rankingVersion, editorial_score: ranking.editorialScore, information_gap_score: ranking.informationGapScore, fact_grounding_score: ranking.factGroundingScore, discovery_audience_signal_score: ranking.discoveryAudienceSignalScore, match_context_score: ranking.matchContextScore, freshness_score: ranking.freshnessScore, rank: ranking.rank, news_eligible: ranking.newsEligible, grounding_status: ranking.groundingStatus, reason_codes: ranking.reasonCodes, input_snapshot: ranking.inputSnapshot }) }, "app_private", requestId);
      const configsValue = await request("/rest/v1/scoring_configs?select=id&is_active=eq.true&limit=1", { method: "GET" }, undefined, requestId);
      const config = Array.isArray(configsValue) ? configsValue.map((entry) => record(entry) ? entry : null).find((entry) => entry && typeof entry.id === "string") : null;
      if (!config || typeof config.id !== "string") throw new Error("SCORING_CONFIG_UNAVAILABLE");
      const identity = `story_cluster_id=eq.${encodeURIComponent(ranking.storyClusterId)}&ranking_date=eq.${encodeURIComponent(ranking.rankingDate)}&scoring_config_id=eq.${encodeURIComponent(config.id)}`;
      const existingValue = await request(`/rest/v1/content_candidates?select=id,score_inputs&${identity}&limit=1`, { method: "GET" }, undefined, requestId);
      const existing = Array.isArray(existingValue) ? existingValue.map((entry) => record(entry) ? entry : null).find((entry) => entry && typeof entry.id === "string") : null;
      const previousInputs = existing && record(existing.score_inputs) ? existing.score_inputs : {};
      const m8EditorialRanking = {
        ranking_version: ranking.rankingVersion,
        ranking_date: ranking.rankingDate,
        rank: ranking.rank,
        editorial_score: ranking.editorialScore,
        news_eligible: ranking.newsEligible,
        reason_codes: ranking.reasonCodes,
        grounding_status: ranking.groundingStatus,
        fact_grounding_score: ranking.factGroundingScore,
      };
      const projection = { data_confidence: ranking.factGroundingScore, score_inputs: { ...previousInputs, m8_editorial_ranking: m8EditorialRanking }, calculated_at: now().toISOString() };
      if (existing && typeof existing.id === "string") {
        await request(`/rest/v1/content_candidates?id=eq.${encodeURIComponent(existing.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify(projection) }, undefined, requestId);
        return;
      }
      await request("/rest/v1/content_candidates", { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({
        story_cluster_id: ranking.storyClusterId,
        scoring_config_id: config.id,
        score_version: null,
        korea_coverage_status: "UNCERTAIN",
        global_spread_score: null,
        engagement_outperformance_score: null,
        engagement_velocity_score: null,
        velocity_acceleration_score: null,
        korea_gap_score: null,
        first_mover_score: null,
        korean_saturation_score: null,
        reliability_score: null,
        source_diversity_score: null,
        freshness_score: null,
        ...projection,
        first_mover_flag: null,
        must_cover_flag: null,
        rank: null,
        ranking_date: ranking.rankingDate,
        recommendation_reason: "M8_EDITORIAL_RANKING",
      }) }, undefined, requestId);
    },
  };
}
