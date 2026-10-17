import type {
  CandidateEvidenceInput,
  EvidenceSnapshot,
  JsonValue,
} from "./types.ts";

export function validPublisherUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && !url.username && !url.password &&
      hostname.includes(".") && hostname !== "news.google.com" && !hostname.endsWith(".google.com") &&
      !hostname.endsWith(".googleusercontent.com") && !hostname.endsWith(".internal") && !hostname.endsWith(".localhost");
  } catch { return false; }
}

export function verifiedNewsSources(snapshot: EvidenceSnapshot): EvidenceSnapshot["sources"] {
  return snapshot.sources.filter((source) =>
    source.verified === true && source.is_grounding === true && source.relation === "SUPPORTS" &&
    (source.editorial_role === "FACT_PRIMARY" || source.editorial_role === "FACT_INDEPENDENT") &&
    (source.reliability_score ?? 0) >= 8 && typeof source.claim_id === "string" && source.claim_id.length > 0 &&
    typeof source.evidence_text === "string" && source.evidence_text.trim().length > 0 && validPublisherUrl(source.canonical_url) &&
    ((source.claim_scope === "PUBLISHER_REPORT" && source.claim_modality !== undefined && source.claim_modality !== "UNKNOWN") ||
      (source.claim_scope === "EVENT" && source.claim_modality === "CONFIRMED"))
  );
}

function hasId(value: string): boolean {
  return value.trim().length > 0;
}

function stableRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildEvidenceSnapshot(input: CandidateEvidenceInput, includeExplorationArticles = false): EvidenceSnapshot {
  const posts = input.posts
    .filter((post) => hasId(post.raw_post_id))
    .map((post) => ({ ...post, evidence_id: `post:${post.raw_post_id}` as const }))
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

  const sources = input.sources
    .filter((source) => hasId(source.source_id))
    .map((source) => ({ ...source, evidence_id: `source:${source.source_id}` as const }))
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

  const explorationArticles = (includeExplorationArticles ? input.exploration_articles ?? [] : [])
    .filter((article) => hasId(article.source_observation_id))
    .map((article) => ({
      ...article,
      evidence_id: `article:${article.source_observation_id}` as const,
      // The separate review evidence channel can never claim verified status.
      verified: false as const,
    }))
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

  const scoreEvidence = Object.fromEntries(
    Object.entries(input.candidate.score_inputs)
      .filter(([, value]) => value !== null && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [`score:${key}`, value]),
  );

  const evidenceIds = [
    ...posts.map((post) => post.evidence_id),
    ...sources.map((source) => source.evidence_id),
    ...explorationArticles.map((article) => article.evidence_id),
    ...Object.keys(scoreEvidence),
  ].sort((left, right) => left.localeCompare(right));

  return {
    schema_version: "1.0",
    candidate: {
      ...input.candidate,
      score_inputs: stableRecord(input.candidate.score_inputs),
    },
    story: input.story,
    posts,
    sources,
    ...(includeExplorationArticles ? { exploration_articles: explorationArticles } : {}),
    score_evidence: scoreEvidence,
    evidence_ids: evidenceIds,
  };
}
