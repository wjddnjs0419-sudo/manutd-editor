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

function hasEntityAnchor(claim: GroundingClaim, observation: GroundingObservation): boolean {
  const haystack = normalizedPhrase(`${observation.title} ${observation.excerpt ?? ""}`);
  return strongAnchors(claim).some((anchor) => {
    const aliases = ANCHOR_ALIASES[anchor] ?? [anchor];
    return aliases.some((alias) => ` ${haystack} `.includes(` ${normalizedPhrase(alias)} `));
  });
}

function overlap(claim: GroundingClaim, observation: GroundingObservation): number {
  const claimTerms = terms(`${claim.subject} ${claim.predicate} ${claim.object} ${claim.claimText}`);
  const observationTerms = terms(`${observation.title} ${observation.excerpt ?? ""}`);
  if (claimTerms.size === 0 || observationTerms.size === 0) return 0;
  let matches = 0;
  for (const term of claimTerms) if (observationTerms.has(term)) matches += 1;
  return matches / claimTerms.size;
}

export function classifyClaimEvidence(
  claim: GroundingClaim,
  observations: readonly GroundingObservation[],
): GroundedClaim {
  const evidence: GroundingEvidence[] = [];
  for (const observation of observations) {
    if (IGNORED_ROLES.has(observation.editorialRole)) continue;
    if (!hasEntityAnchor(claim, observation)) continue;
    const score = overlap(claim, observation);
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
