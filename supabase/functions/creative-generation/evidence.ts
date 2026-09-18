import type {
  CandidateEvidenceInput,
  EvidenceSnapshot,
  JsonValue,
} from "./types.ts";

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

export function buildEvidenceSnapshot(input: CandidateEvidenceInput): EvidenceSnapshot {
  const posts = input.posts
    .filter((post) => hasId(post.raw_post_id))
    .map((post) => ({ ...post, evidence_id: `post:${post.raw_post_id}` as const }))
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));

  const sources = input.sources
    .filter((source) => hasId(source.source_id))
    .map((source) => ({ ...source, evidence_id: `source:${source.source_id}` as const }))
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
    score_evidence: scoreEvidence,
    evidence_ids: evidenceIds,
  };
}
