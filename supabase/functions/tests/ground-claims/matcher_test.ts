import assert from "node:assert/strict";
import { classifyClaimEvidence } from "../../ground-claims/matcher.ts";
import * as matcher from "../../ground-claims/matcher.ts";
import type { GroundingClaim, GroundingObservation } from "../../ground-claims/types.ts";

const claim: GroundingClaim = {
  storyClusterId: "cluster-1",
  rawPostId: "post-1",
  claimFingerprint: "claim-1",
  subject: "Jadon Sancho",
  predicate: "training_at",
  object: "Flixton FC facilities",
  claimText: "Jadon Sancho is training at Flixton FC facilities",
  origin: "image",
  claimScope: "EVENT",
  claimModality: "CONFIRMED",
  extractionConfidence: 0.94,
};

function observation(editorialRole: GroundingObservation["editorialRole"], relation: GroundingObservation["relation"] = "SUPPORTS"): GroundingObservation {
  return {
    id: `${editorialRole}-${relation}`,
    editorialRole,
    canonicalName: editorialRole,
    title: "Jadon Sancho training at Flixton FC facilities",
    excerpt: "Jadon Sancho is training at Flixton FC facilities",
    relation,
  };
}

Deno.test("fact sources verify a matching claim", () => {
  const result = classifyClaimEvidence(claim, [observation("FACT_PRIMARY")]);
  assert.equal(result.status, "VERIFIED");
  assert.equal(result.evidence[0]?.isGrounding, true);
  assert.ok(result.confidence !== null);
  assert(result.confidence >= 0.8);
});

Deno.test("discovery sources remain discovery-only", () => {
  const result = classifyClaimEvidence(claim, [
    observation("DISCOVERY_COMPETITOR"),
    observation("DISCOVERY_COMMUNITY"),
    observation("DISCOVERY_VIDEO"),
  ]);
  assert.equal(result.status, "DISCOVERY_ONLY");
  assert(result.evidence.every((item) => !item.isGrounding));
  assert.ok(result.confidence !== null);
  assert(result.confidence < 0.8);
});

Deno.test("contradictory fact evidence wins over supporting discovery signals", () => {
  const result = classifyClaimEvidence(claim, [
    observation("DISCOVERY_COMMUNITY"),
    observation("FACT_INDEPENDENT", "CONTRADICTS"),
  ]);
  assert.equal(result.status, "CONTRADICTED");
  assert.equal(result.evidence.some((item) => item.relation === "CONTRADICTS" && item.editorialRole === "FACT_INDEPENDENT" && !item.isGrounding), true);
});

Deno.test("match context and own performance are ignored", () => {
  const result = classifyClaimEvidence(claim, [observation("MATCH_CONTEXT"), observation("OWN_PERFORMANCE")]);
  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});

Deno.test("does not verify a Manchester City claim against a Manchester United article", () => {
  const cityClaim: GroundingClaim = {
    storyClusterId: "cluster-city-finance",
    rawPostId: "post-city-finance",
    claimFingerprint: "claim-city-finance",
    subject: "Pep Guardiola",
    predicate: "won Premier League titles and achieved a title streak with Manchester City",
    object: "6 titles and the first four consecutive titles",
    claimText: "펩은 PL 6회 우승과 최초의 4연패를 달성했다.",
    origin: "caption",
    claimScope: "EVENT",
    claimModality: "CONFIRMED",
    extractionConfidence: 0.9,
  };
  const unrelatedUnitedArticle: GroundingObservation = {
    id: "bbc-united-tactics",
    editorialRole: "FACT_INDEPENDENT",
    canonicalName: "BBC Sport",
    title: "The teething troubles with Man Utd's tactics under Olid",
    excerpt: "Manchester United are adjusting their build-up after a difficult start.",
    relation: "SUPPORTS",
  };

  const result = classifyClaimEvidence(cityClaim, [unrelatedUnitedArticle]);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});

