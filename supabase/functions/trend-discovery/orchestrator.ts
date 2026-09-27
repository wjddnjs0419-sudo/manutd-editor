import { clusterObservations } from "./clustering.ts";
import { expandDiscoveryQueries } from "./query_expansion.ts";
import { calculateManutdRelevanceScore, isTrendRelevant } from "./relevance.ts";
import { calculateTrendScore, deriveOpportunityLabels, deriveTrendState, trendSignalsFromObservations } from "./scoring.ts";
import type { TrendDiscoveryRepository } from "./repository.ts";
import type { DiscoveryEntityContext, DiscoveryMode, DiscoveryObservation, DiscoveryProvider, DiscoveryRunSummary, ProviderRunStatus, TrendSnapshot } from "./types.ts";

export interface RunTrendDiscoveryOptions {
  readonly asOf?: Date | string;
  readonly mode?: DiscoveryMode;
  readonly entityContext?: DiscoveryEntityContext;
  readonly maxQueries?: number;
  readonly providers: readonly DiscoveryProvider[];
  readonly repository: TrendDiscoveryRepository;
  readonly now?: () => Date;
}

function safeNow(now: () => Date): Date {
  const result = now();
  if (!Number.isFinite(result.getTime())) throw new Error("INVALID_DISCOVERY_NOW");
  return result;
}

function groundingStatus(observations: readonly DiscoveryObservation[]): string {
  return observations.some((item) => item.sourceRole === "FACT_PRIMARY" || item.sourceRole === "FACT_INDEPENDENT") ? "VERIFIED" : "DISCOVERY_ONLY";
}

export async function runTrendDiscovery(options: RunTrendDiscoveryOptions): Promise<DiscoveryRunSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = safeNow(now);
  const asOf = options.asOf ?? startedAt;
  const mode = options.mode ?? "GENERAL";
  const runId = await options.repository.createRun({ mode, startedAt: startedAt.toISOString() });
  const queries = expandDiscoveryQueries({ asOf, mode, entityContext: options.entityContext, maxQueries: options.maxQueries });
  if (queries.length === 0 || options.providers.length === 0) {
    const summary: DiscoveryRunSummary = { runId, status: "NOOP", mode, queryCount: queries.length, observationCount: 0, newObservationCount: 0, newStoryCount: 0, updatedStoryCount: 0, providerStatuses: [], durationMs: Math.max(0, safeNow(now).getTime() - startedAt.getTime()) };
    await options.repository.completeRun(runId, summary);
    return summary;
  }
  const queryRowIds = new Map<string, string>();
  for (const query of queries) queryRowIds.set(query.queryId, await options.repository.saveQuery(runId, query));
  const providerStatuses: ProviderRunStatus[] = [];
  const observations = new Map<string, DiscoveryObservation>();
  const failures = new Set<string>();
  for (const provider of options.providers) {
    let providerObservationCount = 0;
    for (const query of queries) {
      try {
        const values = await provider.discover(query);
        for (const value of values) {
          const observation = { ...value, discoveryQueryId: query.queryId };
          if (!isTrendRelevant({ title: observation.title, excerpt: observation.excerpt })) continue;
          const key = `${observation.providerId}\u0000${observation.externalId}`;
          if (!observations.has(key)) {
            observations.set(key, observation);
            providerObservationCount += 1;
          }
        }
      } catch {
        failures.add(provider.providerId);
      }
    }
    providerStatuses.push({ providerId: provider.providerId, status: failures.has(provider.providerId) ? "FAILED" : "COMPLETED", observations: providerObservationCount, ...(failures.has(provider.providerId) ? { errorCategory: "PROVIDER_UNAVAILABLE" } : {}) });
  }
  const accepted = [...observations.values()];
  const persistence = await Promise.all(accepted.map((observation) => options.repository.upsertObservation(observation, runId)));
  const clusters = clusterObservations(accepted);
  const snapshots: TrendSnapshot[] = [];
  for (const cluster of clusters) {
    const clusterObservations = cluster.observations;
    const scores = calculateTrendScore(trendSignalsFromObservations(clusterObservations, asOf, {
      normalizedEngagementScore: clusterObservations.some((item) => item.engagementAvailable) ? 50 : null,
      engagementAvailable: clusterObservations.some((item) => item.engagementAvailable),
      novelty: { competitorAccountCount: new Set(clusterObservations.filter((item) => item.sourceRole === "DISCOVERY_COMPETITOR").map((item) => item.sourceCanonicalName)).size, similarPostCount: Math.max(0, clusterObservations.length - 1), alreadyPublished: false },
      manutdRelevanceScore: Math.round(clusterObservations.reduce((sum, item) => sum + calculateManutdRelevanceScore({ title: item.title, excerpt: item.excerpt }), 0) / Math.max(1, clusterObservations.length)),
      groundingStatus: groundingStatus(clusterObservations),
      editorialScore: null,
    }));
    const state = deriveTrendState({ trendScore: scores.trendScore, velocityScore: scores.components.velocity, crossSourceScore: scores.components.crossSource, freshnessScore: scores.components.freshness, noveltyScore: scores.components.novelty, acceleration: scores.acceleration });
    const relevance = scores.components.manutdRelevance;
    const snapshot: TrendSnapshot = {
      storyClusterId: persistence.find((item) => item.storyClusterId)?.storyClusterId ?? null,
      clusterKey: cluster.clusterKey,
      snapshotAt: startedAt.toISOString(),
      trendScore: scores.trendScore,
      velocityScore: scores.components.velocity,
      crossSourceScore: scores.components.crossSource,
      engagementScore: scores.components.engagement,
      freshnessScore: scores.components.freshness,
      noveltyScore: scores.components.novelty,
      manutdRelevanceScore: relevance,
      state,
      opportunityLabels: deriveOpportunityLabels({ ...scores.components, trendScore: scores.trendScore, state, groundingStatus: groundingStatus(clusterObservations), competitorAccountCount: new Set(clusterObservations.filter((item) => item.sourceRole === "DISCOVERY_COMPETITOR").map((item) => item.sourceCanonicalName)).size }),
      mentionCount: clusterObservations.length,
      sourceCount: cluster.sourceCategories.length,
      platformCount: cluster.platforms.length,
      engagementAvailable: scores.engagementAvailable,
      inputSnapshot: { config_version: "m8.5-v1", query_ids: clusterObservations.map((item) => item.discoveryQueryId), source_roles: cluster.sourceCategories, platform_names: cluster.platforms },
    };
    snapshots.push(snapshot);
    await options.repository.saveSnapshot(snapshot);
  }
  const newObservationCount = persistence.filter((item) => item.inserted).length;
  const summary: DiscoveryRunSummary = {
    runId,
    status: failures.size > 0 ? "PARTIAL" : "COMPLETED",
    mode,
    queryCount: queries.length,
    observationCount: accepted.length,
    newObservationCount,
    newStoryCount: newObservationCount > 0 ? clusters.length : 0,
    updatedStoryCount: newObservationCount > 0 ? Math.max(0, clusters.length - newObservationCount) : 0,
    providerStatuses,
    durationMs: Math.max(0, safeNow(now).getTime() - startedAt.getTime()),
  };
  await options.repository.completeRun(runId, summary);
  void queryRowIds;
  void snapshots;
  return summary;
}
