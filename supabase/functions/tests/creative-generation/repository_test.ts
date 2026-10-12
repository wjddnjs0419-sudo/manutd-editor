import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { createRestGenerationRepository } from "../../creative-generation/repository.ts";

const candidateId = "11111111-1111-4111-8111-111111111111";
const clusterId = "22222222-2222-4222-8222-222222222222";

Deno.test("generation evidence includes M8 grounded fact sources", async () => {
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-role",
    request: async (input) => {
      const url = String(input);
      if (url.includes("/editorial_rankings")) return Response.json([]);
      if (url.includes("content_candidates")) return new Response(JSON.stringify([{
        id: candidateId,
        story_cluster_id: clusterId,
        ranking_date: "2026-09-27",
        rank: 1,
        priority_score: 90,
        data_confidence: 90,
        first_mover_flag: true,
        must_cover_flag: false,
        korea_coverage_status: "KNOWN",
        score_version: "v1",
        score_inputs: {},
      }]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([{
        id: clusterId,
        canonical_title: "산초, 3개월째 FA",
        status: "ACTIVE",
        first_seen_at: "2026-09-27T08:00:00Z",
        last_seen_at: "2026-09-27T09:00:00Z",
      }]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("story_cluster_sources")) return new Response(JSON.stringify([]));
      if (url.includes("story_claims")) return new Response(JSON.stringify([{ id: "claim-1", grounding_status: "VERIFIED", claim_scope: "PUBLISHER_REPORT", claim_modality: "RUMOR" }]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([{ claim_id: "claim-1", source_observation_id: "observation-1", editorial_role: "FACT_INDEPENDENT", relation: "SUPPORTS", is_grounding: true, evidence_text: "BBC Sport reports that Sancho could join a new club." }]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-bbc", canonical_url: "https://bbc.test/article/1", title: "Sancho is still looking for a club", excerpt: "BBC Sport reports that Manchester United are considering a move for Jadon Sancho, but no agreement has been reached. " + "The report says the club is reviewing the options and does not confirm any transfer. ".repeat(5), published_at: "2026-10-11T12:00:00Z", observed_at: "2026-10-11T12:01:00Z", content_fingerprint: "bbc-content-1", metadata: { google_news_original_url: "https://news.google.com/rss/articles/abc", article_extraction_status: "EXTRACTED", article_body_present: true }, editorial_role: "FACT_INDEPENDENT" }]));
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-bbc", canonical_name: "BBC Sport", entity_type: "MEDIA_OUTLET", reliability_score: 8 }]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const evidence = await repository.getCandidateEvidence(candidateId);

  assertEquals(evidence?.sources, [{
    source_id: "m8-claim:claim-1:observation:observation-1",
    canonical_name: "BBC Sport",
    entity_type: "MEDIA_OUTLET",
    reliability_score: 8,
    evidence_text: "BBC Sport reports that Sancho could join a new club.",
    first_cited_post_id: null,
    citation_count: 1,
    claim_id: "claim-1",
    editorial_role: "FACT_INDEPENDENT",
    relation: "SUPPORTS",
    is_grounding: true,
    claim_scope: "PUBLISHER_REPORT",
    claim_modality: "RUMOR",
    canonical_url: "https://bbc.test/article/1",
    google_news_original_url: "https://news.google.com/rss/articles/abc",
    published_at: "2026-10-11T12:00:00Z",
    verified: true,
  }]);
  assertEquals(evidence?.exploration_articles, [{
    source_observation_id: "observation-1",
    publisher_name: "BBC Sport",
    canonical_url: "https://bbc.test/article/1",
    published_at: "2026-10-11T12:00:00Z",
    observed_at: "2026-10-11T12:01:00Z",
    extraction_status: "EXTRACTED",
    article_text: "BBC Sport reports that Manchester United are considering a move for Jadon Sancho, but no agreement has been reached. " + "The report says the club is reviewing the options and does not confirm any transfer. ".repeat(5),
    content_fingerprint: "bbc-content-1",
    modality: "RUMOR",
    verified: false,
  }]);
});

Deno.test("unapproved Google News publisher extraction keeps publisher identity and URL in exploration evidence", async () => {
  const publisherUrl = "https://www.teamtalk.com/manchester-united/example-report";
  const articleText = "TEAMtalk reports that Manchester United are considering a move, but no agreement has been reached. " + "The report distinguishes current interest from a completed transfer. ".repeat(6);
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-role",
    request: async (input) => {
      const url = String(input);
      if (url.includes("/editorial_rankings")) return Response.json([]);
      if (url.includes("content_candidates")) return Response.json([{
        id: candidateId, story_cluster_id: clusterId, ranking_date: "2026-10-12", rank: 1,
        priority_score: 0, data_confidence: 0, korea_coverage_status: "UNCERTAIN", score_inputs: {},
      }]);
      if (url.includes("story_clusters")) return Response.json([{
        id: clusterId, canonical_title: "Manchester United transfer report", status: "OPEN",
        first_seen_at: "2026-10-11T12:00:00Z", last_seen_at: "2026-10-11T12:00:00Z",
      }]);
      if (url.includes("story_cluster_posts") || url.includes("story_cluster_sources")) return Response.json([]);
      if (url.includes("story_claims") || url.includes("claim_evidence")) return Response.json([]);
      if (url.includes("discovery_observations")) return Response.json([{
        id: "discovery-1", provider_id: "google-news", story_cluster_id: clusterId,
        source_observation_id: "google-source-observation", source_canonical_name: "TEAMtalk",
        canonical_url: "https://news.google.com/rss/articles/AbCdEfGhIjKlMnOp",
        article_final_url: publisherUrl, resolved_publisher_url: publisherUrl,
        title: "Manchester United transfer report", published_at: "2026-10-11T12:00:00Z",
        last_observed_at: "2026-10-11T12:01:00Z", content_fingerprint: "feed-fingerprint",
        article_extraction_status: "EXTRACTED", article_content_excerpt: articleText,
        metadata: { publisher_name: "TEAMtalk" },
      }]);
      if (url.includes("source_observations")) return Response.json([{
        id: "google-source-observation", information_source_id: "google-source", editorial_role: "DISCOVERY_COMMUNITY",
        external_id: "google-article-1", canonical_url: "https://news.google.com/rss/articles/AbCdEfGhIjKlMnOp",
        title: "Manchester United transfer report", excerpt: articleText,
        published_at: "2026-10-11T12:00:00Z", observed_at: "2026-10-11T12:01:00Z",
        content_fingerprint: "feed-fingerprint",
        metadata: { article_extraction_status: "EXTRACTED", resolved_publisher_url: publisherUrl },
      }]);
      if (url.includes("information_sources")) return Response.json([{
        id: "google-source", canonical_name: "Google News", entity_type: "MEDIA_OUTLET", reliability_score: 0,
      }]);
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const evidence = await repository.getCandidateEvidence(candidateId);
  assertEquals(evidence?.exploration_articles, [{
    source_observation_id: "google-source-observation", publisher_name: "TEAMtalk", canonical_url: publisherUrl,
    published_at: "2026-10-11T12:00:00Z", observed_at: "2026-10-11T12:01:00Z",
    extraction_status: "EXTRACTED", article_text: articleText, content_fingerprint: "feed-fingerprint",
    modality: "UNKNOWN", verified: false,
  }]);
});

Deno.test("REST story duplicate guard ignores prior Exploration drafts unless a standard brief cites the same URL", async () => {
  const publisherUrl = "https://www.teamtalk.com/manchester-united/revised-report";
  const briefs: Record<string, unknown>[] = [
    {
      id: "old-exploration-brief", candidate_id: candidateId, version: 1, status: "DRAFT",
      generation_metadata: { generation_intent: "EXPLORATION" }, exploration_fingerprint: "old-exploration-fingerprint",
      evidence_snapshot: { story: { id: clusterId }, sources: [{ canonical_url: publisherUrl }] },
    },
    {
      id: "unrelated-standard-brief", candidate_id: candidateId, version: 1, status: "READY",
      generation_metadata: { generation_intent: "STANDARD" }, exploration_fingerprint: null,
      evidence_snapshot: { story: { id: clusterId }, sources: [{ canonical_url: "https://www.teamtalk.com/manchester-united/other-report" }] },
    },
  ];
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-role",
    request: async (input) => {
      const url = String(input);
      if (url.includes("content_candidates")) return Response.json([{ id: candidateId }]);
      if (url.includes("creative_briefs")) return Response.json(briefs);
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  assertEquals(await repository.findExistingBriefForStory!(clusterId, [publisherUrl]), null);
  briefs.push({
    id: "matching-standard-brief", candidate_id: candidateId, version: 2, status: "READY",
    generation_metadata: { generation_intent: "STANDARD" }, exploration_fingerprint: null,
    evidence_snapshot: { story: { id: clusterId }, sources: [{ canonical_url: publisherUrl }] },
  });
  assertEquals((await repository.findExistingBriefForStory!(clusterId, [publisherUrl]))?.id, "matching-standard-brief");
});

Deno.test("priority candidates require current news eligible ranking and freshness", async () => {
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co", serviceKey: "service-role", now: () => new Date("2026-10-12T06:00:00Z"),
    request: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/editorial_rankings")) return Response.json([
        { story_cluster_id: "cluster-1", ranking_date: "2026-10-12", rank: 2, news_eligible: true },
        { story_cluster_id: "cluster-2", ranking_date: "2026-10-12", rank: 1, news_eligible: false },
        { story_cluster_id: "cluster-3", ranking_date: "2026-10-11", rank: 3, news_eligible: true },
        { story_cluster_id: "cluster-4", ranking_date: "2026-10-12", rank: 4, news_eligible: true },
      ]);
      if (url.pathname.endsWith("/content_candidates")) return Response.json([
        { id: "candidate-1", story_cluster_id: "cluster-1", ranking_date: "2026-10-12" }, { id: "candidate-2", story_cluster_id: "cluster-2", ranking_date: "2026-10-12" },
        { id: "candidate-3", story_cluster_id: "cluster-3", ranking_date: "2026-10-12" }, { id: "candidate-4", story_cluster_id: "cluster-4", ranking_date: "2026-10-12" },
      ]);
      if (url.pathname.endsWith("/story_clusters")) return Response.json([
        { id: "cluster-1", last_seen_at: "2026-10-11T22:00:00Z" }, { id: "cluster-2", last_seen_at: "2026-10-11T22:00:00Z" },
        { id: "cluster-3", last_seen_at: "2026-10-11T22:00:00Z" }, { id: "cluster-4", last_seen_at: "2026-10-01T22:00:00Z" },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assertEquals(await repository.listPriorityCandidateIds!("2026-10-12"), ["candidate-1"]);
});

Deno.test("Exploration candidates are ordered by article published_at inside the 72-hour window", async () => {
  let discoveryQuery = "";
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co", serviceKey: "service-role",
    request: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/discovery_observations")) {
        discoveryQuery = url.search;
        return Response.json([
          { story_cluster_id: "latest-story", published_at: "2026-10-12T09:00:00Z" },
          { story_cluster_id: "latest-story", published_at: "2026-10-12T08:30:00Z" },
          { story_cluster_id: "older-story", published_at: "2026-10-10T12:00:00Z" },
        ]);
      }
      if (url.pathname.endsWith("/content_candidates")) return Response.json([
        { id: "candidate-older", story_cluster_id: "older-story" },
        { id: "candidate-latest", story_cluster_id: "latest-story" },
      ]);
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  assertEquals(await repository.listExplorationCandidateIds!(new Date("2026-10-12T10:00:00Z")), ["candidate-latest", "candidate-older"]);
  const query = new URLSearchParams(discoveryQuery);
  assertEquals(query.getAll("published_at").length, 2);
  assert(query.getAll("published_at").some((value) => value.startsWith("gte.2026-10-09T10:00:00")));
  assert(query.getAll("published_at").some((value) => value.startsWith("lte.2026-10-12T10:00:00")));
  assertEquals(query.get("order"), "published_at.desc");
});
