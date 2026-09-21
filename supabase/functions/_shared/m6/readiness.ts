export type IntelligenceReadinessStatus = "RUNNING" | "SUCCEEDED" | "FAILED";
export type BriefingReadiness = "NOT_READY" | "DEGRADED" | "READY_EMPTY" | "READY_WITH_CANDIDATES";

export interface IntelligenceReadinessRecord {
  ranking_date: string;
  status: IntelligenceReadinessStatus;
  candidate_count: number;
  started_at: string;
  completed_at: string | null;
  error_category: string | null;
}

export function classifyReadiness(
  state: IntelligenceReadinessRecord | null,
  briefingDate: string,
  currentCandidateCount: number,
): BriefingReadiness {
  if (!state || state.ranking_date !== briefingDate || state.status === "RUNNING") return "NOT_READY";
  if (state.status === "FAILED") return "DEGRADED";
  if (state.status !== "SUCCEEDED" || !state.completed_at) return "NOT_READY";
  if (state.candidate_count !== currentCandidateCount) return "DEGRADED";
  return currentCandidateCount === 0 ? "READY_EMPTY" : "READY_WITH_CANDIDATES";
}
