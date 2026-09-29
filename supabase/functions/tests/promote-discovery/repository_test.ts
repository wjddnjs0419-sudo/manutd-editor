import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { createDiscoveryPromotionRepository } from "../../promote-discovery/repository.ts";
import type { PromotionObservation } from "../../promote-discovery/types.ts";

const observation: PromotionObservation = {
  id: "observation-1",
  providerId: "google-news",
  sourceCanonicalName: "Google News",
  sourceRole: "DISCOVERY_COMMUNITY",
  externalId: "article-1",
  canonicalUrl: "https://news.google.com/article-1",
  title: "Manchester United latest",
  excerpt: "United latest update.",
  publishedAt: "2026-09-29T13:00:00.000Z",
  observedAt: "2026-09-29T13:01:00.000Z",
  firstObservedAt: "2026-09-29T13:01:00.000Z",
  lastObservedAt: "2026-09-29T13:01:00.000Z",
  platform: "RSS",
  engagement: {},
  engagementAvailable: false,
  discoveryQueryId: "query-1",
  contentFingerprint: "fingerprint-1",
  metadata: {},
  storyClusterId: null,
};

Deno.test("source registry lookup preserves spaces in canonical names", async () => {
  const urls: string[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input, init) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/information_sources?")) return new Response(JSON.stringify([{ id: "source-1" }]));
      if (url.includes("/source_observations?")) return new Response(JSON.stringify([{ id: "source-observation-1" }]));
      return new Response("[]");
    },
  });

  assertEquals(await repository.ensureSourceObservation(observation), "source-observation-1");
  const sourceLookup = urls.find((url) => url.includes("/information_sources?"));
  assert(sourceLookup);
  assertEquals(new URL(sourceLookup).searchParams.get("canonical_name"), "eq.Google News");
});
