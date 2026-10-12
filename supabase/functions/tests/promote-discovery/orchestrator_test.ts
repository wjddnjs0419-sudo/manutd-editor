import { assertEquals } from "jsr:@std/assert@1.0.8";
import { promoteDiscovery } from "../../promote-discovery/orchestrator.ts";
import type {
  DiscoveryPromotionRepository,
  PromotionObservation,
  PromotionStory,
} from "../../promote-discovery/types.ts";

const observation = (overrides: Partial<PromotionObservation> = {}): PromotionObservation => ({
  id: "observation-1",
  providerId: "google-news",
  sourceCanonicalName: "Google News",
  sourceRole: "DISCOVERY_COMMUNITY",
  externalId: "https://news.example/1",
  canonicalUrl: "https://news.example/1",
  title: "Bruno Fernandes injury concern before Manchester United match",
  excerpt: "Manchester United are monitoring Bruno Fernandes.",
  publishedAt: "2026-09-29T00:00:00.000Z",
  observedAt: "2026-09-29T00:05:00.000Z",
  firstObservedAt: "2026-09-29T00:05:00.000Z",
  lastObservedAt: "2026-09-29T00:05:00.000Z",
  platform: "RSS",
  engagement: {},
  engagementAvailable: false,
  discoveryQueryId: "query-1",
  contentFingerprint: "fingerprint-1",
  metadata: { entities: ["Bruno Fernandes"], topic_family: "INJURY" },
  publisherCanonicalUrl: "https://www.bbc.com/sport/football/bruno-update",
  googleNewsOriginalUrl: "https://news.google.com/rss/articles/google-article-1",
  articleFetchStatus: "FETCHED",
  articleExtractionStatus: "EXTRACTED",
  storyClusterId: null,
  ...overrides,
});

function repository(
  observations: PromotionObservation[],
  stories: PromotionStory[] = [],
): DiscoveryPromotionRepository & { calls: string[]; claims: unknown[] } {
  const calls: string[] = [];
  const claims: unknown[] = [];
  return {
    calls,
    claims,
    async listFreshUnassigned() { return observations.filter((item) => item.storyClusterId === null); },
    async listStories() { return stories; },
    async upsertStory(input) {
      calls.push("upsertStory");
      const existing = stories.find((item) => item.promotionKey === input.promotionKey);
      if (existing) return { id: existing.id, created: false };
      const story = { ...input, id: `story-${stories.length + 1}` };
      stories.push(story);
      return { id: story.id, created: true };
    },
    async assignObservation(observationId, storyClusterId, sourceObservationId) {
      calls.push(`assign:${observationId}:${storyClusterId}:${sourceObservationId}`);
      const item = observations.find((value) => value.id === observationId);
      if (item) item.storyClusterId = storyClusterId;
    },
    async ensureSourceObservation(value) { calls.push(`source:${value.id}`); return `source-${value.id}`; },
    async ensureReviewedPublisherObservation(value) { calls.push(`publisher:${value.id}`); return value.articleExtractionStatus === "EXTRACTED" ? `publisher-source-${value.id}` : null; },
    async ensurePublisherReportClaims(value) { calls.push(`report-claims:${value.storyClusterId}:${value.publisherSourceObservationId}`); },
    async ensureDiscoveryClaim(value) { claims.push(value); },
  };
}

Deno.test("promotion does not create unranked zero score candidate", async () => {
  const repo = repository([observation()]);

  const result = await promoteDiscovery({ asOf: "2026-09-29T17:40:00.000Z", repository: repo });

  assertEquals(result.editorialCandidatesEnsured, 0);
  assertEquals(repo.calls.some((call) => call.startsWith("candidate:")), false);
});

Deno.test("promotion attaches fresh observations to an existing safe story", async () => {
  const existing: PromotionStory = {
    id: "story-existing",
    canonicalTitle: "Bruno Fernandes injury concern before Manchester United match",
    summary: null,
    topic: "INJURY",
    firstSeenAt: "2026-09-29T00:00:00.000Z",
    lastSeenAt: "2026-09-29T00:00:00.000Z",
    promotionKey: "promotion:injury:bruno-fernandes",
    signature: { content_fingerprints: ["older-fingerprint"] },
  };
  const repo = repository([observation({ contentFingerprint: "new-fingerprint" })], [existing]);
  const result = await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });
  assertEquals(result as unknown, { status: "COMPLETED", observationsProcessed: 1, storiesCreated: 0, storiesUpdated: 1, claimsCreated: 1, editorialCandidatesEnsured: 0, affectedStoryIds: ["story-existing"] });
  assertEquals(repo.calls.filter((item) => item.startsWith("upsertStory")).length, 1);
  assertEquals(repo.calls.some((item) => item === "assign:observation-1:story-existing:source-observation-1"), true);
  assertEquals(repo.calls.indexOf("source:observation-1") < repo.calls.indexOf("publisher:observation-1"), true);
  assertEquals(repo.calls.indexOf("publisher:observation-1") < repo.calls.indexOf("report-claims:story-existing:publisher-source-observation-1"), true);
  assertEquals(repo.calls.indexOf("report-claims:story-existing:publisher-source-observation-1") < repo.calls.indexOf("assign:observation-1:story-existing:source-observation-1"), true);
  assertEquals(repo.claims[0], {
    observationId: "observation-1",
    storyClusterId: "story-existing",
    sourceObservationId: "source-observation-1",
    status: "DISCOVERY_ONLY",
  });
});

