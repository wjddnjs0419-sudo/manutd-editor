export interface HistoricalContext {
  kind: "match" | "candidate" | "brief" | "message";
  id: string;
  text: string;
  [key: string]: unknown;
}

export interface RetrievalThreadState {
  active_candidate_id: string | null;
  active_brief_id: string | null;
  active_match_id: string | null;
}

export interface RetrievalDependencies {
  findLastFinishedMatch: () => Promise<{ id: string; status: string; [key: string]: unknown } | null>;
  findByMatch: (match: { id: string }) => Promise<readonly HistoricalContext[]>;
  searchText: (terms: readonly string[], thread: RetrievalThreadState) => Promise<readonly HistoricalContext[]>;
  findByActive?: (thread: RetrievalThreadState) => Promise<readonly HistoricalContext[]>;
}

const HISTORY_TERMS = /(?:지난\s*(?:주|경기)|지난경기|전에|예전에|이전에|previous|last\s+week|last\s+match)/iu;

export function shouldRetrieveHistory(message: string): boolean {
  return HISTORY_TERMS.test(message);
}

function tokens(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).map((value) => value.trim()).filter((value) => value.length >= 2 && !/^(지난|경기|뭐가|중요해|관련|what|was|the|last|match)$/u.test(value)))].slice(0, 8);
}

export async function retrieveHistoricalContext(query: string, thread: RetrievalThreadState, dependencies: RetrievalDependencies): Promise<HistoricalContext[]> {
  if (/(?:지난\s*경기|last\s+match)/iu.test(query)) {
    const match = await dependencies.findLastFinishedMatch();
    if (match) return (await dependencies.findByMatch(match)).slice(0, 5);
  }
  if (dependencies.findByActive && (thread.active_candidate_id || thread.active_brief_id || thread.active_match_id)) {
    const active = await dependencies.findByActive(thread);
    if (active.length > 0) return active.slice(0, 5);
  }
  return (await dependencies.searchText(tokens(query), thread)).slice(0, 5);
}
