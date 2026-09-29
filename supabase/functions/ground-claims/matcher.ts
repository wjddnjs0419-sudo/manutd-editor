import type { GroundedClaim, GroundingClaim, GroundingEvidence, GroundingObservation, GroundingStatus } from "./types.ts";

const FACT_ROLES = new Set(["FACT_PRIMARY", "FACT_INDEPENDENT"]);
const IGNORED_ROLES = new Set(["MATCH_CONTEXT", "OWN_PERFORMANCE"]);
const GENERIC_ANCHORS = new Set([
  "club",
  "coach",
  "manager",
  "player",
  "team",
  "the club",
  "the team",
  "구단",
  "선수",
  "팀",
]);
// Club names and reporting boilerplate identify the broad topic, not the
// particular event/person in a claim. They must not create a fact match on
// their own (e.g. any Manchester United article matching any other one).
const NON_DISTINCTIVE_TERMS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "before", "between", "but", "by",
  "club", "confirmed", "confirms", "could", "did", "do", "does", "for", "from", "had", "has",
  "have", "he", "her", "his", "in", "into", "is", "it", "its", "latest", "man", "manchester",
  "more", "news", "of", "on", "or", "player", "plus", "reported", "report", "says", "said",
  "signing", "team", "the", "their", "they", "this", "to", "transfer", "united", "utd", "was",
  "were", "what", "when", "will", "with", "would", "mufc", "football", "soccer",
  "맨유", "맨체스터", "유나이티드", "구단", "팀", "선수", "축구", "보도", "소식", "뉴스", "확인", "최신", "이적", "영입", "관심",
]);
const ANCHOR_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "manchester united": ["manchester united", "manchester utd", "man utd", "man united", "맨체스터 유나이티드", "맨유"],
  "manchester city": ["manchester city", "man city", "맨체스터 시티", "맨시티"],
  "premier league": ["premier league", "pl", "프리미어리그"],
};

function terms(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []);
}

function normalizedPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function strongAnchors(claim: GroundingClaim): readonly string[] {
  return [claim.subject, claim.object]
    .map(normalizedPhrase)
    .filter((value) => {
      if (!value || GENERIC_ANCHORS.has(value)) return false;
      const tokenCount = value.split(" ").length;
      return tokenCount >= 2 || value.length >= 4;
    });
}

export interface PreparedGroundingObservation {
  readonly observation: GroundingObservation;
  readonly haystack: string;
  readonly terms: ReadonlySet<string>;
}

export function prepareGroundingObservations(observations: readonly GroundingObservation[]): readonly PreparedGroundingObservation[] {
  return observations.map((observation) => ({
    observation,
    haystack: normalizedPhrase(`${observation.title} ${observation.excerpt ?? ""}`),
    terms: terms(`${observation.title} ${observation.excerpt ?? ""}`),
  }));
}

function hasEntityAnchor(anchors: readonly string[], haystack: string): boolean {
  return anchors.some((anchor) => {
    const aliases = ANCHOR_ALIASES[anchor] ?? [anchor];
    return aliases.some((alias) => ` ${haystack} `.includes(` ${normalizedPhrase(alias)} `));
  });
}

function overlap(claimTerms: ReadonlySet<string>, observationTerms: ReadonlySet<string>): number {
  const distinctiveClaimTerms = [...claimTerms].filter((term) => !NON_DISTINCTIVE_TERMS.has(term));
  if (distinctiveClaimTerms.length === 0 || observationTerms.size === 0) return 0;
  let matches = 0;
  for (const term of distinctiveClaimTerms) {
    if (!NON_DISTINCTIVE_TERMS.has(term) && observationTerms.has(term)) matches += 1;
  }
  return matches / distinctiveClaimTerms.length;
}

export function classifyClaimEvidence(
  claim: GroundingClaim,
  observations: readonly GroundingObservation[],
): GroundedClaim {
  return classifyPreparedClaimEvidence(claim, prepareGroundingObservations(observations));
}

export function classifyPreparedClaimEvidence(
  claim: GroundingClaim,
  observations: readonly PreparedGroundingObservation[],
): GroundedClaim {
  const evidence: GroundingEvidence[] = [];
  const anchors = strongAnchors(claim);
  const claimTerms = terms(`${claim.subject} ${claim.predicate} ${claim.object} ${claim.claimText}`);
  for (const prepared of observations) {
    const { observation } = prepared;
    if (IGNORED_ROLES.has(observation.editorialRole)) continue;
    if (!hasEntityAnchor(anchors, prepared.haystack)) continue;
    const score = overlap(claimTerms, prepared.terms);
    if (score < 0.25) continue;
    const fact = FACT_ROLES.has(observation.editorialRole);
    evidence.push({
      sourceObservationId: observation.id,
      editorialRole: observation.editorialRole,
      relation: observation.relation,
      evidenceText: `${observation.canonicalName}: ${observation.title}${observation.excerpt ? ` — ${observation.excerpt}` : ""}`.slice(0, 2_000),
      evidenceConfidence: Number((fact ? Math.min(1, score) : Math.min(0.79, score * 0.5)).toFixed(4)),
      isGrounding: fact && observation.relation === "SUPPORTS",
    });
  }
  const factContradiction = evidence.some((item) => FACT_ROLES.has(item.editorialRole) && item.relation === "CONTRADICTS");
  const factSupport = evidence.some((item) => item.isGrounding);
  const discoverySignal = evidence.some((item) => item.editorialRole.startsWith("DISCOVERY_"));
  let status: GroundingStatus = "INSUFFICIENT";
  let decisionReason = "NO_MATCHING_SOURCE_EVIDENCE";
  if (factContradiction) {
    status = "CONTRADICTED";
    decisionReason = "FACT_SOURCE_CONTRADICTION";
  } else if (factSupport) {
    status = "VERIFIED";
    decisionReason = "FACT_SOURCE_SUPPORT";
  } else if (discoverySignal) {
    status = "DISCOVERY_ONLY";
    decisionReason = "DISCOVERY_SIGNAL_WITHOUT_FACT_GROUNDING";
  }
  const groundingEvidence = evidence.filter((item) => item.isGrounding || FACT_ROLES.has(item.editorialRole));
  const confidence = groundingEvidence.length > 0
    ? Math.max(...groundingEvidence.map((item) => item.evidenceConfidence))
    : evidence.length > 0 ? Math.min(...evidence.map((item) => item.evidenceConfidence)) : null;
  return { ...claim, status, confidence, decisionReason, evidence };
}
