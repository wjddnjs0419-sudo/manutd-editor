import type { EditorialRanking, EditorialRankingInput } from "./types.ts";

const WEIGHTS = {
  informationGap: 0.35,
  factGrounding: 0.30,
  discoveryAudienceSignal: 0.15,
  matchContext: 0.10,
  freshness: 0.10,
} as const;

function bounded(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function reasons(input: EditorialRankingInput): string[] {
  const values: string[] = [];
  if (input.informationGapScore >= 60) values.push("INFORMATION_GAP");
  if (input.groundingStatus === "VERIFIED") values.push("FACT_GROUNDED");
  if (input.groundingStatus === "DISCOVERY_ONLY") values.push("DISCOVERY_ONLY");
  if (input.groundingStatus === "CONTRADICTED") values.push("CONTRADICTED");
  if (input.matchContextScore >= 60) values.push("MATCH_CONTEXT");
  if (input.freshnessScore < 40) values.push("STALE");
  if (values.length === 0) values.push("INSUFFICIENT_EVIDENCE");
  return values;
}

function snapshot(input: EditorialRankingInput): Readonly<Record<string, unknown>> {
  return {
    storyClusterId: input.storyClusterId,
    rankingDate: input.rankingDate,
    groundingStatus: input.groundingStatus,
    factGroundingScore: bounded(input.factGroundingScore),
    discoveryAudienceSignalScore: bounded(input.discoveryAudienceSignalScore),
    matchContextScore: bounded(input.matchContextScore),
    freshnessScore: bounded(input.freshnessScore),
    informationGapScore: bounded(input.informationGapScore),
    verifiedClaimCount: input.verifiedClaimCount,
    contradictedClaimCount: input.contradictedClaimCount,
    discoveryObservationCount: input.discoveryObservationCount,
  };
}

export function calculateEditorialScore(input: EditorialRankingInput, version: string): EditorialRanking {
  const informationGapScore = bounded(input.informationGapScore);
  const factGroundingScore = bounded(input.factGroundingScore);
  const discoveryAudienceSignalScore = bounded(input.discoveryAudienceSignalScore);
  const matchContextScore = bounded(input.matchContextScore);
  const freshnessScore = bounded(input.freshnessScore);
  const editorialScore = Number((
    WEIGHTS.informationGap * informationGapScore
    + WEIGHTS.factGrounding * factGroundingScore
    + WEIGHTS.discoveryAudienceSignal * discoveryAudienceSignalScore
    + WEIGHTS.matchContext * matchContextScore
    + WEIGHTS.freshness * freshnessScore
  ).toFixed(3));
  const newsEligible = input.groundingStatus === "VERIFIED"
    && input.contradictedClaimCount === 0
    && input.verifiedClaimCount > 0
    && factGroundingScore >= 70;
  return {
    ...input,
    factGroundingScore,
    discoveryAudienceSignalScore,
    matchContextScore,
    freshnessScore,
    informationGapScore,
    rankingVersion: version,
    editorialScore,
    rank: 0,
    newsEligible,
    reasonCodes: reasons(input),
    inputSnapshot: snapshot(input),
  };
}

export function rankEditorialInputs(inputs: readonly EditorialRankingInput[], version: string): EditorialRanking[] {
  return inputs
    .map((input) => calculateEditorialScore(input, version))
    .sort((left, right) => right.editorialScore - left.editorialScore
      || right.factGroundingScore - left.factGroundingScore
      || right.freshnessScore - left.freshnessScore
      || left.storyClusterId.localeCompare(right.storyClusterId))
    .map((ranking, index) => ({ ...ranking, rank: index + 1 }));
}
