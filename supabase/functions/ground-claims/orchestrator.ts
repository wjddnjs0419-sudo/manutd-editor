import { classifyPreparedClaimEvidence, prepareGroundingObservations } from "./matcher.ts";
import type { GroundingClaimPage, GroundingRepository, GroundingRunInput, GroundingSummary } from "./types.ts";

interface RunGroundingOptions extends GroundingRunInput {
  readonly repository: GroundingRepository;
  readonly version?: string;
}

export async function runClaimGrounding(options: RunGroundingOptions): Promise<GroundingSummary> {
  const version = options.version ?? "m8-b-v1";
  const limit = Number.isInteger(options.limit) && (options.limit ?? 0) > 0 ? Math.min(options.limit!, 100) : 25;
  const started = performance.now();
  const emit = (event: string, fields: Record<string, unknown> = {}) => options.log?.({ event, request_id: options.requestId ?? null, ...fields });
  let phase = "LOAD";
  emit("ground_claims_start", {
    as_of: options.asOf?.toISOString() ?? null,
    story_count: options.storyClusterIds?.length ?? 0,
    batch_limit: limit,
    cursor_present: Boolean(options.cursor),
  });
  try {
    const loadedAt = performance.now();
    const [loaded, observations] = await Promise.all([
      options.repository.listClaims({ asOf: options.asOf, storyClusterIds: options.storyClusterIds, limit, cursor: options.cursor }),
      options.storyClusterIds?.length === 0 ? Promise.resolve([]) : options.repository.listObservations(options.asOf),
    ]);
    const page: GroundingClaimPage = Array.isArray(loaded)
      ? { claims: loaded, hasMore: loaded.length > limit, nextCursor: null }
      : loaded as GroundingClaimPage;
    if (page.claims.length > limit && !page.hasMore) throw new Error("INVALID_GROUNDING_PAGE");
    const claims = page.claims.slice(0, limit);
    const hasMore = page.hasMore || page.claims.length > limit;
    const nextCursor = hasMore ? page.nextCursor ?? (claims.at(-1)?.rawPostId ? `a:${claims.at(-1)!.rawPostId}:${claims.at(-1)!.claimFingerprint}` : null) : null;
    if (hasMore && !nextCursor) throw new Error("INVALID_GROUNDING_PAGE_CURSOR");
    emit("ground_claims_loaded", { claims_loaded: claims.length, observations_loaded: observations.length, load_ms: performance.now() - loadedAt });

    phase = "MATCH";
    const matchingAt = performance.now();
    const prepared = prepareGroundingObservations(observations);
    const grounded = claims.map((claim) => classifyPreparedClaimEvidence(claim, prepared));
    emit("ground_claims_match_complete", {
      claims_processed: grounded.length,
      evidence_matches: grounded.reduce((total, claim) => total + claim.evidence.length, 0),
      verified: grounded.filter((claim) => claim.status === "VERIFIED").length,
      discovery_only: grounded.filter((claim) => claim.status === "DISCOVERY_ONLY").length,
      contradicted: grounded.filter((claim) => claim.status === "CONTRADICTED").length,
      insufficient: grounded.filter((claim) => claim.status === "INSUFFICIENT").length,
      match_ms: performance.now() - matchingAt,
    });

    phase = "WRITE";
    const writingAt = performance.now();
    let verified = 0;
    let discoveryOnly = 0;
    let contradicted = 0;
    let insufficient = 0;
    let claimWrites = 0;
    let evidenceWrites = 0;
    for (const claim of grounded) {
      const claimId = await options.repository.upsertClaim(claim, version);
      claimWrites += 1;
      if (claim.evidence.length > 0) {
        await options.repository.upsertEvidenceBatch(claimId, claim.evidence);
        evidenceWrites += claim.evidence.length;
      }
      if (claim.status === "VERIFIED") verified += 1;
      else if (claim.status === "DISCOVERY_ONLY") discoveryOnly += 1;
      else if (claim.status === "CONTRADICTED") contradicted += 1;
      else insufficient += 1;
    }
    emit("ground_claims_write_complete", { claim_writes: claimWrites, evidence_writes: evidenceWrites, write_ms: performance.now() - writingAt });
    const summary: GroundingSummary = { status: hasMore ? "PARTIAL" : "COMPLETED", claimsProcessed: grounded.length, verified, discoveryOnly, contradicted, insufficient, hasMore, nextCursor };
    emit("ground_claims_complete", { total_ms: performance.now() - started, status: summary.status, claims_processed: summary.claimsProcessed, has_more: hasMore });
    return summary;
  } catch (error) {
    emit("ground_claims_failed", { phase, error_code: "GROUND_CLAIMS_FAILED", elapsed_ms: performance.now() - started });
    throw error;
  }
}
