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
  publisherCanonicalUrl: "https://news.example/article-1",
  googleNewsOriginalUrl: "https://news.google.com/rss/articles/article-1",
  articleFetchStatus: "NOT_ATTEMPTED",
  articleExtractionStatus: "NOT_ATTEMPTED",
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
  const assign = repository.assignObservation as unknown as (observationId: string, storyClusterId: string, sourceObservationId: string, promotionJobId: string) => Promise<void>;

  const rows = await list.call(repository, asOf, 10, promotionJobId);
  await assign.call(repository, "observation-1", "story-1", "source-observation-1", promotionJobId);

  const query = new URL(requests.find((item) => item.url.includes("/discovery_observations?"))!.url).searchParams;
  assertEquals(decodeURIComponent(query.get("and") ?? "").includes(`or(story_cluster_id.is.null,promotion_job_id.eq.${promotionJobId})`), true);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.storyClusterId, "story-1");
  const patch = requests.find((item) => item.method === "PATCH");
  assertEquals(patch?.body, { story_cluster_id: "story-1", source_observation_id: "source-observation-1", promotion_job_id: promotionJobId });
  const patchQuery = new URL(patch!.url).searchParams;
  assertEquals(patchQuery.get("source_observation_id"), "is.null");
  assertEquals(decodeURIComponent(patchQuery.get("or") ?? ""), "(story_cluster_id.is.null,story_cluster_id.eq.story-1)");
});

Deno.test("exact BBC source linking reads only the tagged observation using legacy columns", async () => {
  const promotionJobId = "99999999-9999-4999-8999-999999999999";
  const observationId = "11111111-1111-4111-8111-111111111111";
  let requestUrl = "";
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-key",
    request: async (input) => {
      requestUrl = String(input);
      return Response.json([{ id: observationId, provider_id: "feed-1-bbc-sport", source_canonical_name: "BBC Sport", editorial_role: "FACT_INDEPENDENT", external_id: "bbc-article-1", canonical_url: "https://www.bbc.co.uk/sport/football/articles/c62e9g09e781o", title: "Boos, anguish & fading belief - 'worrying day' for under-pressure Carrick", excerpt: "Manchester United article body", published_at: "2026-10-10T20:54:46.000Z", first_observed_at: "2026-10-10T20:54:46.000Z", last_observed_at: "2026-10-10T20:54:52.000Z", platform: "RSS", engagement: {}, engagement_available: false, discovery_query_id: "query-1", content_fingerprint: "bbc-fingerprint", metadata: { article_enrichment: "EXTRACTED" }, story_cluster_id: "story-1", promotion_job_id: promotionJobId }]);
    },
  });
  const list = repository.listFreshUnassigned as unknown as (asOf: Date, limit: number, promotionJobId: string, observationId: string) => Promise<readonly PromotionObservation[]>;
  const rows = await list.call(repository, new Date("2026-10-12T09:00:00Z"), 1, promotionJobId, observationId);
  const query = new URL(requestUrl).searchParams;
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.id, observationId);
  assertEquals(query.get("id"), `eq.${observationId}`);
  assertEquals(query.get("promotion_job_id"), `eq.${promotionJobId}`);
  assertEquals(query.get("provider_id"), "neq.google-news");
  assertEquals(query.get("select")?.includes("article_final_url"), false);
  assertEquals(query.get("select")?.includes("excerpt"), true);
});

