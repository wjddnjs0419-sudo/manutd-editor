import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import {
  createNotionSyncRepository,
  NotionSyncRepositoryError,
} from "../../notion-sync/repository.ts";

const candidateId = "11111111-1111-1111-1111-111111111111";
const clusterId = "22222222-2222-2222-2222-222222222222";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("loads candidates, clusters, and references through service-role REST", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const repo = createNotionSyncRepository({
    supabaseUrl: "http://supabase.test",
    serviceRoleKey: "service-secret",
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("content_candidates")) {
        return response([{
          id: candidateId,
          story_cluster_id: clusterId,
          ranking_date: "2026-09-18",
          rank: 1,
          priority_score: 72,
          data_confidence: 90,
          first_mover_flag: false,
          must_cover_flag: true,
          korea_coverage_status: "KNOWN",
          global_spread_score: 10,
          engagement_outperformance_score: 8,
          engagement_velocity_score: 7,
          velocity_acceleration_score: 3,
          korea_gap_score: 12,
          first_mover_score: 6,
          korean_saturation_score: 2,
          reliability_score: 9,
          source_diversity_score: 3,
          freshness_score: 4,
          score_inputs: { global_coverage: 0.8 },
          calculated_at: "2026-09-18T03:00:00Z",
        }]);
      }
      if (String(input).includes("story_clusters")) {
        return response([{
          id: clusterId,
          canonical_title: "Test story",
          status: "ACTIVE",
          first_seen_at: "2026-09-18T01:00:00Z",
          last_seen_at: "2026-09-18T03:00:00Z",
        }]);
      }
      if (String(input).includes("story_cluster_posts")) {
        return response([{
          story_cluster_id: clusterId,
          raw_post_id: "33333333-3333-3333-3333-333333333333",
          raw_posts: {
            permalink: "https://example.com/post",
            published_at: "2026-09-18T01:00:00Z",
            source_accounts: { username: "utdreport", region: "GLOBAL" },
          },
        }]);
      }
      throw new Error(`unexpected URL ${String(input)}`);
    },
  });

  const candidates = await repo.listCandidates();

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]?.cluster.canonical_title, "Test story");
  assertEquals(candidates[0]?.references[0]?.username, "utdreport");
  assertEquals(candidates[0]?.references[0]?.permalink, "https://example.com/post");
  assertEquals(new URL(calls[0]?.url ?? "").pathname, "/rest/v1/content_candidates");
  assertEquals(calls.every((call) => call.init.headers && (call.init.headers as Record<string, string>).apikey === "service-secret"), true);
});

Deno.test("lists and upserts private sync state with the app_private profile", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const repo = createNotionSyncRepository({
    supabaseUrl: "http://supabase.test/",
    serviceRoleKey: "service-secret",
    fetch: async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return response((init as RequestInit).method === "POST" ? [] : [{
        sync_identity: `${clusterId}:2026-09-18`,
        candidate_id: candidateId,
        story_cluster_id: clusterId,
        ranking_date: "2026-09-18",
        notion_page_id: "notion-page",
        last_synced_hash: "hash",
        last_synced_at: "2026-09-18T03:00:00Z",
        sync_status: "CURRENT",
        last_error_category: null,
      }]);
    },
  });

  const states = await repo.listStates();
  await repo.saveState(states[0]!);

  assertEquals(states[0]?.notion_page_id, "notion-page");
  const stateCall = calls.find((call) => call.url.includes("notion_sync_state") && call.init.method === "POST");
  assertEquals((stateCall?.init.headers as Record<string, string>)["accept-profile"], "app_private");
  assertEquals((stateCall?.init.headers as Record<string, string>)["content-profile"], "app_private");
  assertEquals(stateCall?.init.method, "POST");
  assertEquals(stateCall?.init.body && JSON.parse(String(stateCall.init.body)).sync_identity, `${clusterId}:2026-09-18`);
});

Deno.test("maps Supabase HTTP failures to a safe repository error", async () => {
  const repo = createNotionSyncRepository({
    supabaseUrl: "http://supabase.test",
    serviceRoleKey: "service-secret",
    fetch: async () => response({ message: "secret database details" }, 500),
  });

  await assertRejects(
    () => repo.listStates(),
    NotionSyncRepositoryError,
    "DATABASE_HTTP_ERROR",
  );
});
