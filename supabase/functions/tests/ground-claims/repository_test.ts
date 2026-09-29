import assert from "node:assert/strict";
import { createGroundingRepository } from "../../ground-claims/repository.ts";

function repositoryWithRows(urls: string[]) {
  return createGroundingRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-secret",
    request: async (input) => {
      const url = new URL(String(input));
      urls.push(String(url));
      if (url.pathname.endsWith("story_cluster_posts")) return Response.json([{ story_cluster_id: "cluster-1", raw_post_id: "post-1" }]);
      if (url.pathname.endsWith("content_understandings")) return Response.json([{ raw_post_id: "post-1", claims: [{ subject: "United", predicate: "signed", object: "Player", text: "United signed Player", confidence: 0.9 }] }]);
      if (url.pathname.endsWith("story_claims")) return Response.json([1, 2, 3].map((n) => ({ id: `discovery-${n}`, story_cluster_id: "cluster-1", raw_post_id: null, discovery_observation_id: `observation-${n}`, claim_fingerprint: `fingerprint-${n}`, subject: "United", predicate: "signed", object: "Player", claim_text: "United signed Player", origin: "discovery_observation", extraction_confidence: 0.9 })));
      return Response.json([]);
    },
  });
}

Deno.test("grounding repository joins private observations to public source registry safely", async () => {
  const urls: string[] = [];
  const repository = createGroundingRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-secret",
    request: async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("source_observations")) return new Response(JSON.stringify([{ id: "observation-1", information_source_id: "source-1", editorial_role: "FACT_PRIMARY", title: "Official update", excerpt: "Manchester United official update", metadata: {} }]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1", canonical_name: "Manchester United" }]));
      return new Response(JSON.stringify([]));
    },
  });
  const observations = await repository.listObservations();
  assert.deepEqual(observations, [{ id: "observation-1", editorialRole: "FACT_PRIMARY", canonicalName: "Manchester United", title: "Official update", excerpt: "Manchester United official update", relation: "SUPPORTS" }]);
  assert.equal(urls.some((url) => url.includes("information_sources(canonical_name)")), false);
});

Deno.test("grounding repository pushes story, raw-post, and as-of scope into bounded queries", async () => {
  const urls: string[] = [];
  const repository = repositoryWithRows(urls);
  const page = await repository.listClaims({ storyClusterIds: ["cluster-1"], asOf: new Date("2026-09-27T02:00:00Z"), limit: 2, cursor: null } as never) as unknown as { claims: readonly unknown[]; hasMore: boolean; nextCursor: string | null };
  const query = (table: string) => new URL(urls.find((url) => new URL(url).pathname.endsWith(table)) ?? "https://missing.test").searchParams;
  assert.match(query("story_cluster_posts").get("story_cluster_id") ?? "", /cluster-1/);
  assert.match(query("story_claims").get("story_cluster_id") ?? "", /cluster-1/);
  assert.match(query("content_understandings").get("raw_post_id") ?? "", /post-1/);
  assert.match(query("content_understandings").get("created_at") ?? "", /2026-09-27T02:00:00/);
  assert.match(query("story_claims").get("created_at") ?? "", /2026-09-27T02:00:00/);
  assert.match(query("story_cluster_posts").get("created_at") ?? "", /2026-09-27T02:00:00/);
  assert.ok(page.claims.length <= 2);
  assert.equal(page.hasMore, true);
  assert.ok(page.nextCursor);
  assert.ok(Number(query("story_claims").get("limit")) <= 3);
});

Deno.test("grounding repository discovery cursor uses stable id keyset", async () => {
  const urls: string[] = [];
  const repository = repositoryWithRows(urls);
  await repository.listClaims({ storyClusterIds: ["cluster-1"], limit: 2, cursor: "d:discovery-1" } as never);
  const discovery = new URL(urls.find((url) => new URL(url).pathname.endsWith("story_claims")) ?? "https://missing.test");
  assert.match(discovery.searchParams.get("id") ?? "", /gt\..*discovery-1/);
  assert.match(discovery.searchParams.get("order") ?? "", /id\.asc/);
});

