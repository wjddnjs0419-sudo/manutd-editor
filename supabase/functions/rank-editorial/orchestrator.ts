import { rankEditorialInputs } from "./scoring.ts";
import type { EditorialRankingRepository, EditorialRankingRunInput, EditorialRankingSummary } from "./types.ts";

interface RunEditorialRankingOptions extends EditorialRankingRunInput {
  readonly repository: EditorialRankingRepository;
  readonly rankingDate: string;
  readonly version?: string;
}

export async function runEditorialRanking(options: RunEditorialRankingOptions): Promise<EditorialRankingSummary> {
  const version = options.version ?? "m8-c-v1";
  const inputs = await options.repository.listInputs(options.asOf, options.rankingDate);
  const rankings = rankEditorialInputs(inputs, version);
  // editorial_rankings is a derived projection. Replace one date/version
  // before writing so a previously ranked but now irrelevant story cannot
  // remain visible or keep an old rank in the current editorial window.
  await options.repository.clearRankings?.(options.rankingDate, version);
  await Promise.all(rankings.map((ranking) => options.repository.upsertRanking(ranking)));
  const newsEligible = rankings.filter((ranking) => ranking.newsEligible).length;
  return {
    status: "COMPLETED",
    ranked: rankings.length,
    newsEligible,
    researchLeads: rankings.length - newsEligible,
    version,
  };
}
