import { assertEquals, assert } from "jsr:@std/assert@1.0.8";
import { clusterObservations } from "../../trend-discovery/clustering.ts";
import type { DiscoveryObservation } from "../../trend-discovery/types.ts";

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    providerId: "provider-a",
    sourceCanonicalName: "BBC Sport",
    sourceRole: "FACT_INDEPENDENT",
    externalId: "item-1",
    canonicalUrl: "https://example.test/item-1",
    title: "Manchester United injury update for Luke Shaw",
    excerpt: "Luke Shaw returned to training.",
    publishedAt: "2026-09-27T11:00:00.000Z",
    observedAt: "2026-09-27T12:00:00.000Z",
    platform: "WEB",
    engagement: {},
    engagementAvailable: false,
    discoveryQueryId: "query-1",
    contentFingerprint: "fingerprint-1",
    metadata: {},
    ...overrides,
  };
}

Deno.test("clusters duplicate fingerprints and similar titles into one editorial unit", () => {
  const clusters = clusterObservations([
    observation(),
    observation({ providerId: "reddit", sourceCanonicalName: "r/reddevils", sourceRole: "DISCOVERY_COMMUNITY", externalId: "item-2", canonicalUrl: "https://reddit.test/item-2", title: "Luke Shaw Manchester United injury update", contentFingerprint: "fingerprint-2", platform: "REDDIT" }),
    observation({ providerId: "other", externalId: "item-3", canonicalUrl: "https://example.test/item-3", title: "Arsenal transfer news", contentFingerprint: "fingerprint-3" }),
  ]);
  assertEquals(clusters.length, 2);
  assertEquals(clusters[0]?.observations.length, 2);
  assertEquals(new Set(clusters[0]?.observations.map((item) => item.sourceCanonicalName)).size, 2);
  assert(clusters[0]?.clusterKey.startsWith("trend:"));
});
