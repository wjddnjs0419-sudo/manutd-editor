import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createRestGenerationRepository } from "../../creative-generation/repository.ts";

const candidateId = "11111111-1111-4111-8111-111111111111";
const clusterId = "22222222-2222-4222-8222-222222222222";

Deno.test("generation evidence includes M8 grounded fact sources", async () => {
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-role",
    request: async (input) => {
      const url = String(input);
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
      if (url.includes("story_claims")) return new Response(JSON.stringify([{ id: "claim-1", grounding_status: "VERIFIED" }]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([{ claim_id: "claim-1", source_observation_id: "observation-1", editorial_role: "FACT_INDEPENDENT", relation: "SUPPORTS", is_grounding: true }]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-bbc", canonical_url: "https://bbc.test/article/1", title: "Sancho is still looking for a club", excerpt: "BBC confirms the latest status.", editorial_role: "FACT_INDEPENDENT" }]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-bbc", canonical_name: "BBC Sport", entity_type: "MEDIA_OUTLET", reliability_score: 8 }]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const evidence = await repository.getCandidateEvidence(candidateId);

  assertEquals(evidence?.sources, [{
    source_id: "m8-observation:observation-1",
    canonical_name: "BBC Sport",
    entity_type: "MEDIA_OUTLET",
    reliability_score: 8,
    evidence_text: "BBC Sport: Sancho is still looking for a club — BBC confirms the latest status.",
    first_cited_post_id: null,
    citation_count: 1,
    editorial_role: "FACT_INDEPENDENT",
    canonical_url: "https://bbc.test/article/1",
  }]);
});

Deno.test("generation evidence scopes discovery-source reads to the selected story claims", async () => {
  const requested: URL[] = [];
  const repository = createRestGenerationRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceKey: "service-role",
    request: async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname.endsWith("/content_candidates")) return new Response(JSON.stringify([{ id: candidateId, story_cluster_id: clusterId, score_inputs: {} }]));
      if (url.pathname.endsWith("/story_clusters")) return new Response(JSON.stringify([{ id: clusterId, canonical_title: "United transfer report", status: "OPEN" }]));
      if (url.pathname.endsWith("/story_cluster_posts") || url.pathname.endsWith("/story_cluster_sources")) return new Response(JSON.stringify([]));
      if (url.pathname.endsWith("/story_claims")) return new Response(JSON.stringify([{ id: "claim-1", grounding_status: "DISCOVERY_ONLY", discovery_observation_id: "observation-1" }]));
      if (url.pathname.endsWith("/claim_evidence")) return new Response(JSON.stringify([{ claim_id: "claim-1", source_observation_id: "observation-1", editorial_role: "DISCOVERY_COMMUNITY", relation: "SUPPORTS", is_grounding: false }]));
      if (url.pathname.endsWith("/source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-f365", canonical_url: "https://news.google.com/rss/articles/example", title: "United transfer report", excerpt: null, editorial_role: "DISCOVERY_COMMUNITY" }]));
      if (url.pathname.endsWith("/information_sources")) return new Response(JSON.stringify([{ id: "source-f365", canonical_name: "Football365", entity_type: "MEDIA_OUTLET", reliability_score: 8 }]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const evidence = await repository.getCandidateEvidence(candidateId, "DISCOVERY");
  const claimEvidenceQuery = requested.find((url) => url.pathname.endsWith("/claim_evidence"));
  const observationQuery = requested.find((url) => url.pathname.endsWith("/source_observations"));
  const informationSourceQuery = requested.find((url) => url.pathname.endsWith("/information_sources"));

  assertEquals(evidence?.sources.length, 1);
  assertEquals(evidence?.sources[0]?.canonical_url, "https://news.google.com/rss/articles/example");
  assertEquals(claimEvidenceQuery?.searchParams.get("claim_id"), 'in.("claim-1")');
  assertEquals(observationQuery?.searchParams.get("id"), 'in.("observation-1")');
  assertEquals(informationSourceQuery?.searchParams.get("id"), 'in.("source-f365")');
});
