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
