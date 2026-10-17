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
  story_cluster_id?: string | null;
  editorial_rank?: number | null;
  editorial_score?: number | null;
  grounding_status?: string | null;
  news_eligible?: boolean;
  title?: string | null;
  source_name?: string | null;
  source_url?: string | null;
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
    story_cluster_id?: string | null;
    editorial_rank?: number | null;
    editorial_score?: number | null;
    grounding_status?: string | null;
    news_eligible?: boolean;
    title?: string | null;
    source_name?: string | null;
    source_url?: string | null;
  }[];
  blocked_failed: readonly Record<string, unknown>[];
}

function canonicalUrlIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLocaleLowerCase("en-US");
      if (normalized.startsWith("utm_") || ["gclid", "fbclid", "oc", "cmpid", "ref", "referrer"].includes(normalized)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.protocol}//${url.host.toLocaleLowerCase("en-US")}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function selectBriefingCandidates<T extends {
  candidate_id: string;
  grounding_status?: string | null;
  news_eligible?: boolean;
  story_cluster_id?: string | null;
  source_name?: string | null;
  source_url?: string | null;
}>(
  candidates: readonly T[],
): readonly T[] {
  const hasGroundingDecisions = candidates.some((candidate) => candidate.grounding_status !== undefined && candidate.grounding_status !== null);
  const eligible = hasGroundingDecisions ? candidates.filter((candidate) => candidate.news_eligible === true) : candidates;
  const unique: T[] = [];
  const seenStories = new Set<string>();
  const seenUrls = new Set<string>();
  for (const candidate of eligible) {
    const storyId = candidate.story_cluster_id?.trim();
    const urlIdentity = candidate.source_url ? canonicalUrlIdentity(candidate.source_url) : null;
    if (storyId && seenStories.has(storyId)) continue;
    if (urlIdentity && seenUrls.has(urlIdentity)) continue;
    if (storyId) seenStories.add(storyId);
    if (urlIdentity) seenUrls.add(urlIdentity);
    unique.push(candidate);
  }

  const diverse: T[] = [];
  const samePublisher: T[] = [];
  const unlinked: T[] = [];
  const seenPublishers = new Set<string>();
  for (const candidate of unique) {
    if (!candidate.source_url) {
      unlinked.push(candidate);
      continue;
    }
    let publisher = candidate.source_name?.trim().toLocaleLowerCase("en-US") ?? "";
    if (!publisher) publisher = canonicalUrlIdentity(candidate.source_url)?.split("/")[2] ?? "";
    if (!publisher || seenPublishers.has(publisher)) samePublisher.push(candidate);
    else {
      seenPublishers.add(publisher);
      diverse.push(candidate);
    }
  }
  return [...diverse, ...samePublisher, ...unlinked];
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
      ...(candidate.story_cluster_id !== undefined ? { story_cluster_id: candidate.story_cluster_id } : {}),
      ...(candidate.editorial_rank !== undefined ? { editorial_rank: candidate.editorial_rank } : {}),
      ...(candidate.editorial_score !== undefined ? { editorial_score: candidate.editorial_score } : {}),
      ...(candidate.grounding_status !== undefined ? { grounding_status: candidate.grounding_status } : {}),
      ...(candidate.news_eligible !== undefined ? { news_eligible: candidate.news_eligible } : {}),
      ...(candidate.title !== undefined ? { title: candidate.title } : {}),
      ...(candidate.source_name !== undefined ? { source_name: candidate.source_name } : {}),
      ...(candidate.source_url !== undefined ? { source_url: candidate.source_url } : {}),
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
