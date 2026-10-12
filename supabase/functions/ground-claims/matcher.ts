import type { GroundedClaim, GroundingClaim, GroundingClaimModality, GroundingEvidence, GroundingObservation, GroundingStatus } from "./types.ts";

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
  "a", "according", "an", "and", "are", "as", "at", "be", "been", "before", "between", "but", "by",
  "club", "coach", "confirmed", "confirms", "could", "defender", "defenders", "did", "do", "does", "eye", "eyes", "for", "forward", "forwards", "from", "gossip", "had", "has", "have", "he", "her", "his",
  "in", "interest", "interested", "interests", "into", "is", "it", "its", "latest", "link", "linked", "links", "look", "looking", "man", "manchester", "manager", "midfielder", "midfielders", "monitor", "monitoring", "more",
  "mufc", "news", "of", "on", "or", "player", "players", "plus", "report", "reported", "reporting", "reports", "rumor", "rumors", "rumour", "rumours", "said", "says", "sign", "signed", "signing", "signs", "soccer", "striker", "strikers",
  "team", "target", "targeted", "targeting", "targets", "talk", "talks", "the", "their", "they", "this", "to", "transfer", "united", "utd", "was", "were", "what", "when", "will", "with", "would", "want", "wants", "football", "goalkeeper", "goalkeepers", "winger", "wingers",
  "맨유", "맨체스터", "유나이티드", "구단", "팀", "선수", "공격수", "수비수", "미드필더", "골키퍼", "윙어", "축구", "보도", "소식", "뉴스", "확인", "최신", "이적", "영입", "관심",
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

