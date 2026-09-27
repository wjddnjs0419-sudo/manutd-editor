import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { materializeIntelligenceCompleteAlert, type IntelligenceSummaryEvent, type IntelligenceSummaryMaterializerRepository } from "../../telegram-alerts/intelligence_summary.ts";

const rankings = [
  { story_cluster_id: "story-1", ranking_version: "m8-v1", rank: 1, editorial_score: 91.2, information_gap_score: 94, discovery_audience_signal_score: 88, grounding_status: "VERIFIED", news_eligible: true },
  { story_cluster_id: "story-2", ranking_version: "m8-v1", rank: 6, editorial_score: 70.2, information_gap_score: 72, discovery_audience_signal_score: 65, grounding_status: "DISCOVERY_ONLY", news_eligible: false },
];

Deno.test("materializes one summary event for a successful changed ranking and deduplicates unchanged reruns", async () => {
  const inserted: IntelligenceSummaryEvent[] = [];
  const repository: IntelligenceSummaryMaterializerRepository = {
    intelligenceSucceeded: async () => true,
    listRankings: async () => rankings,
    listClusters: async () => [{ id: "story-1", canonical_title: "산초, 3개월째 FA" }, { id: "story-2", canonical_title: "가르나초 최근 4경기 0분" }],
    insertEvent: async (event) => {
      if (inserted.some((value) => value.event_fingerprint === event.event_fingerprint)) return false;
      inserted.push(event);
      return true;
    },
  };
  assertEquals(await materializeIntelligenceCompleteAlert({ businessDate: "2026-09-27", threadId: "thread-1", repository }), true);
  assertEquals(await materializeIntelligenceCompleteAlert({ businessDate: "2026-09-27", threadId: "thread-1", repository }), false);
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0]?.event_type, "INTELLIGENCE_COMPLETE");
  assertEquals((inserted[0]?.payload as { stories?: unknown[] }).stories?.length, 2);
});

Deno.test("does not materialize a summary without successful intelligence or current stories", async () => {
  let inserts = 0;
  const repository: IntelligenceSummaryMaterializerRepository = {
    intelligenceSucceeded: async () => false,
    listRankings: async () => rankings,
    listClusters: async () => [],
    insertEvent: async () => { inserts += 1; return true; },
  };
  assertEquals(await materializeIntelligenceCompleteAlert({ businessDate: "2026-09-27", threadId: "thread-1", repository }), false);
  assertEquals(inserts, 0);
  assertEquals(await materializeIntelligenceCompleteAlert({ businessDate: "2026-09-27", threadId: "thread-1", repository: { ...repository, intelligenceSucceeded: async () => true } }), false);
  assertEquals(inserts, 0);
});
