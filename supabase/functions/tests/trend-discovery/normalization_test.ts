import { assertEquals } from "jsr:@std/assert@1.0.8";
import { normalizeDiscoveryObservation } from "../../trend-discovery/normalization.ts";
import type { DiscoveryProvider, DiscoveryQuery } from "../../trend-discovery/types.ts";

const provider: Pick<DiscoveryProvider, "providerId" | "sourceRole" | "platform"> = { providerId: "reddit-provider", sourceRole: "DISCOVERY_COMMUNITY", platform: "REDDIT" };
const query: DiscoveryQuery = { queryId: "query-1", text: "Manchester United Reddit", family: "REDDIT", mode: "COMMUNITY", window: "HOT", windowStart: "2026-09-27T00:00:00.000Z", windowEnd: "2026-09-27T12:00:00.000Z", priority: 80 };

Deno.test("normalizes safe identity, timestamps, engagement availability, and strips secrets", async () => {
  const result = await normalizeDiscoveryObservation({ external_id: "post-1", canonical_url: "https://reddit.test/post-1", title: "  Manchester United discussion  ", excerpt: "A community thread", published_at: "2026-09-27T11:00:00+00:00", engagement: { upvotes: 12, replies: 4 }, metadata: { subreddit: "reddevils", api_token: "must-not-persist" } }, { provider, query, observedAt: "2026-09-27T12:00:00.000Z" });
  assertEquals(result?.externalId, "post-1");
  assertEquals(result?.publishedAt, "2026-09-27T11:00:00.000Z");
  assertEquals(result?.engagementAvailable, true);
  assertEquals(result?.metadata, { subreddit: "reddevils" });
});

Deno.test("rejects non-HTTPS or incomplete provider items", async () => {
  assertEquals(await normalizeDiscoveryObservation({ externalId: "item", canonicalUrl: "http://example.test", title: "Manchester United" }, { provider, query, observedAt: query.windowEnd }), null);
  assertEquals(await normalizeDiscoveryObservation({ canonicalUrl: "https://example.test", title: "Manchester United" }, { provider, query, observedAt: query.windowEnd }), null);
});
