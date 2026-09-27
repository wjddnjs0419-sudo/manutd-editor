import assert from "node:assert/strict";
import { runClaimGrounding } from "../../ground-claims/orchestrator.ts";
import type { GroundingClaim, GroundingRepository } from "../../ground-claims/types.ts";

Deno.test("claim grounding persists one role-aware result per claim", async () => {
  const claims: GroundingClaim[] = [{ storyClusterId: "cluster-1", rawPostId: "post-1", claimFingerprint: "claim-1", subject: "United", predicate: "signed", object: "Player", claimText: "United signed Player", origin: "caption", extractionConfidence: 0.9 }];
  const saved: string[] = [];
  const repository: GroundingRepository = {
    listClaims: async () => claims,
    listObservations: async () => [{ id: "fact-1", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport", title: "United signed Player", excerpt: "United signed Player", relation: "SUPPORTS" }],
    upsertClaim: async (claim) => { saved.push(`${claim.claimFingerprint}:${claim.status}`); return "stored-claim"; },
    upsertEvidence: async () => undefined,
  };
  const result = await runClaimGrounding({ repository, version: "m8-b-v1" });
  assert.deepEqual(result, { status: "COMPLETED", claimsProcessed: 1, verified: 1, discoveryOnly: 0, contradicted: 0, insufficient: 0 });
  assert.deepEqual(saved, ["claim-1:VERIFIED"]);
});