Deno.test("does not verify a striker story using a different Manchester United transfer article", () => {
  const strikerClaim: GroundingClaim = {
    storyClusterId: "cluster-striker-rumor",
    rawPostId: null,
    claimFingerprint: "claim-striker-rumor",
    subject: "Manchester United",
    predicate: "reported",
    object: "Man Utd in talks with €30m striker as priority signing confirmed - LiveScore",
    claimText: "Man Utd in talks with €30m striker as priority signing confirmed - LiveScore",
    origin: "discovery_observation",
    claimScope: "EVENT",
    claimModality: "RUMOR",
    extractionConfidence: 0.9,
  };
  const unrelatedCostaArticle: GroundingObservation = {
    id: "bbc-costa-gossip",
    editorialRole: "FACT_INDEPENDENT",
    canonicalName: "BBC Sport",
    title: "Man Utd & Arsenal eye Porto's Costa - Tuesday's gossip",
    excerpt: "Arsenal and Manchester United eye Porto defender Alberto Costa, Manchester City will not let Erling Haaland leave on the cheap if they are relegated, Liverpool retain an interest in Real Madrid midfielder Aurelien Tchouameni, plus more.",
    relation: "SUPPORTS",
  };

  const result = classifyClaimEvidence(strikerClaim, [unrelatedCostaArticle]);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});

Deno.test("does not ground a generic player-interest claim from an unrelated sentence in a club article", () => {
  const vagueClaim: GroundingClaim = {
    ...claim,
    rawPostId: null,
    subject: "Manchester United",
    predicate: "interest",
    object: "player",
    claimText: "Manchester United interest in player",
    origin: "discovery_observation",
  };
  const crossSentenceArticle: GroundingObservation = {
    id: "bbc-costa-cross-sentence",
    editorialRole: "FACT_INDEPENDENT",
    canonicalName: "BBC Sport",
    title: "Man Utd & Arsenal eye Porto's Costa - Tuesday's gossip",
    excerpt: "Arsenal and Manchester United eye Porto defender Alberto Costa. Liverpool retain an interest in Real Madrid midfielder Aurelien Tchouameni, plus more.",
    relation: "SUPPORTS",
  };

  const result = classifyClaimEvidence(vagueClaim, [crossSentenceArticle]);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});

Deno.test("requires an entity anchor instead of generic shared football tokens", () => {
  const claimWithEntityCollision: GroundingClaim = {
    ...claim,
    subject: "Pep Guardiola",
    predicate: "Manchester City",
    object: "Pep Guardiola",
    claimText: "Pep Guardiola Manchester City",
  };
  const genericUnitedArticle: GroundingObservation = {
    id: "bbc-generic-united",
    editorialRole: "FACT_INDEPENDENT",
    canonicalName: "BBC Sport",
    title: "Manchester United",
    excerpt: "Manchester United and London City are preparing for the weekend.",
    relation: "SUPPORTS",
  };

  const result = classifyClaimEvidence(claimWithEntityCollision, [genericUnitedArticle]);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});

Deno.test("prepared matcher is equivalent across fact, discovery, contradiction, ignored, and unrelated fixtures", () => {
  const prepared = matcher as unknown as {
    prepareGroundingObservations?: (items: readonly GroundingObservation[]) => unknown;
    classifyPreparedClaimEvidence?: (claim: GroundingClaim, prepared: unknown) => ReturnType<typeof classifyClaimEvidence>;
  };
  assert.equal(typeof prepared.prepareGroundingObservations, "function");
  assert.equal(typeof prepared.classifyPreparedClaimEvidence, "function");
  const fixtures: readonly (readonly GroundingObservation[])[] = [
    [observation("FACT_PRIMARY")],
    [observation("DISCOVERY_COMMUNITY")],
    [observation("DISCOVERY_COMMUNITY"), observation("FACT_INDEPENDENT", "CONTRADICTS")],
    [observation("MATCH_CONTEXT"), observation("OWN_PERFORMANCE")],
    [{ ...observation("FACT_INDEPENDENT"), id: "unrelated", title: "Arsenal academy update", excerpt: "Arsenal academy trained in London" }],
  ];
  for (const observations of fixtures) {
    const expected = classifyClaimEvidence(claim, observations);
    const actual = prepared.classifyPreparedClaimEvidence!(claim, prepared.prepareGroundingObservations!(observations));
    assert.deepEqual(actual, expected, expected.status);
  }
});

