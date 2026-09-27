import { classifyClaimEvidence } from "./matcher.ts";
import type { GroundingRepository, GroundingRunInput, GroundingSummary } from "./types.ts";

interface RunGroundingOptions extends GroundingRunInput {
  readonly repository: GroundingRepository;
  readonly version?: string;
}

export async function runClaimGrounding(options: RunGroundingOptions): Promise<GroundingSummary> {
  const version = options.version ?? "m8-b-v1";
  const [claims, observations] = await Promise.all([
    options.repository.listClaims(options.asOf),
    options.repository.listObservations(options.asOf),
  ]);
  let verified = 0;
  let discoveryOnly = 0;
  let contradicted = 0;
  let insufficient = 0;
  for (const claim of claims) {
    const grounded = classifyClaimEvidence(claim, observations);
    const claimId = await options.repository.upsertClaim(grounded, version);
    await Promise.all(grounded.evidence.map((evidence) => options.repository.upsertEvidence(claimId, evidence)));
    if (grounded.status === "VERIFIED") verified += 1;
    else if (grounded.status === "DISCOVERY_ONLY") discoveryOnly += 1;
    else if (grounded.status === "CONTRADICTED") contradicted += 1;
    else insufficient += 1;
  }
  return { status: "COMPLETED", claimsProcessed: claims.length, verified, discoveryOnly, contradicted, insufficient };
}
