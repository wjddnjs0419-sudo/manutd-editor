export type SyncLifecycle = "CURRENT" | "DROPPED" | "EXPIRED";

export interface CandidateProjectionInput {
  candidate: {
    id: string;
    story_cluster_id: string;
    ranking_date: string;
    rank: number | null;
    priority_score: number | null;
    data_confidence: number | null;
    first_mover_flag: boolean;
    must_cover_flag: boolean;
    korea_coverage_status: "KNOWN" | "UNCERTAIN";
    global_spread_score: number | null;
    engagement_outperformance_score: number | null;
    engagement_velocity_score: number | null;
    velocity_acceleration_score: number | null;
    korea_gap_score: number | null;
    first_mover_score: number | null;
    korean_saturation_score: number | null;
    reliability_score: number | null;
    source_diversity_score: number | null;
    freshness_score: number | null;
    score_inputs: Record<string, unknown>;
    calculated_at: string;
  };
  cluster: {
    id: string;
    canonical_title: string | null;
    representative_title?: string | null;
    status: string;
    first_seen_at: string;
    last_seen_at: string;
  };
  references: Array<{
    username: string;
    region: string;
    permalink?: string | null;
    published_at?: string | null;
    source_name?: string | null;
  }>;
  lifecycle?: SyncLifecycle;
}

type RichText = { type: "text"; text: { content: string } };
type NotionProperty =
  | { title: RichText[] }
  | { rich_text: RichText[] }
  | { number: number | null }
  | { checkbox: boolean }
  | { select: { name: string } | null }
  | { date: { start: string } | null };

export interface NotionBlock {
  object: "block";
  type: "heading_2" | "bulleted_list_item" | "paragraph";
  heading_2?: { rich_text: RichText[] };
  bulleted_list_item?: { rich_text: RichText[] };
  paragraph?: { rich_text: RichText[] };
}

export interface NotionPagePayload {
  properties: Record<string, NotionProperty>;
  children: NotionBlock[];
}

function text(content: string): RichText {
  return { type: "text", text: { content: content.slice(0, 1900) } };
}

function title(content: string): NotionProperty {
  return { title: [text(content || "Untitled story")] };
}

function rich(content: string): NotionProperty {
  return { rich_text: content ? [text(content)] : [] };
}

function date(start: string | null | undefined): NotionProperty {
  return { date: start ? { start } : null };
}

function number(value: number | null | undefined): NotionProperty {
  return { number: value ?? null };
}

function checkbox(value: boolean): NotionProperty {
  return { checkbox: value };
}

function select(value: string | null): NotionProperty {
  return { select: value ? { name: value } : null };
}

function block(
  type: NotionBlock["type"],
  content: string,
): NotionBlock {
  const richText = { rich_text: [text(content)] };
  if (type === "heading_2") return { object: "block", type, heading_2: richText };
  if (type === "bulleted_list_item") {
    return { object: "block", type, bulleted_list_item: richText };
  }
  return { object: "block", type, paragraph: richText };
}

function evidence(input: CandidateProjectionInput): string {
  return canonicalJson(input.candidate.score_inputs);
}

export function syncIdentity(input: CandidateProjectionInput): string {
  return `${input.candidate.story_cluster_id}:${input.candidate.ranking_date}`;
}

export function buildNotionPagePayload(
  input: CandidateProjectionInput,
): NotionPagePayload {
  const candidate = input.candidate;
  const scoreInputs = candidate.score_inputs;
  const globalCoverage = typeof scoreInputs.global_coverage === "number"
    ? scoreInputs.global_coverage
    : null;
  const koreanCoverage = typeof scoreInputs.korean_coverage === "number"
    ? scoreInputs.korean_coverage
    : null;
  const velocityRatio = typeof scoreInputs.global_velocity_ratio === "number"
    ? scoreInputs.global_velocity_ratio
    : null;
  const lifecycle = input.lifecycle ?? "CURRENT";
  const referenceLinks = input.references
    .filter((reference) => reference.permalink)
    .map((reference) => `${reference.username}: ${reference.permalink}`)
    .join(" | ");
  const usernames = input.references.map((reference) => `${reference.username} (${reference.region})`).join(", ");
  const sourceNames = input.references
    .map((reference) => reference.source_name)
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(", ");

  return {
    properties: {
      Title: title(input.cluster.canonical_title ?? input.cluster.representative_title ?? "Untitled story"),
      "Sync Identity": rich(syncIdentity(input)),
      "Candidate ID": rich(candidate.id),
      "Story Cluster ID": rich(candidate.story_cluster_id),
      "Ranking Date": date(candidate.ranking_date),
      Rank: number(candidate.rank),
      "Priority Score": number(candidate.priority_score),
      "Data Confidence": number(candidate.data_confidence),
      FIRST_MOVER: checkbox(candidate.first_mover_flag),
      MUST_COVER: checkbox(candidate.must_cover_flag),
      "Korea Coverage Status": select(candidate.korea_coverage_status),
      "Global Coverage": number(globalCoverage),
      "Korean Coverage": number(koreanCoverage),
      "Engagement Outperformance": number(candidate.engagement_outperformance_score),
      "Velocity Ratio": number(velocityRatio),
      Reliability: number(candidate.reliability_score),
      "Source Diversity": number(candidate.source_diversity_score),
      "First Seen": date(input.cluster.first_seen_at),
      "Sync Lifecycle": select(lifecycle),
      "Supabase Updated At": date(candidate.calculated_at),
      "Last Synced At": date(null),
    },
    children: [
      block("heading_2", "Score component breakdown"),
      block("bulleted_list_item", `Priority ${candidate.priority_score ?? "n/a"} · Confidence ${candidate.data_confidence ?? "n/a"}`),
      block("bulleted_list_item", `Global spread ${candidate.global_spread_score ?? "n/a"} · Outperformance ${candidate.engagement_outperformance_score ?? "n/a"} · Velocity ${candidate.engagement_velocity_score ?? "n/a"}`),
      block("bulleted_list_item", `Acceleration ${candidate.velocity_acceleration_score ?? "n/a"} · Korea gap ${candidate.korea_gap_score ?? "n/a"} · First mover ${candidate.first_mover_score ?? "n/a"}`),
      block("bulleted_list_item", `Korean saturation ${candidate.korean_saturation_score ?? "n/a"} · Reliability ${candidate.reliability_score ?? "n/a"} · Diversity ${candidate.source_diversity_score ?? "n/a"} · Freshness ${candidate.freshness_score ?? "n/a"}`),
      block("heading_2", "Monitored coverage and source evidence"),
      block("paragraph", `Global coverage ${globalCoverage ?? "n/a"} · Korean coverage ${koreanCoverage ?? "n/a"} · Status ${candidate.korea_coverage_status}`),
      block("paragraph", `Accounts: ${usernames || "none"}`),
      block("paragraph", `Recognized sources: ${sourceNames || "none"}`),
      block("paragraph", `References: ${referenceLinks || "none"}`),
      block("heading_2", "Timing and deterministic evidence"),
      block("paragraph", `First seen ${input.cluster.first_seen_at} · Last seen ${input.cluster.last_seen_at}`),
      block("paragraph", `Score inputs: ${evidence(input)}`),
    ],
  };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function hashNotionPayload(payload: NotionPagePayload): Promise<string> {
  const hashable = {
    properties: Object.fromEntries(
      Object.entries(payload.properties).filter(([name]) => name !== "Last Synced At"),
    ),
    children: payload.children,
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(hashable)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
