import { buildIntelligenceCompleteFingerprint, type IntelligenceSummaryInput, type IntelligenceSummaryStory } from "../_shared/m6/alerts.ts";

export interface IntelligenceRankingRow {
  story_cluster_id: string;
  ranking_version: string;
  rank: number | null;
  editorial_score: number;
  information_gap_score: number;
  discovery_audience_signal_score: number;
  grounding_status: string;
  news_eligible: boolean;
}

export interface IntelligenceClusterRow {
  id: string;
  canonical_title: string;
}

export interface IntelligenceSummaryEvent {
  thread_id: string;
  event_type: "INTELLIGENCE_COMPLETE";
  event_fingerprint: string;
  payload: Record<string, unknown>;
  status: "PENDING";
}

export interface IntelligenceSummaryMaterializerRepository {
  intelligenceSucceeded: (businessDate: string) => Promise<boolean>;
  listRankings: (businessDate: string) => Promise<readonly IntelligenceRankingRow[]>;
  listClusters: (storyClusterIds: readonly string[]) => Promise<readonly IntelligenceClusterRow[]>;
  insertEvent: (event: IntelligenceSummaryEvent) => Promise<boolean>;
}

export async function materializeIntelligenceCompleteAlert(input: {
  businessDate: string;
  threadId: string;
  repository: IntelligenceSummaryMaterializerRepository;
}): Promise<boolean> {
  if (!input.threadId || !(await input.repository.intelligenceSucceeded(input.businessDate))) return false;
  const rankings = await input.repository.listRankings(input.businessDate);
  if (rankings.length === 0) return false;
  const titles = new Map((await input.repository.listClusters(rankings.map((ranking) => ranking.story_cluster_id))).map((cluster) => [cluster.id, cluster.canonical_title] as const));
  const stories: IntelligenceSummaryStory[] = rankings.flatMap((ranking) => {
    const title = titles.get(ranking.story_cluster_id);
    if (!title) return [];
    return [{
      story_id: ranking.story_cluster_id,
      title,
      rank: ranking.rank,
      editorial_score: ranking.editorial_score,
      information_gap_score: ranking.information_gap_score,
      discovery_audience_signal_score: ranking.discovery_audience_signal_score,
      grounding_status: ranking.grounding_status,
      news_eligible: ranking.news_eligible,
    }];
  });
  if (stories.length === 0) return false;
  const summary: IntelligenceSummaryInput = { business_date: input.businessDate, ranking_version: rankings[0]!.ranking_version, stories };
  return input.repository.insertEvent({
    thread_id: input.threadId,
    event_type: "INTELLIGENCE_COMPLETE",
    event_fingerprint: buildIntelligenceCompleteFingerprint(summary),
    payload: summary as unknown as Record<string, unknown>,
    status: "PENDING",
  });
}

