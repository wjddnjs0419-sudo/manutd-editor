import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createM6Repository } from "../../_shared/m6/repository.ts";
import { selectBriefingCandidates } from "../../_shared/m6/briefing.ts";
import { countReadinessCandidates } from "../../_shared/m6/readiness.ts";

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
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([{ story_cluster_id: "cluster-b", rank: 1, editorial_score: 91.5, grounding_status: "VERIFIED", news_eligible: true }]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    },
  });
  const rows = await repository.listBriefingCandidates("2026-09-20", "2026-09-20T00:00:00.000Z");
  assertEquals(rows.map((row) => row.candidate_id), ["candidate-b", "candidate-a"]);
  assertEquals(rows[0]?.grounding_status, "VERIFIED");
  assertEquals(rows[0]?.news_eligible, true);
  assertEquals(rows[0]?.editorial_score, 91.5);
  assertEquals(requests.some((url) => url.includes("ranking_date=eq.2026-09-20")), true);
  assertEquals(requests.some((url) => url.includes("score_inputs->>run_at=eq.2026-09-20T00%3A00%3A00.000%2B00%3A00")), true);
  assertEquals(requests.some((url) => url.includes("score_inputs->>run_at=is.null")), true);
});

Deno.test("M6 repository gives ranked fact observations their current rating and source cluster", async () => {
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("content_candidates")) return new Response(JSON.stringify([]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([{ story_cluster_id: "cluster-a", rank: 2, editorial_score: 84.25, grounding_status: "VERIFIED", news_eligible: true }]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([{
        id: "observation-1",
        information_source_id: "source-1",
        editorial_role: "FACT_INDEPENDENT",
        title: "The teething troubles with Man Utd's tactics under Olid",
        excerpt: "Independent Manchester United reporting.",
        canonical_url: "https://www.bbc.co.uk/sport/football/articles/example",
        observed_at: "2026-09-20T08:00:00.000Z",
      }, {
        id: "observation-2",
        information_source_id: "source-1",
        editorial_role: "FACT_INDEPENDENT",
        title: "Manchester City dominate the derby",
        excerpt: "Manchester City reporting unrelated to Manchester United.",
        canonical_url: "https://www.bbc.co.uk/sport/football/articles/city-example",
        observed_at: "2026-09-20T07:00:00.000Z",
      }]));
      if (url.includes("claim_evidence")) return new Response(JSON.stringify([{ claim_id: "claim-a", source_observation_id: "observation-1", editorial_role: "FACT_INDEPENDENT", is_grounding: true }]));
      if (url.includes("story_claims")) return new Response(JSON.stringify([{ id: "claim-a", story_cluster_id: "cluster-a" }]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1", canonical_name: "BBC Sport" }]));
      return new Response(JSON.stringify([]));
    },
  });

  const rows = await repository.listBriefingCandidates("2026-09-20");

  assertEquals(rows, [{
    candidate_id: "source:observation-1",
    candidate_type: "FACT_SOURCE",
    readiness_counted: false,
    rank: null,
    priority_score: null,
    first_mover_flag: false,
    must_cover_flag: false,
    creative_status: "NOT_REQUESTED",
    reference_posts: [],
    story_cluster_id: "cluster-a",
    editorial_rank: 2,
    editorial_score: 84.25,
    grounding_status: "VERIFIED",
    news_eligible: true,
    title: "The teething troubles with Man Utd's tactics under Olid",
    source_name: "BBC Sport",
    source_url: "https://www.bbc.co.uk/sport/football/articles/example",
  }]);
});

Deno.test("M6 repository attaches a resolved Google News publisher link to a ranked candidate", async () => {
  const storyId = "11111111-1111-4111-8111-111111111111";
  const requests: string[] = [];
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("content_candidates")) return new Response(JSON.stringify([{
        id: "candidate-a", rank: 6, priority_score: 88, first_mover_flag: false, must_cover_flag: false,
        story_cluster_id: storyId, creative_briefs: [],
      }]));
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([{
        story_cluster_id: storyId, rank: 1, editorial_score: 91.25, grounding_status: "VERIFIED", news_eligible: true,
      }]));
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([{
        id: "discovery-a", story_cluster_id: storyId, title: "United injury update - Sky Sports",
        article_final_url: null, resolved_publisher_url: "https://www.skysports.com/football/news/123?utm_source=google#story",
        article_extraction_status: "EXTRACTED", url_resolution_status: "RESOLVED", published_at: "2026-09-20T09:00:00Z",
      }]));
      if (url.includes("story_cluster_posts")) return new Response(JSON.stringify([]));
      if (url.includes("source_observations")) return new Response(JSON.stringify([]));
      if (url.includes("information_sources")) return new Response(JSON.stringify([]));
      return new Response(JSON.stringify([]));
    },
  });

  const rows = await repository.listBriefingCandidates("2026-09-20", "2026-09-20T00:00:00.000Z");

  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.candidate_id, "candidate-a");
  assertEquals(rows[0]?.story_cluster_id, storyId);
  assertEquals(rows[0]?.editorial_score, 91.25);
  assertEquals(rows[0]?.editorial_rank, 1);
  assertEquals(rows[0]?.source_url, "https://www.skysports.com/football/news/123");
  assertEquals(rows[0]?.source_name, "skysports.com");
  assertEquals(requests.some((url) => url.includes("provider_id=eq.google-news") && url.includes("url_resolution_status=eq.RESOLVED")), true);
});

Deno.test("M6 repository restores eligible legacy rows while excluding current unverified rows", async () => {
  const storyId = "22222222-2222-4222-8222-222222222222";
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("content_candidates")) {
        if (url.includes("score_inputs->>run_at=is.null")) return new Response(JSON.stringify([{
          id: "candidate-legacy", rank: 15, priority_score: 82, first_mover_flag: false, must_cover_flag: false,
          story_cluster_id: storyId, creative_briefs: [],
        }]));
        return new Response(JSON.stringify([{
          id: "candidate-current", rank: 1, priority_score: 99, first_mover_flag: false, must_cover_flag: false,
          story_cluster_id: "33333333-3333-4333-8333-333333333333", creative_briefs: [],
        }]));
      }
      if (url.includes("editorial_rankings")) return new Response(JSON.stringify([
        { story_cluster_id: storyId, rank: 1, editorial_score: 89.5, grounding_status: "VERIFIED", news_eligible: true },
        { story_cluster_id: "33333333-3333-4333-8333-333333333333", rank: 2, editorial_score: 90, grounding_status: "INSUFFICIENT", news_eligible: false },
      ]));
      if (url.includes("discovery_observations")) return new Response(JSON.stringify([{
        id: "discovery-legacy", story_cluster_id: storyId, title: "A verified United report",
        article_final_url: null, resolved_publisher_url: "https://www.examplepublisher.com/united-report",
        article_extraction_status: "EXTRACTED", url_resolution_status: "RESOLVED", published_at: "2026-09-20T09:00:00Z",
      }]));
      return new Response(JSON.stringify([]));
    },
  });

  const rows = await repository.listBriefingCandidates("2026-09-20", "2026-09-20T10:00:00.000Z");
  const selected = selectBriefingCandidates(rows);

  assertEquals(countReadinessCandidates(rows), 1);
  assertEquals(selected.map((row) => row.candidate_id), ["candidate-legacy"]);
  assertEquals(selected[0]?.editorial_score, 89.5);
  assertEquals(selected[0]?.source_url, "https://www.examplepublisher.com/united-report");
});