Deno.test("publisher report grounds rumor attribution without grounding the transfer", () => {
  const reportClaim = {
    ...claim,
    rawPostId: null,
    subject: "Manchester United",
    predicate: "reported",
    object: "a move for Player A",
    claimText: "BBC Sport reports that Manchester United are considering a move for Player A.",
    origin: "publisher_article",
    claimScope: "PUBLISHER_REPORT",
    claimModality: "RUMOR",
    publisherSourceObservationId: "bbc-report-1",
  } as unknown as GroundingClaim & { claimScope: string; claimModality: string };
  const article: GroundingObservation = {
    id: "bbc-report-1", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport",
    title: "Manchester United transfer report", excerpt: "Manchester United are considering a move for Player A, according to BBC Sport.", relation: "SUPPORTS", publisherReportOnly: true,
  };

  const result = classifyClaimEvidence(reportClaim, [article]);

  assert.equal(result.status, "VERIFIED");
  assert.equal((result as unknown as { claimScope?: string }).claimScope, "PUBLISHER_REPORT");
  assert.equal((result as unknown as { claimModality?: string }).claimModality, "RUMOR");
  assert.equal(result.evidence[0]?.evidenceText, "Manchester United are considering a move for Player A, according to BBC Sport.");
});

Deno.test("rumor evidence cannot verify a confirmed event claim", () => {
  const eventClaim = {
    ...claim,
    rawPostId: null,
    subject: "Manchester United",
    predicate: "signed",
    object: "Bruno Fernandes",
    claimText: "Manchester United have completed a signing for Bruno Fernandes.",
    publisherSourceObservationId: "bbc-rumor-1",
    claimScope: "EVENT",
    claimModality: "CONFIRMED",
  } as unknown as GroundingClaim & { claimScope: string; claimModality: string };
  const rumorArticle: GroundingObservation = {
    id: "bbc-rumor-1", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport",
    title: "Manchester United transfer report", excerpt: "Manchester United are considering a move for Bruno Fernandes, but no deal has been completed.", relation: "SUPPORTS", publisherReportOnly: true,
  };

  const result = classifyClaimEvidence(eventClaim, [rumorArticle]);

  assert.notEqual(result.status, "VERIFIED");
  assert.equal(result.evidence.every((item) => !item.isGrounding), true);
});

Deno.test("publisher denial remains a denial", () => {
  const denialClaim = {
    ...claim,
    rawPostId: null,
    subject: "Manchester United",
    predicate: "denied",
    object: "a deal for Player A",
    claimText: "BBC Sport reports that Manchester United have not agreed a deal for Player A.",
    origin: "publisher_article",
    claimScope: "PUBLISHER_REPORT",
    claimModality: "DENIAL",
    publisherSourceObservationId: "bbc-denial-1",
  } as unknown as GroundingClaim & { claimScope: string; claimModality: string };
  const article: GroundingObservation = {
    id: "bbc-denial-1", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport",
    title: "Manchester United update", excerpt: "Manchester United have not agreed a deal for Player A.", relation: "SUPPORTS", publisherReportOnly: true,
  };

  const result = classifyClaimEvidence(denialClaim, [article]);

  assert.equal(result.status, "VERIFIED");
  assert.equal((result as unknown as { claimModality?: string }).claimModality, "DENIAL");
  assert.equal(result.evidence[0]?.evidenceText, "Manchester United have not agreed a deal for Player A.");
});

Deno.test("unrelated body sentence is insufficient even when title names the claim", () => {
  const reportClaim = {
    ...claim,
    rawPostId: null,
    subject: "Manchester United",
    predicate: "reported",
    object: "a move for Player A",
    claimText: "BBC Sport reports that Manchester United are considering a move for Player A.",
    origin: "publisher_article",
    claimScope: "PUBLISHER_REPORT",
    claimModality: "RUMOR",
  } as unknown as GroundingClaim & { claimScope: string; claimModality: string };
  const article: GroundingObservation = {
    id: "bbc-unrelated-body", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport",
    title: "Manchester United may sign Player A", excerpt: "Arsenal confirmed the training schedule for the weekend.", relation: "SUPPORTS",
  };

  const result = classifyClaimEvidence(reportClaim, [article]);

  assert.equal(result.status, "INSUFFICIENT");
  assert.equal(result.evidence.length, 0);
});
