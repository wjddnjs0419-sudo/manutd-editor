import assert from "node:assert/strict";
import { classifyClaimEvidence } from "../../ground-claims/matcher.ts";
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
