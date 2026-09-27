import assert from "node:assert/strict";
import { calculateEditorialScore, rankEditorialInputs } from "../../rank-editorial/scoring.ts";
import type { EditorialRankingInput } from "../../rank-editorial/types.ts";

const lead: EditorialRankingInput = {
  storyClusterId: "cluster-lead",
  rankingDate: "2026-09-27",
  groundingStatus: "DISCOVERY_ONLY",
  factGroundingScore: 0,
  discoveryAudienceSignalScore: 90,
  matchContextScore: 20,
  freshnessScore: 100,
  informationGapScore: 100,
  verifiedClaimCount: 0,
  contradictedClaimCount: 0,
  discoveryObservationCount: 3,
};

Deno.test("editorial score uses the fixed 35/30/15/10/10 weights", () => {
  const result = calculateEditorialScore(lead, "m8-c-v1");
  assert.equal(result.editorialScore, 60.5);
  assert.equal(result.newsEligible, false);
  assert(result.inputSnapshot !== undefined);
  assert.equal("published_posts" in result.inputSnapshot, false);
  assert.equal("performance_metrics" in result.inputSnapshot, false);
});

Deno.test("verified claims gate news eligibility and stable ties", () => {
  const verified = calculateEditorialScore({ ...lead, storyClusterId: "cluster-a", groundingStatus: "VERIFIED", factGroundingScore: 100, verifiedClaimCount: 1, informationGapScore: 0 }, "m8-c-v1");
  assert.equal(verified.newsEligible, true);
  const ranked = rankEditorialInputs([lead, { ...lead, storyClusterId: "cluster-a" }], "m8-c-v1");
  assert.deepEqual(ranked.map((item) => item.rank), [1, 2]);
  assert.equal(ranked[0].storyClusterId, "cluster-a");
});
