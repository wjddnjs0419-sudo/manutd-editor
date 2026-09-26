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
