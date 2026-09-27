import type { EditorialRankingInput, EditorialRankingRepository } from "./types.ts";

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
  readonly now?: () => Date;
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function bounded(value: number): number { return Math.max(0, Math.min(100, value)); }
function date(value: unknown): Date | null { if (typeof value !== "string") return null; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed : null; }

export function createEditorialRankingRepository(options: RepositoryOptions): EditorialRankingRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("Database configuration is required");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.request ?? fetch;
  const now = options.now ?? (() => new Date());
  async function request(path: string, init: RequestInit, profile?: string): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers: { apikey: options.serviceRoleKey, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}), ...init.headers } });
    if (!response.ok) { await response.body?.cancel(); throw new Error("DATABASE_HTTP_ERROR"); }
    const text = await response.text();
    return text.trim() === "" ? null : JSON.parse(text);
  }
  return {
    async listInputs(asOf, rankingDate) {
      const [claimsValue, evidenceValue, observationsValue, clustersValue, matchesValue] = await Promise.all([
        request("/rest/v1/story_claims?select=story_cluster_id,grounding_status,grounding_confidence&limit=2000", { method: "GET" }, "app_private"),
        request("/rest/v1/claim_evidence?select=claim_id,editorial_role,source_observation_id&limit=5000", { method: "GET" }, "app_private"),
        request("/rest/v1/source_observations?select=id,discovery_signal,observed_at&limit=5000", { method: "GET" }, "app_private"),
        request("/rest/v1/story_clusters?select=id,last_seen_at&limit=1000", { method: "GET" }),
        request("/rest/v1/matches?select=id,status,kickoff_at&status=in.(SCHEDULED,LIVE)&limit=20", { method: "GET" }),
      ]);
      const observationById = new Map<string, { signal: number; observedAt: Date | null }>();
      if (Array.isArray(observationsValue)) for (const item of observationsValue) if (record(item) && typeof item.id === "string") observationById.set(item.id, { signal: bounded(number(item.discovery_signal)), observedAt: date(item.observed_at) });
      const claimById = new Map<string, { clusterId: string; status: string; confidence: number }>();
      const claimRows = Array.isArray(claimsValue) ? claimsValue : [];
      for (const [index, item] of claimRows.entries()) if (record(item) && typeof item.story_cluster_id === "string") claimById.set(String(index), { clusterId: item.story_cluster_id, status: typeof item.grounding_status === "string" ? item.grounding_status : "INSUFFICIENT", confidence: bounded(number(item.grounding_confidence) * 100) });
      const stats = new Map<string, { verified: number; contradicted: number; factScore: number; discoveryCount: number; discoverySignal: number; freshness: Date | null }>();
      const ensure = (clusterId: string) => { const current = stats.get(clusterId) ?? { verified: 0, contradicted: 0, factScore: 0, discoveryCount: 0, discoverySignal: 0, freshness: null }; stats.set(clusterId, current); return current; };
      for (const claim of claimById.values()) { const current = ensure(claim.clusterId); if (claim.status === "VERIFIED") { current.verified += 1; current.factScore = Math.max(current.factScore, claim.confidence || 100); } if (claim.status === "CONTRADICTED") current.contradicted += 1; }
      if (Array.isArray(evidenceValue)) for (const item of evidenceValue) if (record(item) && typeof item.claim_id === "string" && typeof item.editorial_role === "string") { const claim = claimById.get(item.claim_id); const observation = typeof item.source_observation_id === "string" ? observationById.get(item.source_observation_id) : undefined; if (!claim || !observation) continue; const current = ensure(claim.clusterId); if (item.editorial_role.startsWith("DISCOVERY_")) { current.discoveryCount += 1; current.discoverySignal += observation.signal; } }
      if (Array.isArray(clustersValue)) for (const item of clustersValue) if (record(item) && typeof item.id === "string") { const current = ensure(item.id); current.freshness = date(item.last_seen_at); }
      const hasMatchContext = Array.isArray(matchesValue) && matchesValue.length > 0;
      const reference = asOf ?? now();
      const targetDate = rankingDate ?? reference.toISOString().slice(0, 10);
      return [...stats.entries()].map(([storyClusterId, current]): EditorialRankingInput => {
        const freshnessHours = current.freshness ? Math.max(0, (reference.getTime() - current.freshness.getTime()) / 3_600_000) : 72;
        const freshnessScore = bounded(100 - (freshnessHours / 48) * 100);
        const factGroundingScore = bounded(current.factScore);
        const groundingStatus = current.contradicted > 0 ? "CONTRADICTED" : current.verified > 0 ? "VERIFIED" : current.discoveryCount > 0 ? "DISCOVERY_ONLY" : "INSUFFICIENT";
        return { storyClusterId, rankingDate: targetDate, groundingStatus, factGroundingScore, discoveryAudienceSignalScore: bounded(current.discoverySignal), matchContextScore: hasMatchContext ? 100 : 0, freshnessScore, informationGapScore: bounded(current.discoveryCount > 0 ? 100 - factGroundingScore : 0), verifiedClaimCount: current.verified, contradictedClaimCount: current.contradicted, discoveryObservationCount: current.discoveryCount };
      });
    },
    async upsertRanking(ranking) {
      await request("/rest/v1/editorial_rankings?on_conflict=story_cluster_id%2Cranking_date%2Cranking_version", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ story_cluster_id: ranking.storyClusterId, ranking_date: ranking.rankingDate, ranking_version: ranking.rankingVersion, editorial_score: ranking.editorialScore, information_gap_score: ranking.informationGapScore, fact_grounding_score: ranking.factGroundingScore, discovery_audience_signal_score: ranking.discoveryAudienceSignalScore, match_context_score: ranking.matchContextScore, freshness_score: ranking.freshnessScore, rank: ranking.rank, news_eligible: ranking.newsEligible, grounding_status: ranking.groundingStatus, reason_codes: ranking.reasonCodes, input_snapshot: ranking.inputSnapshot }) }, "app_private");
    },
  };
}
