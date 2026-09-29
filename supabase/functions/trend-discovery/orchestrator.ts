import { clusterObservations } from "./clustering.ts";
import { expandDiscoveryQueries } from "./query_expansion.ts";
import { calculateManutdRelevanceScore } from "./relevance.ts";
import { calculateTrendScore, deriveOpportunityLabels, deriveTrendState, normalizedEngagementScore, trendSignalsFromObservations } from "./scoring.ts";
import type { TrendDiscoveryRepository } from "./repository.ts";
import type { DiscoveryEntityContext, DiscoveryMode, DiscoveryObservation, DiscoveryProvider, DiscoveryRunSummary, DiscoverySearchProfile, ProviderRunStatus, TrendSnapshot } from "./types.ts";

const DISCOVERY_CONCURRENCY = 4;

export interface RunTrendDiscoveryOptions {
  readonly asOf?: Date | string;
  readonly mode?: DiscoveryMode;
  readonly searchProfile?: DiscoverySearchProfile;
  readonly entityContext?: DiscoveryEntityContext;
  readonly resolveEntityContext?: (asOf: Date | string) => Promise<DiscoveryEntityContext>;
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

function mentionWindows(observations: readonly DiscoveryObservation[], asOf: Date | string): { mentionsLast1h: number; mentionsLast3h: number; mentionsPrevious3h: number; mentionsLast12h: number } {
  const reference = asOf instanceof Date ? asOf.getTime() : new Date(asOf).getTime();
  let mentionsLast1h = 0;
  let mentionsLast3h = 0;
  let mentionsPrevious3h = 0;
  let mentionsLast12h = 0;
  for (const observation of observations) {
    if (!observation.publishedAt) continue;
    const ageHours = Math.max(0, reference - new Date(observation.publishedAt).getTime()) / 3_600_000;
    if (ageHours <= 1) mentionsLast1h += 1;
    if (ageHours <= 3) mentionsLast3h += 1;
    else if (ageHours <= 6) mentionsPrevious3h += 1;
    if (ageHours <= 12) mentionsLast12h += 1;
  }
  return { mentionsLast1h, mentionsLast3h, mentionsPrevious3h, mentionsLast12h };
}

export async function runTrendDiscovery(options: RunTrendDiscoveryOptions): Promise<DiscoveryRunSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = safeNow(now);
  const asOf = options.asOf ?? startedAt;
  const mode = options.mode ?? "GENERAL";
  const searchProfile = options.searchProfile ?? "MANUAL";
  const entityContext = options.entityContext ?? (options.resolveEntityContext ? await options.resolveEntityContext(asOf) : undefined);
  const runId = await options.repository.createRun({ mode, startedAt: startedAt.toISOString(), searchProfile });
  const queries = expandDiscoveryQueries({ asOf, mode, searchProfile, entityContext, maxQueries: options.maxQueries });
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
  const tasks = options.providers.flatMap((provider) => queries.map((query) => ({ provider, query })));
  const results: Array<readonly DiscoveryObservation[] | null> = Array.from({ length: tasks.length }, () => null);
  const failedTasks = new Set<number>();
  let nextTask = 0;
  async function worker(): Promise<void> {
    while (true) {
      const taskIndex = nextTask++;
      const task = tasks[taskIndex];
      if (!task) return;
      try {
        results[taskIndex] = await task.provider.discover(task.query);
      } catch {
        failedTasks.add(taskIndex);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, tasks.length) }, () => worker()));
  const providerObservationCounts = new Map(options.providers.map((provider) => [provider.providerId, 0]));
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    const task = tasks[taskIndex]!;
    if (failedTasks.has(taskIndex)) {
      failures.add(task.provider.providerId);
      continue;
    }
    for (const value of results[taskIndex] ?? []) {
      const observation = { ...value, discoveryQueryId: queryRowIds.get(task.query.queryId) ?? task.query.queryId };
      const key = `${observation.providerId}\u0000${observation.externalId}`;
      if (!observations.has(key)) {
        observations.set(key, observation);
        providerObservationCounts.set(task.provider.providerId, (providerObservationCounts.get(task.provider.providerId) ?? 0) + 1);
      }
    }
  }
  for (const provider of options.providers) {
    const failed = failures.has(provider.providerId);
    providerStatuses.push({ providerId: provider.providerId, status: failed ? "FAILED" : "COMPLETED", observations: providerObservationCounts.get(provider.providerId) ?? 0, ...(failed ? { errorCategory: "PROVIDER_UNAVAILABLE" } : {}) });
  }
  const accepted = [...observations.values()];
  const persistence = await Promise.all(accepted.map((observation) => options.repository.upsertObservation(observation, runId)));
  const storyClusterByObservation = new Map(accepted.map((observation, index) => [
    `${observation.providerId}\u0000${observation.externalId}`,
    persistence[index]?.storyClusterId ?? null,
  ]));
  const trendObservations = accepted.filter((observation) =>
    calculateManutdRelevanceScore({ title: observation.title, excerpt: observation.excerpt }) > 0
  );
  const clusters = clusterObservations(trendObservations);
  const snapshots: TrendSnapshot[] = [];
  for (const cluster of clusters) {
    const clusterObservations = cluster.observations;
    const engagementScore = normalizedEngagementScore(clusterObservations);
    const scores = calculateTrendScore(trendSignalsFromObservations(clusterObservations, asOf, {
      normalizedEngagementScore: engagementScore,
      engagementAvailable: engagementScore !== null,
      novelty: { competitorAccountCount: new Set(clusterObservations.filter((item) => item.sourceRole === "DISCOVERY_COMPETITOR").map((item) => item.sourceCanonicalName)).size, similarPostCount: Math.max(0, clusterObservations.length - 1), alreadyPublished: false },
      manutdRelevanceScore: Math.round(clusterObservations.reduce((sum, item) => sum + calculateManutdRelevanceScore({ title: item.title, excerpt: item.excerpt }), 0) / Math.max(1, clusterObservations.length)),
      groundingStatus: groundingStatus(clusterObservations),
      editorialScore: null,
      mentionWindows: mentionWindows(clusterObservations, asOf),
    }));
    const state = deriveTrendState({ trendScore: scores.trendScore, velocityScore: scores.components.velocity, crossSourceScore: scores.components.crossSource, freshnessScore: scores.components.freshness, noveltyScore: scores.components.novelty, acceleration: scores.acceleration });
    const relevance = scores.components.manutdRelevance;
    const storyClusterId = clusterObservations
      .map((observation) => storyClusterByObservation.get(`${observation.providerId}\u0000${observation.externalId}`) ?? null)
      .find((value): value is string => value !== null) ?? null;
    const snapshot: TrendSnapshot = {
      storyClusterId,
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
      sourceCount: cluster.sourceNames.length,
      platformCount: cluster.platforms.length,
      engagementAvailable: scores.engagementAvailable,
      inputSnapshot: { config_version: "m8.5-v1", query_ids: clusterObservations.map((item) => item.discoveryQueryId), source_roles: cluster.sourceCategories, source_names: cluster.sourceNames, platform_names: cluster.platforms, content_fingerprints: clusterObservations.map((item) => item.contentFingerprint) },
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