Deno.test("promotion creates one canonical story and is idempotent on repeat runs", async () => {
  const items = [observation()];
  const repo = repository(items);
  const first = await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });
  const second = await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });
  assertEquals(first.storiesCreated, 1);
  assertEquals(second.observationsProcessed, 0);
  assertEquals(repo.calls.filter((item) => item.startsWith("candidate:")).length, 0);
});

Deno.test("promotion never creates a verified claim from discovery evidence", async () => {
  const repo = repository([observation({ sourceRole: "DISCOVERY_COMPETITOR" })]);
  await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });
  assertEquals((repo.claims[0] as { status: string }).status, "DISCOVERY_ONLY");
});

Deno.test("Google News articles without Manchester United relevance do not create M8 candidates", async () => {
  const repo = repository([observation({
    title: "Chelsea sign a new midfielder after a medical",
    excerpt: "Chelsea completed a transfer deal with the midfielder.",
    contentFingerprint: "irrelevant-google-fingerprint",
    metadata: { entities: ["Chelsea"], topic_family: "TRANSFER" },
  })]);

  const result = await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });

  assertEquals(result.observationsProcessed, 0);
  assertEquals(repo.calls.some((call) => call.startsWith("candidate:")), false);
  assertEquals(repo.claims.length, 0);
});

Deno.test("promotion summary lists each created and updated story ID once", async () => {
  const existing: PromotionStory = {
    id: "story-existing",
    canonicalTitle: "Bruno Fernandes injury concern before Manchester United match",
    summary: null,
    topic: "INJURY",
    firstSeenAt: "2026-09-29T00:00:00.000Z",
    lastSeenAt: "2026-09-29T00:00:00.000Z",
    promotionKey: "promotion:injury:bruno-fernandes",
    signature: { content_fingerprints: ["older-fingerprint"] },
  };
  const repo = repository([
    observation({ id: "observation-1", contentFingerprint: "injury-fingerprint-1" }),
    observation({ id: "observation-2", contentFingerprint: "injury-fingerprint-2" }),
    observation({
      id: "observation-3",
      title: "Manchester United complete transfer for new winger",
      contentFingerprint: "transfer-fingerprint",
      metadata: { entities: ["New winger"], topic_family: "TRANSFER" },
    }),
  ], [existing]);

  const result = await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });

  assertEquals(result as unknown, {
    status: "COMPLETED",
    observationsProcessed: 3,
    storiesCreated: 1,
    storiesUpdated: 1,
    claimsCreated: 3,
    editorialCandidatesEnsured: 0,
    affectedStoryIds: ["story-existing", "story-2"],
  });
});

Deno.test("promotion summary has no affected story IDs when nothing is promoted", async () => {
  const result = await promoteDiscovery({
    asOf: "2026-09-29T00:10:00.000Z",
    repository: repository([]),
  });

  assertEquals(result as unknown, {
    status: "COMPLETED",
    observationsProcessed: 0,
    storiesCreated: 0,
    storiesUpdated: 0,
    claimsCreated: 0,
    editorialCandidatesEnsured: 0,
    affectedStoryIds: [],
  });
});

Deno.test("trusted fact refresh rechecks only recent existing canonical stories with no new promotion", async () => {
  const current: PromotionStory = {
    id: "11111111-1111-4111-8111-111111111111",
    canonicalTitle: "Bruno Fernandes returns to Manchester United training",
    summary: null,
    topic: "INJURY",
    firstSeenAt: "2026-09-28T06:00:00.000Z",
    lastSeenAt: "2026-09-29T00:00:00.000Z",
    promotionKey: "promotion:injury:bruno-fernandes",
    signature: {},
  };
  const old: PromotionStory = {
    ...current, id: "22222222-2222-4222-8222-222222222222",
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
  };
  const repo = repository([], [old, current]);
  const result = await promoteDiscovery({
    asOf: "2026-09-29T02:00:00.000Z", repository: repo, refreshExistingGrounding: true,
  });
  assertEquals(result.affectedStoryIds, [current.id]);
  assertEquals(result.observationsProcessed, 0);
  assertEquals(repo.claims.length, 0);
  assertEquals(repo.calls.some((call) => call.startsWith("candidate:")), false);
});

Deno.test("refresh has strict per-run scope cap and no writes for existing stories", async () => {
  const stories: PromotionStory[] = Array.from({ length: 55 }, (_, i) => ({
    id: `story-${i}`, canonicalTitle: `Manchester United item ${i}`, summary: null, topic: "NEWS",
    firstSeenAt: "2026-09-29T00:00:00.000Z", lastSeenAt: "2026-09-29T01:00:00.000Z",
    promotionKey: null, signature: {},
  }));
  const repo = repository([], stories);
  const result = await promoteDiscovery({ asOf: "2026-09-29T02:00:00.000Z", limit: 100, repository: repo, refreshExistingGrounding: true });
  assertEquals(result.affectedStoryIds.length, 25);
  assertEquals(repo.calls, []);
});
