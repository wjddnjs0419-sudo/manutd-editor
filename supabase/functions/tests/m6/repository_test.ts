import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createM6Repository } from "../../_shared/m6/repository.ts";

Deno.test("M6 repository marks JSON writes with the JSON content type", async () => {
  let capturedHeaders: Headers | undefined;
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (_input: RequestInfo | URL, init?: globalThis.RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    },
  });

  await repository.saveFixtureSyncState({
    provider: "espn",
    last_full_sync_at: null,
    last_attempt_at: "2026-09-20T00:00:00.000Z",
    last_success_at: null,
    last_error_category: null,
  });

  assertEquals(capturedHeaders?.get("content-type"), "application/json");
});

Deno.test("M6 repository consumes same-date editorial ranking and preserves safe fallback", async () => {
  const requests: string[] = [];
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("content_candidates")) return new Response(JSON.stringify([
        { id: "candidate-a", rank: 1, priority_score: 90, first_mover_flag: false, must_cover_flag: false, story_cluster_id: "cluster-a", creative_briefs: [] },
        { id: "candidate-b", rank: 2, priority_score: 80, first_mover_flag: false, must_cover_flag: false, story_cluster_id: "cluster-b", creative_briefs: [] },
      ]));
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([{ story_cluster_id: "cluster-b", rank: 1, grounding_status: "VERIFIED", news_eligible: true }]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    },
  });
  const rows = await repository.listBriefingCandidates("2026-09-20");
  assertEquals(rows.map((row) => row.candidate_id), ["candidate-b", "candidate-a"]);
  assertEquals(rows[0]?.grounding_status, "VERIFIED");
  assertEquals(rows[0]?.news_eligible, true);
  assertEquals(requests.some((url) => url.includes("ranking_date=eq.2026-09-20")), true);
});

Deno.test("M6 repository exposes same-day fact observations as standalone briefing candidates", async () => {
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("content_candidates")) return new Response(JSON.stringify([]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([{
        id: "observation-1",
        information_source_id: "source-1",
        editorial_role: "FACT_INDEPENDENT",
        title: "The teething troubles with Man Utd's tactics under Olid",
        excerpt: "Independent Manchester United reporting.",
        canonical_url: "https://www.bbc.co.uk/sport/football/articles/example",
        observed_at: "2026-09-20T08:00:00.000Z",
      }]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1", canonical_name: "BBC Sport" }]));
      return new Response(JSON.stringify([]));
    },
  });

  const rows = await repository.listBriefingCandidates("2026-09-20");

  assertEquals(rows, [{
    candidate_id: "source:observation-1",
    candidate_type: "FACT_SOURCE",
    rank: null,
    priority_score: null,
    first_mover_flag: false,
    must_cover_flag: false,
    creative_status: "NOT_REQUESTED",
    reference_posts: [],
    editorial_rank: null,
    grounding_status: "VERIFIED",
    news_eligible: true,
    title: "The teething troubles with Man Utd's tactics under Olid",
    source_name: "BBC Sport",
    source_url: "https://www.bbc.co.uk/sport/football/articles/example",
  }]);
});