Deno.test("grounding repository keeps historical observations through as-of and excludes later rows", async () => {
  const urls: string[] = [];
  const repository = repositoryWithRows(urls);
  await repository.listObservations(new Date("2026-09-27T02:00:00Z"));
  const observations = new URL(urls.find((url) => new URL(url).pathname.endsWith("source_observations")) ?? "https://missing.test");
  assert.match(observations.searchParams.get("created_at") ?? "", /lte\.2026-09-27T02:00:00/);
  assert.equal(observations.searchParams.has("observed_at"), false);
  assert.equal(observations.searchParams.has("gte"), false);
});

Deno.test("grounding repository bounds empty-post scanning and returns a resumable scan cursor", async () => {
  const urls: string[] = [];
  const repository = createGroundingRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-secret",
    request: async (input) => {
      const url = new URL(String(input));
      urls.push(String(url));
      if (url.pathname.endsWith("story_cluster_posts")) {
        const after = url.searchParams.get("raw_post_id")?.replace(/^gt\./u, "") ?? "";
        const start = after ? Number(after.replace("post-", "")) + 1 : 0;
        return Response.json(Array.from({ length: Math.min(Number(url.searchParams.get("limit")), 350 - start) }, (_, offset) => ({ story_cluster_id: "cluster-1", raw_post_id: `post-${start + offset}` })));
      }
      if (url.pathname.endsWith("content_understandings")) return Response.json([]);
      if (url.pathname.endsWith("story_claims")) return Response.json([]);
      return Response.json([]);
    },
  });
  const page = await repository.listClaims({ storyClusterIds: ["cluster-1"], limit: 25 }) as { claims: readonly unknown[]; hasMore: boolean; nextCursor: string | null };
  assert.equal(page.claims.length, 0);
  assert.equal(page.hasMore, true);
  assert.match(page.nextCursor ?? "", /^p:post-/u);
  assert.ok(urls.length <= 30, `expected bounded requests, got ${urls.length}`);
});

Deno.test("grounding repository bounds analysis-row scans and resumes after the analysis cursor", async () => {
  const analysisRows = Array.from({ length: 101 }, (_, index) => ({
    id: `analysis-${index + 1}`,
    created_at: `2026-09-27T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
    raw_post_id: "post-1",
    claims: index === 99 || index === 100 ? [{ subject: "Manchester United", predicate: "signed", object: `Player ${index + 1}`, text: `Manchester United signed Player ${index + 1}`, confidence: 0.9 }] : [],
  }));
  let analysisCalls = 0;
  const repository = createGroundingRepository({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "service-role-secret",
    request: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("story_cluster_posts")) return Response.json([{ story_cluster_id: "cluster-1", raw_post_id: "post-1" }]);
      if (url.pathname.endsWith("content_understandings")) {
        analysisCalls += 1;
        const after = url.searchParams.get("or") ?? "";
        return Response.json(after ? analysisRows.slice(99) : analysisRows.slice(0, 100));
      }
      if (url.pathname.endsWith("story_claims")) return Response.json([]);
      return Response.json([]);
    },
  });

  const first = await repository.listClaims({ storyClusterIds: ["cluster-1"], limit: 25 }) as { claims: readonly { claimText?: string }[]; hasMore: boolean; nextCursor: string | null };
  assert.equal(first.claims.length, 1);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor ?? "", /^a2:/u);
  assert.equal(analysisCalls, 1);

  const second = await repository.listClaims({ storyClusterIds: ["cluster-1"], limit: 25, cursor: first.nextCursor }) as { claims: readonly { claimText?: string }[]; hasMore: boolean; nextCursor: string | null };
  assert.equal(second.claims.length, 1);
  assert.equal(second.claims.length, 1);
  assert.equal(second.claims[0]?.claimText, "Manchester United signed Player 101");
  assert.equal(second.hasMore, false);
  assert.equal(analysisCalls, 2);
});
