import assert from "node:assert/strict";
import { runEditorialRanking } from "../../rank-editorial/orchestrator.ts";
import type { EditorialRankingInput, EditorialRankingRepository } from "../../rank-editorial/types.ts";

const inputs: EditorialRankingInput[] = [
  { storyClusterId: "cluster-1", rankingDate: "2026-09-27", groundingStatus: "VERIFIED", factGroundingScore: 100, discoveryAudienceSignalScore: 50, matchContextScore: 100, freshnessScore: 90, informationGapScore: 0, verifiedClaimCount: 1, contradictedClaimCount: 0, discoveryObservationCount: 1 },
  { storyClusterId: "cluster-2", rankingDate: "2026-09-27", groundingStatus: "DISCOVERY_ONLY", factGroundingScore: 0, discoveryAudienceSignalScore: 80, matchContextScore: 0, freshnessScore: 100, informationGapScore: 100, verifiedClaimCount: 0, contradictedClaimCount: 0, discoveryObservationCount: 2 },
];

Deno.test("ranking persists deterministic positions and summary", async () => {
  const saved: Array<{ id: string; rank: number | null }> = [];
  const cleared: string[] = [];
  const repository: EditorialRankingRepository = {
    listInputs: async () => inputs,
    clearRankings: async (rankingDate, rankingVersion) => { cleared.push(`${rankingDate}:${rankingVersion}`); },
    upsertRanking: async (ranking) => { saved.push({ id: ranking.storyClusterId, rank: ranking.rank }); },
  };
  const result = await runEditorialRanking({ repository, rankingDate: "2026-09-27", version: "m8-c-v1" });
  assert.deepEqual(result, { status: "COMPLETED", ranked: 2, newsEligible: 1, researchLeads: 1, version: "m8-c-v1" });
  assert.deepEqual(cleared, ["2026-09-27:m8-c-v1"]);
  assert.deepEqual(saved, [{ id: "cluster-2", rank: 1 }, { id: "cluster-1", rank: 2 }]);
});
