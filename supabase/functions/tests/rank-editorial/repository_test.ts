import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createEditorialRankingRepository } from "../../rank-editorial/repository.ts";

const relevantCluster = "11111111-1111-4111-8111-111111111111";
const unrelatedCluster = "22222222-2222-4222-8222-222222222222";

Deno.test("ranking repository filters unrelated football clusters before scoring", async () => {
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    now: () => new Date("2026-09-27T12:00:00Z"),
    request: async (input) => {
      const url = String(input);
      if (url.includes("story_claims")) return new Response(JSON.stringify([
        { story_cluster_id: relevantCluster, grounding_status: "VERIFIED", grounding_confidence: 0.9 },
        { story_cluster_id: unrelatedCluster, grounding_status: "VERIFIED", grounding_confidence: 0.9 },
      ]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([
        { claim_id: "0", editorial_role: "FACT_PRIMARY", source_observation_id: "observation-1" },
        { claim_id: "1", editorial_role: "FACT_PRIMARY", source_observation_id: "observation-2" },
      ]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([
        { id: "observation-1", discovery_signal: 0.8, observed_at: "2026-09-27T11:00:00Z" },
        { id: "observation-2", discovery_signal: 0.8, observed_at: "2026-09-27T11:00:00Z" },
      ]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([
        { id: relevantCluster, last_seen_at: "2026-09-27T11:00:00Z", canonical_title: "산초, 3개월째 FA", summary: "맨유와 계약이 끝난 뒤 새 팀을 찾고 있다.", signature_json: { entities: ["jadon_sancho"] } },
        { id: unrelatedCluster, last_seen_at: "2026-09-27T11:00:00Z", canonical_title: "손흥민 대표팀 부상 소식", summary: null, signature_json: { entities: ["son_heung_min"] } },
      ]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([
        { story_cluster_id: relevantCluster, raw_posts: { source_accounts: { username: "todayfootball" } } },
        { story_cluster_id: unrelatedCluster, raw_posts: { source_accounts: { username: "todayfootball" } } },
      ]));
      if (url.includes("matches")) return new Response(JSON.stringify([]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const inputs = await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");
  assertEquals(inputs.map((input) => input.storyClusterId), [relevantCluster]);
});
