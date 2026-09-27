import type { GroundingStatus } from "../ground-claims/types.ts";

export interface EditorialRankingInput {
  readonly storyClusterId: string;
  readonly rankingDate: string;
  readonly groundingStatus: GroundingStatus;
  readonly factGroundingScore: number;
  readonly discoveryAudienceSignalScore: number;
  readonly matchContextScore: number;
  readonly freshnessScore: number;
  readonly informationGapScore: number;
  readonly verifiedClaimCount: number;
  readonly contradictedClaimCount: number;
  readonly discoveryObservationCount: number;
}

export interface EditorialRanking extends EditorialRankingInput {
  readonly rankingVersion: string;
  readonly editorialScore: number;
  readonly rank: number;
  readonly newsEligible: boolean;
  readonly reasonCodes: readonly string[];
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
}

export interface EditorialRankingRepository {
  listInputs(asOf?: Date, rankingDate?: string): Promise<readonly EditorialRankingInput[]>;
  /** Replace the derived ranking projection for one date/version. */
  clearRankings?: (rankingDate: string, rankingVersion: string) => Promise<void>;
  upsertRanking(ranking: EditorialRanking): Promise<void>;
}

export interface EditorialRankingRunInput {
  readonly asOf?: Date;
  readonly rankingDate?: string;
}

export interface EditorialRankingSummary {
  readonly status: "COMPLETED";
  readonly ranked: number;
  readonly newsEligible: number;
  readonly researchLeads: number;
  readonly version: string;
}
