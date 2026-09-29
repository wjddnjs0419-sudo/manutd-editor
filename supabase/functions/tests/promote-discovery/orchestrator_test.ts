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
    async assignObservation(observationId, storyClusterId) {
      calls.push(`assign:${observationId}:${storyClusterId}`);
      const item = observations.find((value) => value.id === observationId);
      if (item) item.storyClusterId = storyClusterId;
    },
    async ensureSourceObservation(value) { calls.push(`source:${value.id}`); return `source-${value.id}`; },
    async ensureDiscoveryClaim(value) { claims.push(value); },
    async ensureEditorialCandidate(value) { calls.push(`candidate:${value.storyClusterId}`); },
  };
}

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
  assertEquals(result, { status: "COMPLETED", observationsProcessed: 1, storiesCreated: 0, storiesUpdated: 1, claimsCreated: 1, editorialCandidatesEnsured: 1 });
  assertEquals(repo.calls.filter((item) => item.startsWith("upsertStory")).length, 1);
  assertEquals(repo.calls.some((item) => item === "assign:observation-1:story-existing"), true);
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
  assertEquals(repo.calls.filter((item) => item.startsWith("candidate:")).length, 1);
});

Deno.test("promotion never creates a verified claim from discovery evidence", async () => {
  const repo = repository([observation({ sourceRole: "DISCOVERY_COMPETITOR" })]);
  await promoteDiscovery({ asOf: "2026-09-29T00:10:00.000Z", repository: repo });
  assertEquals((repo.claims[0] as { status: string }).status, "DISCOVERY_ONLY");
});