function distinctiveTerms(value: string | Iterable<string>): string[] {
  const tokens = typeof value === "string" ? terms(value) : value;
  return [...tokens].filter((term) => !NON_DISTINCTIVE_TERMS.has(term));
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

export function articleEvidenceSentences(value: string): readonly string[] {
  return value.split(/(?<=[.!?])\s+|\n+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 0);
}

export function inferClaimModality(value: string): GroundingClaimModality {
  const text = normalizedPhrase(value);
  if (/\b(?:deny|denies|denied|denial|not agreed|no agreement|no deal|has not agreed|have not agreed|hasn't agreed|haven't agreed|did not agree|do not agree|is not true|are not true|false claim)\b/u.test(text)) return "DENIAL";
  if (/\b(?:opinion|editorial|believe|believes|think|thinks|in my view|in our view|arguably)\b/u.test(text)) return "OPINION";
  if (/\b(?:predict|predicts|predicted|prediction|forecast|forecasts|expected to|expect to|likely to|set to)\b/u.test(text)) return "PREDICTION";
  if (/\b(?:rumou?r|speculation|speculative|reportedly|could|may|might|considering|interested|interest in|linked with|linked to|targeting|target|eyeing|monitoring|talks with|negotiating)\b/u.test(text)) return "RUMOR";
  return text ? "CONFIRMED" : "UNKNOWN";
}

interface PreparedSentence {
  readonly text: string;
  readonly haystack: string;
  readonly terms: ReadonlySet<string>;
  readonly modality: GroundingClaimModality;
}

export interface PreparedGroundingObservation {
  readonly observation: GroundingObservation;
  readonly sentences: readonly PreparedSentence[];
}

export function prepareGroundingObservations(observations: readonly GroundingObservation[]): readonly PreparedGroundingObservation[] {
  return observations.map((observation) => ({
    observation,
    // A headline can help retrieval but is never the exact evidence sentence.
    sentences: articleEvidenceSentences(observation.excerpt ?? "").map((text) => ({
      text,
      haystack: normalizedPhrase(text),
      terms: terms(text),
      modality: inferClaimModality(text),
    })),
  }));
}

function hasEntityAnchor(anchors: readonly string[], haystack: string): boolean {
  return anchors.some((anchor) => {
    const aliases = ANCHOR_ALIASES[anchor] ?? [anchor];
    return aliases.some((alias) => ` ${haystack} `.includes(` ${normalizedPhrase(alias)} `));
  });
}

function overlap(claimTerms: ReadonlySet<string>, observationTerms: ReadonlySet<string>): number {
  const distinctiveClaimTerms = distinctiveTerms(claimTerms);
  if (distinctiveClaimTerms.length === 0 || observationTerms.size === 0) return 0;
  let matches = 0;
  for (const term of distinctiveClaimTerms) if (observationTerms.has(term)) matches += 1;
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
  const objectTerms = distinctiveTerms(claim.object);
  const claimScope = claim.claimScope ?? "EVENT";
  const claimModality = claim.claimModality ?? "UNKNOWN";
  for (const prepared of observations) {
    const { observation } = prepared;
    if (IGNORED_ROLES.has(observation.editorialRole)) continue;
    if (claimScope === "PUBLISHER_REPORT" && (observation.id !== claim.publisherSourceObservationId || observation.publisherReportOnly !== true)) continue;
    let best: { sentence: PreparedSentence; score: number } | null = null;
    for (const sentence of prepared.sentences) {
      if (objectTerms.length === 0 || !objectTerms.some((term) => sentence.terms.has(term))) continue;
      if (!hasEntityAnchor(anchors, sentence.haystack)) continue;
      const score = overlap(claimTerms, sentence.terms);
      if (score < 0.25) continue;
      if (!best || score > best.score) best = { sentence, score };
    }
    if (!best) continue;
    const fact = FACT_ROLES.has(observation.editorialRole);
    const modalityMatches = claimModality !== "UNKNOWN" && best.sentence.modality === claimModality;
    const semanticsGroundable = claimScope === "PUBLISHER_REPORT"
      ? modalityMatches
      : claimModality === "CONFIRMED" && best.sentence.modality === "CONFIRMED";
    evidence.push({
      sourceObservationId: observation.id,
      editorialRole: observation.editorialRole,
      relation: observation.relation,
      evidenceText: best.sentence.text,
      evidenceConfidence: Number((fact && semanticsGroundable ? Math.min(1, best.score) : Math.min(0.79, best.score * 0.5)).toFixed(4)),
      isGrounding: fact && observation.relation === "SUPPORTS" && semanticsGroundable,
    });
  }
  const factContradiction = evidence.some((item) => FACT_ROLES.has(item.editorialRole) && item.relation === "CONTRADICTS");
  const factSupport = evidence.some((item) => item.isGrounding);
  const discoverySignal = evidence.some((item) => item.editorialRole.startsWith("DISCOVERY_"));
  const factEvidenceWithoutSemanticSupport = evidence.some((item) => FACT_ROLES.has(item.editorialRole) && !item.isGrounding && item.relation === "SUPPORTS");
  let status: GroundingStatus = "INSUFFICIENT";
  let decisionReason = "NO_MATCHING_SOURCE_EVIDENCE";
  if (factContradiction) {
    status = "CONTRADICTED";
    decisionReason = "FACT_SOURCE_CONTRADICTION";
  } else if (factSupport) {
    status = "VERIFIED";
    decisionReason = claimScope === "PUBLISHER_REPORT" ? "VERIFIED_PUBLISHER_REPORT" : "FACT_SOURCE_SUPPORT";
  } else if (discoverySignal) {
    status = "DISCOVERY_ONLY";
    decisionReason = "DISCOVERY_SIGNAL_WITHOUT_FACT_GROUNDING";
  } else if (factEvidenceWithoutSemanticSupport) {
    decisionReason = "FACT_EVIDENCE_MODALITY_MISMATCH";
  }
  const groundingEvidence = evidence.filter((item) => item.isGrounding);
  const confidence = groundingEvidence.length > 0
    ? Math.max(...groundingEvidence.map((item) => item.evidenceConfidence))
    : discoverySignal ? Math.min(...evidence.filter((item) => item.editorialRole.startsWith("DISCOVERY_")).map((item) => item.evidenceConfidence)) : null;
  return { ...claim, claimScope, claimModality, status, confidence, decisionReason, evidence };
}
