import type { MorningBriefingSnapshot } from "../_shared/m6/briefing.ts";
import { buildMorningBriefingSnapshot } from "../_shared/m6/briefing.ts";
import type { BriefingCandidateRow } from "../_shared/m6/repository.ts";
import type { BriefingReadiness } from "../_shared/m6/readiness.ts";
import { selectRepresentativeReference } from "../_shared/m6/reference_media.ts";
import { editorialLinkLabel, editorialTrustLabel, editorialTrustState, type TrustEvidence } from "../_shared/m6/editorial_trust.ts";

export interface CurrentReplyInput {
  briefingDate: string;
  readiness: BriefingReadiness;
  candidateCount: number;
  items: readonly { position: number; candidateId: string; priorityScore: number | null; username: string | null; title?: string | null; sourceName?: string | null; sourceUrl?: string | null; groundingStatus?: string | null; newsEligible?: boolean; evidence?: readonly TrustEvidence[] }[];
}

export function formatCurrentReply(input: CurrentReplyInput): string {
  if (input.readiness === "NOT_READY") return `${input.briefingDate} 현재 Intelligence가 아직 준비되지 않았습니다.`;
  if (input.readiness === "DEGRADED") return `${input.briefingDate} 현재 Intelligence 상태와 후보 수가 일치하지 않습니다.`;
  if (input.candidateCount === 0) return `${input.briefingDate} 현재 후보가 없습니다.`;
  const items = input.items.map((item) => {
    const score = item.priorityScore === null ? "Priority —" : `Priority ${item.priorityScore}`;
    const source = item.username ? ` · @${item.username}` : item.sourceName ? ` · ${item.sourceName}` : "";
    const title = item.title ? `${item.title}\n` : "";
    const trust = editorialTrustLabel(editorialTrustState({ grounding_status: item.groundingStatus, news_eligible: item.newsEligible, source_url: item.sourceUrl, evidence: item.evidence }));
    const url = item.sourceUrl ? `\n${editorialLinkLabel(item.sourceUrl)}: ${item.sourceUrl}` : "";
    return `${item.position}️⃣ ${title}${trust} · ${score}${source}${url}\n/open ${item.position}`;
  }).join("\n\n");
  return `${input.briefingDate} 현재 후보 ${input.candidateCount}건입니다.\n\n${items}`;
}

export function snapshotCurrentCandidates(briefingDate: string, rows: readonly BriefingCandidateRow[]): MorningBriefingSnapshot {
  return buildMorningBriefingSnapshot({
    briefing_date: briefingDate,
    timezone: "Asia/Seoul",
    match_day_mode: "NORMAL_DAY",
    match_context: {},
    overnight_counts: { candidates: rows.length },
    candidates: rows.slice(0, 3).map((row) => ({
      candidate_id: row.candidate_id,
      priority_score: row.priority_score,
      first_mover_flag: row.first_mover_flag,
      must_cover_flag: row.must_cover_flag,
      creative_status: row.creative_status,
      editorial_rank: row.editorial_rank,
      grounding_status: row.grounding_status,
      news_eligible: row.news_eligible,
      title: row.title,
      source_name: row.source_name,
      source_url: row.source_url,
      evidence: row.evidence,
      representative: selectRepresentativeReference(row.reference_posts),
    })),
    blocked_failed: [],
  });
}
