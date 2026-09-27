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
        { id: "claim-relevant", story_cluster_id: relevantCluster, grounding_status: "VERIFIED", grounding_confidence: 0.9 },
        { id: "claim-unrelated", story_cluster_id: unrelatedCluster, grounding_status: "VERIFIED", grounding_confidence: 0.9 },
      ]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([
        { claim_id: "claim-relevant", editorial_role: "FACT_PRIMARY", source_observation_id: "observation-1" },
        { claim_id: "claim-unrelated", editorial_role: "FACT_PRIMARY", source_observation_id: "observation-2" },
      ]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([
        { id: "observation-1", discovery_signal: 0.8, observed_at: "2026-09-27T11:00:00Z" },
        { id: "observation-2", discovery_signal: 0.8, observed_at: "2026-09-27T11:00:00Z" },
      ]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([]));
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

Deno.test("ranking repository joins real claim UUIDs and scales discovery signals", async () => {
  const claimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const observationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    now: () => new Date("2026-09-27T12:00:00Z"),
    request: async (input) => {
      const url = String(input);
      if (url.includes("story_claims")) return new Response(JSON.stringify([
        { id: claimId, story_cluster_id: relevantCluster, grounding_status: "DISCOVERY_ONLY", grounding_confidence: null },
      ]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([
        { claim_id: claimId, editorial_role: "DISCOVERY_COMPETITOR", source_observation_id: observationId },
      ]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([
        { id: observationId, discovery_signal: 0.8, observed_at: "2026-09-27T11:00:00Z" },
      ]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([
        { id: relevantCluster, last_seen_at: "2026-09-27T11:00:00Z", canonical_title: "산초, 3개월째 FA", summary: "맨유와 계약이 끝난 뒤 새 팀을 찾고 있다.", signature_json: { entities: ["jadon_sancho"] } },
      ]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("matches")) return new Response(JSON.stringify([]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const inputs = await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0]?.discoveryObservationCount, 1);
  assertEquals(inputs[0]?.discoveryAudienceSignalScore, 80);
  assertEquals(inputs[0]?.informationGapScore, 100);
});

Deno.test("ranking repository treats linked Instagram posts as discovery inputs", async () => {
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    now: () => new Date("2026-09-27T12:00:00Z"),
    request: async (input) => {
      const url = String(input);
      if (url.includes("story_claims")) return new Response(JSON.stringify([]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([
        { id: relevantCluster, last_seen_at: "2026-09-27T11:00:00Z", canonical_title: "산초, 3개월째 FA", summary: "맨유와 계약이 끝난 뒤 새 팀을 찾고 있다.", signature_json: { entities: ["jadon_sancho"] } },
      ]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([
        { story_cluster_id: relevantCluster, raw_posts: { source_accounts: { username: "todayfootball", priority_weight: 1 } } },
        { story_cluster_id: relevantCluster, raw_posts: { source_accounts: { username: "footballoop.mag", priority_weight: 1 } } },
      ]));
      if (url.includes("matches")) return new Response(JSON.stringify([]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const inputs = await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0]?.discoveryObservationCount, 2);
  assertEquals(inputs[0]?.discoveryAudienceSignalScore, 100);
  assertEquals(inputs[0]?.informationGapScore, 100);
});

Deno.test("ranking repository uses the registered fact-source reliability for grounded stories", async () => {
  const claimId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const observationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    now: () => new Date("2026-09-27T12:00:00Z"),
    request: async (input) => {
      const url = String(input);
      if (url.includes("story_claims")) return new Response(JSON.stringify([
        { id: claimId, story_cluster_id: relevantCluster, grounding_status: "VERIFIED", grounding_confidence: 0.4 },
      ]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([
        { claim_id: claimId, editorial_role: "FACT_INDEPENDENT", source_observation_id: observationId },
      ]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([
        { id: observationId, information_source_id: "source-bbc", discovery_signal: 0.5, observed_at: "2026-09-27T11:00:00Z" },
      ]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-bbc", reliability_score: 8 }]));
      if (url.includes("story_clusters")) return new Response(JSON.stringify([
        { id: relevantCluster, last_seen_at: "2026-09-27T11:00:00Z", canonical_title: "산초, 3개월째 FA", summary: "맨유와 계약이 끝난 뒤 새 팀을 찾고 있다.", signature_json: { entities: ["jadon_sancho"] } },
      ]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("matches")) return new Response(JSON.stringify([]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const inputs = await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");

  assertEquals(inputs[0]?.factGroundingScore, 80);
});
