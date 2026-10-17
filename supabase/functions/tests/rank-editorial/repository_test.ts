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
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([]));
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
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([]));
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
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([]));
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
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([]));
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const inputs = await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");

  assertEquals(inputs[0]?.factGroundingScore, 80);
});


Deno.test("rank repository sends service-role authorization and app_private profiles", async () => {
  const privateHeaders: Headers[] = [];
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-secret",
    request: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      if (url.pathname.endsWith("/story_claims")) privateHeaders.push(headers);
      return Response.json([]);
    },
  });

  await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27");

  assertEquals(privateHeaders.length, 1);
  const headers = privateHeaders[0]!;
  assertEquals(headers.get("apikey"), "service-role-secret");
  assertEquals(headers.get("authorization"), "Bearer service-role-secret");
  assertEquals(headers.get("accept-profile"), "app_private");
  assertEquals(headers.get("content-profile"), "app_private");
});

Deno.test("rank repository logs safe Data API timings with the handler request id", async () => {
  const entries: Record<string, unknown>[] = [];
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://private-project.example.supabase.co",
    serviceRoleKey: "must-never-appear-in-logs",
    log: (entry) => entries.push(entry),
    request: async () => Response.json([]),
  });

  await repository.listInputs(new Date("2026-09-27T12:00:00Z"), "2026-09-27", "request-safe-9");

  assertEquals(entries.length, 8);
  for (const entry of entries) {
    assertEquals(entry.requestId, "request-safe-9");
    assertEquals(entry.event, "rank_editorial_data_api");
    assertEquals(typeof entry.table, "string");
    assertEquals(typeof entry.elapsedMs, "number");
    assertEquals(entry.statusClass, "2xx");
    assertEquals(entry.outcome, "completed");
    assertEquals(Object.keys(entry).every((key) => ["requestId", "event", "table", "elapsedMs", "statusClass", "outcome"].includes(key)), true);
  }
  assertEquals(JSON.stringify(entries).includes("must-never-appear-in-logs"), false);
  assertEquals(JSON.stringify(entries).includes("private-project.example"), false);
  assertEquals(JSON.stringify(entries).includes("select=id"), false);
});

Deno.test("ranking upsert writes same story date candidate projection", async () => {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    request: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/editorial_rankings")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/scoring_configs")) return Response.json([{ id: "config-m4" }]);
      if (url.pathname.endsWith("/content_candidates") && init?.method === "GET") return Response.json([]);
      if (url.pathname.endsWith("/content_candidates")) {
        writes.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
        return Response.json([{ id: "candidate-1" }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const ranking = {
    storyClusterId: relevantCluster, rankingDate: "2026-10-12", rankingVersion: "m8-v1", editorialScore: 83,
    informationGapScore: 20, factGroundingScore: 88, discoveryAudienceSignalScore: 60, matchContextScore: 0,
    freshnessScore: 92, verifiedClaimCount: 2, contradictedClaimCount: 0, discoveryObservationCount: 1,
    groundingStatus: "VERIFIED" as const, rank: 1, newsEligible: true, reasonCodes: ["VERIFIED_FACTS"], inputSnapshot: { policy: "v1" },
  };
  await repository.upsertRanking(ranking);
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.body.story_cluster_id, relevantCluster);
  assertEquals(writes[0]?.body.ranking_date, "2026-10-12");
  assertEquals((writes[0]?.body.score_inputs as Record<string, unknown>).m8_editorial_ranking, {
    ranking_version: "m8-v1", ranking_date: "2026-10-12", rank: 1, editorial_score: 83, news_eligible: true,
    reason_codes: ["VERIFIED_FACTS"], grounding_status: "VERIFIED", fact_grounding_score: 88,
  });
  assertEquals(writes[0]?.body.data_confidence, 88);
});

Deno.test("ranking projection preserves M4 component scores and flags", async () => {
  const writes: { method: string; body: Record<string, unknown> }[] = [];
  const m4 = { id: "candidate-existing", story_cluster_id: relevantCluster, scoring_config_id: "config-m4", score_inputs: { m4: "kept" }, global_spread_score: 9, first_mover_flag: true, must_cover_flag: false };
  const repository = createEditorialRankingRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role",
    request: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/editorial_rankings")) return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/scoring_configs")) return Response.json([{ id: "config-m4" }]);
      if (url.pathname.endsWith("/content_candidates") && init?.method === "GET") return Response.json([m4]);
      if (url.pathname.endsWith("/content_candidates") && init?.method === "PATCH") { writes.push({ method: "PATCH", body: JSON.parse(String(init.body)) }); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await repository.upsertRanking({
    storyClusterId: relevantCluster, rankingDate: "2026-10-12", rankingVersion: "m8-v1", editorialScore: 83,
    informationGapScore: 20, factGroundingScore: 88, discoveryAudienceSignalScore: 60, matchContextScore: 0,
    freshnessScore: 92, verifiedClaimCount: 2, contradictedClaimCount: 0, discoveryObservationCount: 1,
    groundingStatus: "VERIFIED", rank: 1, newsEligible: true, reasonCodes: ["VERIFIED_FACTS"], inputSnapshot: {},
  });
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.body.global_spread_score, undefined);
  assertEquals(writes[0]?.body.first_mover_flag, undefined);
  assertEquals(writes[0]?.body.must_cover_flag, undefined);
  assertEquals(writes[0]?.body.data_confidence, 88);
  assertEquals((writes[0]?.body.score_inputs as Record<string, unknown>).m4, "kept");
});