Deno.test("Google publisher provenance reaches M8 source observations without replacing discovery identity", async () => {
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/discovery_observations?")) return new Response(JSON.stringify([{
        id: "observation-google-1",
        provider_id: "google-news",
        source_canonical_name: "BBC Sport",
        editorial_role: "DISCOVERY_COMMUNITY",
        external_id: "google-article-1",
        canonical_url: "https://news.google.com/rss/articles/google-article-1",
        google_news_original_url: "https://news.google.com/rss/articles/google-article-1",
        google_news_article_id: "google-article-1",
        resolved_publisher_url: "https://www.bbc.com/sport/football/united-story",
        url_resolution_status: "RESOLVED",
        article_extraction_status: "EXTRACTED",
        excerpt: "Google News RSS summary that must not become article body.",
        article_content_excerpt: "BBC article body excerpt about Manchester United.",
        title: "Manchester United confirm a squad update",
        published_at: "2026-09-29T13:00:00.000Z",
        first_observed_at: "2026-09-29T13:01:00.000Z",
        last_observed_at: "2026-09-29T13:01:00.000Z",
        platform: "RSS",
        engagement: {},
        engagement_available: false,
        discovery_query_id: "query-1",
        content_fingerprint: "fingerprint-google-1",
        metadata: { google_news_original_url: "https://news.google.com/rss/articles/google-article-1" },
        story_cluster_id: null,
      }]));
      if (url.includes("/information_sources?")) {
        const query = new URL(url).searchParams;
        if (query.get("canonical_name") === "eq.Google News") return Response.json([{ id: "google-news-source" }]);
        if (query.has("active")) return Response.json([{ id: "bbc-source", canonical_name: "BBC Sport", website_url: "https://www.bbc.com/sport", editorial_role: "FACT_INDEPENDENT", reliability_score: 8, active: true }]);
        return Response.json([{ id: "bbc-source" }]);
      }
      if (url.includes("/source_observations?")) return new Response(JSON.stringify([{ id: "bbc-observation" }]));
      return new Response("[]");
    },
  });
  const list = repository.listFreshUnassigned as unknown as (asOf: Date, limit: number) => Promise<readonly PromotionObservation[]>;

  const [item] = await list.call(repository, new Date("2026-09-30T00:00:00.000Z"), 10);
  assert(item);
  assertEquals(item.canonicalUrl, "https://news.google.com/rss/articles/google-article-1");
  assertEquals(item.publisherCanonicalUrl, "https://www.bbc.com/sport/football/united-story");
  assertEquals(item.excerpt, "BBC article body excerpt about Manchester United.");

  await repository.ensureSourceObservation(item);
  await repository.ensureReviewedPublisherObservation(item);
  const sourceWrites = requests.filter((entry) => entry.url.includes("/source_observations?") && entry.method === "POST");
  const discoveryWrite = sourceWrites.find((entry) => entry.body?.information_source_id === "google-news-source");
  const publisherWrite = sourceWrites.find((entry) => entry.body?.information_source_id === "bbc-source");
  assertEquals(discoveryWrite?.body?.editorial_role, "DISCOVERY_COMMUNITY");
  assertEquals(discoveryWrite?.body?.canonical_url, "https://news.google.com/rss/articles/google-article-1");
  assertEquals((discoveryWrite?.body?.metadata as Record<string, unknown>).google_news_original_url, "https://news.google.com/rss/articles/google-article-1");
  assertEquals(publisherWrite?.body?.canonical_url, "https://www.bbc.com/sport/football/united-story");
  assertEquals(publisherWrite?.body?.excerpt, "BBC article body excerpt about Manchester United.");
  assertEquals((publisherWrite?.body?.metadata as Record<string, unknown>).google_news_original_url, "https://news.google.com/rss/articles/google-article-1");
  const discoveryQuery = new URL(requests.find((entry) => entry.url.includes("/discovery_observations?"))!.url).searchParams;
  assertEquals(decodeURIComponent(discoveryQuery.get("and") ?? "").includes("url_resolution_status.eq.RESOLVED"), true);
});

Deno.test("Google observations without extracted body keep M8 article excerpts empty", async () => {
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input) => {
      if (String(input).includes("/discovery_observations?")) return new Response(JSON.stringify([{
        id: "observation-google-2",
        provider_id: "google-news",
        source_canonical_name: "BBC Sport",
        editorial_role: "DISCOVERY_COMMUNITY",
        external_id: "google-article-2",
        canonical_url: "https://news.google.com/rss/articles/google-article-2",
        google_news_original_url: "https://news.google.com/rss/articles/google-article-2",
        resolved_publisher_url: "https://www.bbc.com/sport/football/second-story",
        url_resolution_status: "RESOLVED",
        article_extraction_status: "TITLE_NOT_RELEVANT",
        excerpt: "RSS summary is preserved in discovery storage.",
        article_content_excerpt: null,
        title: "Manchester United team news",
        first_observed_at: "2026-09-29T13:01:00.000Z",
        last_observed_at: "2026-09-29T13:01:00.000Z",
        platform: "RSS",
        engagement: {},
        engagement_available: false,
        content_fingerprint: "fingerprint-google-2",
        metadata: {},
        story_cluster_id: null,
      }]));
      return new Response("[]");
    },
  });
  const list = repository.listFreshUnassigned as unknown as (asOf: Date, limit: number) => Promise<readonly PromotionObservation[]>;

  const [item] = await list.call(repository, new Date("2026-09-30T00:00:00.000Z"), 10);
  assert(item);
  assertEquals(item.excerpt, null);
  assertEquals(item.publisherCanonicalUrl, "https://www.bbc.com/sport/football/second-story");
});

Deno.test("M8 promotion only queries the fresh window and places the newest observations first", async () => {
  let requestUrl = "";
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input) => {
      requestUrl = String(input);
      return new Response("[]");
    },
  });
  const asOf = new Date("2026-10-12T12:00:00.000Z");
  await repository.listFreshUnassigned(asOf, 25, undefined);
  const query = new URL(requestUrl).searchParams;

  assertEquals(query.get("order"), "last_observed_at.desc,id.asc");
  assertEquals(query.get("and")?.includes("story_cluster_id.is.null"), true);
  assertEquals(query.getAll("last_observed_at"), ["gte.2026-10-09T12:00:00.000Z", "lte.2026-10-12T12:00:00.000Z"]);
});

