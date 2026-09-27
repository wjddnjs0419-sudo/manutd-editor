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
  }]);
});
