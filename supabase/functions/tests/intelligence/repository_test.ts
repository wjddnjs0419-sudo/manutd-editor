import assert from "node:assert/strict";
import { assertEquals } from "jsr:@std/assert@1";
import { createIntelligenceRepository } from "../../intelligence/repository.ts";

Deno.test("candidate calculation uses the active Telegram business timezone", async () => {
  let rankingDate = "";
  const repository = createIntelligenceRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    fetch: async (input: RequestInfo | URL, init?: globalThis.RequestInit) => {
      const url = String(input);
      if (url.includes("telegram_agent_configs")) return new Response(JSON.stringify([{ timezone: "Asia/Seoul" }]), { status: 200 });
      rankingDate = JSON.parse(String(init?.body)).p_ranking_date;
      return new Response(JSON.stringify(1), { status: 200 });
    },
  });

  await repository.calculateCandidates(new Date("2026-09-20T23:30:00Z"));
  assertEquals(rankingDate, "2026-09-21");
});

Deno.test("loads optional current-contract content understanding through app_private and falls back safely", async () => {
  const requests: string[] = [];
  const repository = createIntelligenceRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("raw_posts")) {
        return new Response(JSON.stringify([{
          id: "post-1",
          source_account_id: "account-1",
          caption: "Thoughts?",
          media_type: "IMAGE",
          published_at: "2026-09-20T10:00:00Z",
          collected_at: "2026-09-20T10:01:00Z",
          source_accounts: {
            id: "account-1",
            username: "account",
            region: "GLOBAL",
            active: true,
            api_supported: true,
            priority_weight: 1,
          },
        }]), { status: 200 });
      }
      if (url.includes("content_understandings")) {
        return new Response(JSON.stringify([{
          raw_post_id: "post-1",
          status: "PARTIAL",
          analysis_version: "m8-a-v1",
          visual_summary: "Jadon Sancho training",
          combined_summary: "The post claims three months without a club.",
          entities: ["Jadon Sancho"],
          topics: ["clubless period"],
          on_image_text: [{ text: "3 months", slideIndex: 2, confidence: 0.9 }],
          important_numbers: ["3 months"],
          source_names: [],
          claims: [],
          evidence_state: { visualSummary: "OBSERVED" },
        }]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    },
  });

  const posts = await repository.listRecentPosts(new Date("2026-09-20T12:00:00Z"));
  assert.equal(posts[0]?.contentUnderstanding?.status, "PARTIAL");
  assert.deepEqual(posts[0]?.contentUnderstanding?.entities, ["Jadon Sancho"]);
  assert.ok(requests.some((url) => url.includes("content_understandings")));

  const fallbackRepository = createIntelligenceRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-key",
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("raw_posts")) {
        return new Response(JSON.stringify([{
          id: "post-1",
          source_account_id: "account-1",
          caption: "Bruno injury update",
          media_type: "IMAGE",
          published_at: "2026-09-20T10:00:00Z",
          collected_at: "2026-09-20T10:01:00Z",
        }]), { status: 200 });
      }
      return new Response("not-json", { status: 503 });
    },
  });
  const fallbackPosts = await fallbackRepository.listRecentPosts(new Date("2026-09-20T12:00:00Z"));
  assert.equal(fallbackPosts[0]?.contentUnderstanding, undefined);
});