Deno.test("publisher observation stores reviewed source and article provenance separately", async () => {
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method: init?.method ?? "GET", body });
      if (url.includes("/information_sources?")) return Response.json([{
        id: "bbc-source", canonical_name: "BBC Sport", website_url: "https://www.bbc.com/sport",
        editorial_role: "FACT_INDEPENDENT", reliability_score: 8, active: true,
      }]);
      if (url.includes("/source_observations?")) return Response.json([{ id: "bbc-article-observation" }]);
      return Response.json([]);
    },
  });
  const ensure = (repository as unknown as { ensureReviewedPublisherObservation: (item: PromotionObservation) => Promise<string | null> }).ensureReviewedPublisherObservation;

  const id = await ensure.call(repository, {
    ...observation,
    excerpt: "BBC reports that United are considering a move, but no agreement has been reached.",
    publisherCanonicalUrl: "https://www.bbc.com/sport/football/story?utm_source=google-news",
    articleFetchStatus: "FETCHED",
    articleExtractionStatus: "EXTRACTED",
    publishedAt: "2026-09-29T13:00:00.000Z",
    metadata: { supporting_sentence: "United are considering a move, but no agreement has been reached." },
  });

  assertEquals(id, "bbc-article-observation");
  const write = requests.find((request) => request.url.includes("/source_observations?") && request.method === "POST");
  assert(write);
  assertEquals(write.body?.information_source_id, "bbc-source");
  assertEquals(write.body?.editorial_role, "FACT_INDEPENDENT");
  assertEquals(write.body?.external_id, "https://www.bbc.com/sport/football/story?utm_source=google-news");
  assertEquals(write.body?.canonical_url, "https://www.bbc.com/sport/football/story?utm_source=google-news");
  assertEquals(write.body?.excerpt, "BBC reports that United are considering a move, but no agreement has been reached.");
  assertEquals(write.body?.published_at, "2026-09-29T13:00:00.000Z");
  assertEquals((write.body?.metadata as Record<string, unknown>).google_news_original_url, observation.googleNewsOriginalUrl);
  assertEquals((write.body?.metadata as Record<string, unknown>).publisher_canonical_name, "BBC Sport");
  assertEquals((write.body?.metadata as Record<string, unknown>).supporting_sentence, "United are considering a move, but no agreement has been reached.");
});

Deno.test("publisher observation requires extracted non-empty body", async () => {
  const requests: string[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    request: async (input) => { requests.push(String(input)); return Response.json([]); },
  });
  const ensure = (repository as unknown as { ensureReviewedPublisherObservation: (item: PromotionObservation) => Promise<string | null> }).ensureReviewedPublisherObservation;

  const blocked = await ensure.call(repository, { ...observation, articleExtractionStatus: "PAYWALL", excerpt: null });
  const empty = await ensure.call(repository, { ...observation, articleExtractionStatus: "EXTRACTED", excerpt: "   " });

  assertEquals(blocked, null);
  assertEquals(empty, null);
  assertEquals(requests.length, 0);
});


Deno.test("publisher report claim links exact article sentence and preserves rumor modality", async () => {
  const requests: { url: string; method: string; body: Record<string, unknown> | null }[] = [];
  const repository = createDiscoveryPromotionRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-key",
    request: async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ url, method: init?.method ?? "GET", body });
      return Response.json([]);
    },
  });

  await repository.ensurePublisherReportClaims({
    observation: { ...observation, excerpt: "Manchester United are considering a move for Player A, according to BBC Sport.", articleExtractionStatus: "EXTRACTED", metadata: { publisher_canonical_name: "BBC Sport" } },
    storyClusterId: "story-1", publisherSourceObservationId: "bbc-source-observation-1",
  });

  const claim = requests.find((request) => request.url.includes("/story_claims?") && request.method === "POST");
  assert(claim);
  assertEquals(claim.body?.origin, "publisher_article");
  assertEquals(claim.body?.claim_scope, "PUBLISHER_REPORT");
  assertEquals(claim.body?.claim_modality, "RUMOR");
  assertEquals(claim.body?.publisher_source_observation_id, "bbc-source-observation-1");
  assertEquals(claim.body?.discovery_observation_id, "observation-1");
  assertEquals(claim.body?.object, "Manchester United are considering a move for Player A, according to BBC Sport.");
  assertEquals(claim.body?.claim_text, "BBC Sport reports: Manchester United are considering a move for Player A, according to BBC Sport.");
  assertEquals(claim.body?.grounding_status, "INSUFFICIENT");
});
