import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { runTrendDiscovery } from "../../trend-discovery/orchestrator.ts";
import type { DiscoveryObservation, DiscoveryProvider, DiscoveryQuery, TrendSnapshot } from "../../trend-discovery/types.ts";
import type { TrendDiscoveryRepository } from "../../trend-discovery/repository.ts";

const query: DiscoveryQuery = {
  queryId: "query-1",
  text: "Manchester United latest",
  family: "LATEST",
  mode: "GENERAL",
  window: "CURRENT",
  windowStart: "2026-09-26T12:00:00.000Z",
  windowEnd: "2026-09-27T12:00:00.000Z",
  priority: 100,
};

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    providerId: "provider-a",
    sourceCanonicalName: "BBC Sport",
    sourceRole: "FACT_INDEPENDENT",
    externalId: "item-1",
    canonicalUrl: "https://example.test/item-1",
    title: "Manchester United latest injury update",
    excerpt: "A United player returned to training.",
    publishedAt: "2026-09-27T11:00:00.000Z",
    observedAt: "2026-09-27T12:00:00.000Z",
    platform: "WEB",
    engagement: {},
    engagementAvailable: false,
    discoveryQueryId: query.queryId,
    contentFingerprint: "fingerprint-1",
    metadata: {},
    ...overrides,
  };
}

function repository(): TrendDiscoveryRepository & { snapshots: TrendSnapshot[]; observations: DiscoveryObservation[] } {
  const result = { snapshots: [] as TrendSnapshot[], observations: [] as DiscoveryObservation[] };
  return {
    ...result,
    createRun: async () => "run-1",
    saveQuery: async () => "query-row-1",
    upsertObservation: async (value) => {
      const exists = result.observations.some((item) => item.providerId === value.providerId && item.externalId === value.externalId);
      if (!exists) result.observations.push(value);
      return { inserted: !exists, observationId: `${value.providerId}:${value.externalId}`, storyClusterId: null };
    },
    saveSnapshot: async (value) => { result.snapshots.push(value); return true; },
    completeRun: async () => undefined,
  };
}

function provider(overrides: Partial<DiscoveryProvider> = {}): DiscoveryProvider {
  return {
    providerId: "provider-a",
    sourceRole: "FACT_INDEPENDENT",
    platform: "WEB",
    discover: async (value) => [observation({ discoveryQueryId: value.queryId })],
    ...overrides,
  };
}

function concurrencyProbe() {
  let active = 0;
  let maxActive = 0;
  return {
    get maxActive() {
      return maxActive;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return await work();
      } finally {
        active -= 1;
      }
    },
  };
}

Deno.test("provider failures are isolated and successful observations still produce snapshots", async () => {
  const repo = repository();
  const result = await runTrendDiscovery({
    asOf: new Date("2026-09-27T12:00:00.000Z"),
    mode: "BREAKING",
    maxQueries: 1,
    providers: [provider(), provider({ providerId: "broken", discover: async () => { throw new Error("network secret must not escape"); } })],
    repository: repo,
  });
  assertEquals(result.status, "PARTIAL");
  assertEquals(result.observationCount, 1);
  assertEquals(result.providerStatuses.find((item) => item.providerId === "broken")?.status, "FAILED");
  assertEquals(repo.snapshots.length, 1);
  assertEquals(repo.observations[0]?.discoveryQueryId, "query-row-1");
  assertEquals(repo.snapshots[0]?.sourceCount, 1);
});

Deno.test("repeating a discovery run does not inflate observations or stories", async () => {
  const repo = repository();
  const providers = [provider()];
  const first = await runTrendDiscovery({ asOf: "2026-09-27T12:00:00.000Z", maxQueries: 1, providers, repository: repo });
  const second = await runTrendDiscovery({ asOf: "2026-09-27T12:00:00.000Z", maxQueries: 1, providers, repository: repo });
  assertEquals(first.newObservationCount, 1);
  assertEquals(second.newObservationCount, 0);
  assertEquals(second.newStoryCount, 0);
  assertEquals(repo.observations.length, 1);
});

Deno.test("uncertain observations are retained for later relevance refinement", async () => {
  const repo = repository();
  const result = await runTrendDiscovery({
    asOf: "2026-09-27T12:00:00.000Z",
    maxQueries: 1,
    providers: [provider({ discover: async (value) => [observation({ discoveryQueryId: value.queryId, title: "Liverpool transfer roundup", excerpt: "Liverpool Liverpool and a late United mention." })] })],
    repository: repo,
  });
  assertEquals(result.observationCount, 1);
  assertEquals(result.newStoryCount, 0);
  assertEquals(repo.observations.length, 1);
  assertEquals(repo.snapshots.length, 0);
});

Deno.test("re-evaluates retained candidates after bounded enrichment", async () => {
  const repo = repository();
  const result = await runTrendDiscovery({
    asOf: "2026-09-27T12:00:00.000Z",
    maxQueries: 1,
    providers: [provider({
      discover: async (value) => [observation({
        discoveryQueryId: value.queryId,
        title: "Liverpool transfer roundup",
        excerpt: "Liverpool Liverpool and a late United mention.",
      })],
    })],
    enrichObservation: async (value) => ({
      ...value,
      excerpt: "Manchester United injury update: a first-team player returned to training.",
    }),
    repository: repo,
  });

  assertEquals(result.observationCount, 1);
  assertEquals(result.newStoryCount, 1);
  assertEquals(repo.snapshots.length, 1);
  assertEquals(repo.observations[0]?.excerpt, "Manchester United injury update: a first-team player returned to training.");
});

Deno.test("runs providers concurrently without exceeding the discovery concurrency bound", async () => {
  const repo = repository();
  const probe = concurrencyProbe();
  const providers = Array.from({ length: 8 }, (_, index) => provider({
    providerId: `provider-${index}`,
    discover: async () => probe.run(async () => [observation({
      providerId: `provider-${index}`,
      externalId: `item-${index}`,
      contentFingerprint: `fingerprint-${index}`,
    })]),
  }));

  await runTrendDiscovery({ asOf: "2026-09-27T12:00:00.000Z", maxQueries: 1, providers, repository: repo });

  assert(probe.maxActive > 1, `expected overlapping provider work, saw peak ${probe.maxActive}`);
  assert(probe.maxActive <= 4, `expected provider work to stay bounded at four, saw peak ${probe.maxActive}`);
});

Deno.test("runs queries concurrently without exceeding the discovery concurrency bound", async () => {
  const repo = repository();
  const probe = concurrencyProbe();
  const queries = new Set<string>();
  const providers = [provider({
    discover: async (value) => probe.run(async () => {
      queries.add(value.queryId);
      return [observation({ externalId: value.queryId, contentFingerprint: value.queryId })];
    }),
  })];

  await runTrendDiscovery({ asOf: "2026-09-27T12:00:00.000Z", maxQueries: 8, providers, repository: repo });

  assertEquals(queries.size, 8);
  assert(probe.maxActive > 1, `expected overlapping query work, saw peak ${probe.maxActive}`);
  assert(probe.maxActive <= 4, `expected query work to stay bounded at four, saw peak ${probe.maxActive}`);
});
