import type { MatchDayMode } from "./fixture_types.ts";
import type { RepresentativeReference } from "./reference_media.ts";

export interface FrozenBriefingItem {
  position: number;
  candidate_id: string;
  priority_score: number | null;
  first_mover_flag: boolean;
  must_cover_flag: boolean;
  creative_status: string;
  reference_post_id: string | null;
  reference_media_asset_id: string | null;
  reference_username: string | null;
  reference_permalink: string | null;
  title?: string | null;
  /** Ephemeral signed URL; never persist this field in the briefing snapshot. */
  reference_media_url?: string | null;
}

export interface MorningBriefingSnapshot {
  briefing_date: string;
  timezone: string;
  match_day_mode: MatchDayMode;
  match_context: Record<string, unknown>;
  overnight_counts: Record<string, number>;
  items: FrozenBriefingItem[];
  blocked_failed: readonly Record<string, unknown>[];
}

export interface MorningBriefingInput {
  briefing_date: string;
  timezone: string;
  match_day_mode: MatchDayMode;
  match_context: Record<string, unknown>;
  overnight_counts: Record<string, number>;
  candidates: readonly {
    candidate_id: string;
    priority_score: number | null;
    first_mover_flag: boolean;
    must_cover_flag: boolean;
    creative_status: string;
    representative: RepresentativeReference | null;
  }[];
  blocked_failed: readonly Record<string, unknown>[];
}

export function buildMorningBriefingSnapshot(input: MorningBriefingInput): MorningBriefingSnapshot {
  return {
    briefing_date: input.briefing_date,
    timezone: input.timezone,
    match_day_mode: input.match_day_mode,
    match_context: structuredClone(input.match_context),
    overnight_counts: { ...input.overnight_counts },
    items: input.candidates.slice(0, 3).map((candidate, index) => ({
      position: index + 1,
      candidate_id: candidate.candidate_id,
      priority_score: candidate.priority_score,
      first_mover_flag: candidate.first_mover_flag,
      must_cover_flag: candidate.must_cover_flag,
      creative_status: candidate.creative_status,
      reference_post_id: candidate.representative?.raw_post_id ?? null,
      reference_media_asset_id: candidate.representative?.media_asset_id ?? null,
      reference_username: candidate.representative?.username ?? null,
      reference_permalink: candidate.representative?.permalink ?? null,
    })),
    blocked_failed: input.blocked_failed.map((item) => structuredClone(item)),
  };
}

export function resolveBriefingPosition(
  briefing: MorningBriefingSnapshot,
  position: number,
): FrozenBriefingItem | null {
  return briefing.items.find((item) => item.position === position) ?? null;
}
