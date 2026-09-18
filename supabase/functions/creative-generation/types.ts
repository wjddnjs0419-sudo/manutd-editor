export type ContentMode = "NEWS_UPDATE" | "ANALYSIS_CONTEXT" | "MATCH_CONTENT";
export type MatchPhase = "PRE_MATCH" | "LIVE" | "POST_MATCH";
export type GenerationQuality = "FULL" | "PARTIAL";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface CandidateEvidenceInput {
  readonly candidate: {
    readonly id: string;
    readonly story_cluster_id: string;
    readonly ranking_date: string;
    readonly rank: number | null;
    readonly priority_score: number | null;
    readonly data_confidence: number | null;
    readonly first_mover_flag: boolean;
    readonly must_cover_flag: boolean;
    readonly korea_coverage_status: "KNOWN" | "UNCERTAIN";
    readonly score_version: string;
    readonly score_inputs: Record<string, JsonValue>;
  };
  readonly story: {
    readonly id: string;
    readonly canonical_title: string | null;
    readonly status: string;
    readonly first_seen_at: string;
    readonly last_seen_at: string;
  };
  readonly posts: readonly EvidencePostInput[];
  readonly sources: readonly EvidenceSourceInput[];
}

export interface EvidencePostInput {
  readonly raw_post_id: string;
  readonly source_account_id: string;
  readonly account_username: string;
  readonly region: string;
  readonly caption: string | null;
  readonly permalink: string | null;
  readonly published_at: string;
  readonly media_type: string;
}

export interface EvidenceSourceInput {
  readonly source_id: string;
  readonly canonical_name: string;
  readonly entity_type: string;
  readonly reliability_score: number | null;
  readonly evidence_text: string | null;
  readonly first_cited_post_id: string | null;
  readonly citation_count: number;
}

export interface EvidencePost extends EvidencePostInput {
  readonly evidence_id: `post:${string}`;
}

export interface EvidenceSource extends EvidenceSourceInput {
  readonly evidence_id: `source:${string}`;
}

export interface EvidenceSnapshot {
  readonly schema_version: "1.0";
  readonly candidate: CandidateEvidenceInput["candidate"];
  readonly story: CandidateEvidenceInput["story"];
  readonly posts: readonly EvidencePost[];
  readonly sources: readonly EvidenceSource[];
  readonly score_evidence: Readonly<Record<string, JsonValue>>;
  readonly evidence_ids: readonly string[];
}

export interface FingerprintInput {
  readonly candidate_id: string;
  readonly evidence_snapshot: EvidenceSnapshot | JsonValue;
  readonly content_mode: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly generation_config_version: string;
  readonly classifier_config_version: string;
  readonly generator_model_config: JsonValue;
  readonly [key: string]: unknown;
}

export interface CreativeBriefClaim {
  readonly claim_id: string;
  readonly type: "FACT" | "INFERENCE";
  readonly text: string;
  readonly evidence_ids: readonly string[];
}

export interface VisualDirection {
  readonly subject: string;
  readonly image_type: string;
  readonly layout_intent: string;
  readonly stat_emphasis: string | null;
  readonly text_hierarchy: readonly string[];
}

export interface CreativeBriefSlide {
  readonly slide_number: number;
  readonly purpose: string;
  readonly headline: string;
  readonly body: string;
  readonly claims: readonly CreativeBriefClaim[];
  readonly visual_direction: VisualDirection;
}

export interface CreativeBriefOutput {
  readonly schema_version: "1.0";
  readonly content_mode: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly generation_quality: GenerationQuality;
  readonly angle: string;
  readonly key_takeaway: string;
  readonly hooks: readonly { id: string; text: string }[];
  readonly slides: readonly CreativeBriefSlide[];
  readonly caption: { body: string; cta: string };
  readonly sources: readonly { evidence_id: string; label: string }[];
}
