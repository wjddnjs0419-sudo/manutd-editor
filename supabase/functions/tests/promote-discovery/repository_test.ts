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

Deno.test("promotion retry re-reads observations already assigned by the same job", async () => {
  const promotionJobId = "99999999-9999-4999-8999-999999999999";
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-key",
    request: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/discovery_observations?")) return new Response(JSON.stringify([{ id: "observation-1", provider_id: "google-news", source_canonical_name: "Google News", editorial_role: "DISCOVERY_COMMUNITY", external_id: "article-1", canonical_url: "https://news.google.com/article-1", title: "Manchester United latest", excerpt: "United latest update.", published_at: "2026-09-29T13:00:00.000Z", first_observed_at: "2026-09-29T13:01:00.000Z", last_observed_at: "2026-09-29T13:01:00.000Z", platform: "RSS", engagement: {}, engagement_available: false, discovery_query_id: "query-1", content_fingerprint: "fingerprint-1", metadata: {}, story_cluster_id: "story-1", promotion_job_id: promotionJobId }]));
      return new Response("[]");
    },
  });
  const asOf = new Date("2026-09-30T13:01:00.000Z");
  const list = repository.listFreshUnassigned as unknown as (asOf: Date, limit: number, promotionJobId: string) => Promise<readonly PromotionObservation[]>;
  const assign = repository.assignObservation as unknown as (observationId: string, storyClusterId: string, promotionJobId: string) => Promise<void>;

  const rows = await list.call(repository, asOf, 10, promotionJobId);
  await assign.call(repository, "observation-1", "story-1", promotionJobId);

  const query = new URL(requests.find((item) => item.url.includes("/discovery_observations?"))!.url).searchParams;
  assertEquals(query.get("or"), `(story_cluster_id.is.null,promotion_job_id.eq.${promotionJobId})`);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.storyClusterId, "story-1");
  const patch = requests.find((item) => item.method === "PATCH");
  assertEquals(patch?.body, { story_cluster_id: "story-1", promotion_job_id: promotionJobId });
});
