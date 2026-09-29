import type { EditorialSourceRole } from "../source-discovery/types.ts";

export type GroundingStatus = "VERIFIED" | "DISCOVERY_ONLY" | "INSUFFICIENT" | "CONTRADICTED";
export type GroundingRelation = "SUPPORTS" | "CONTRADICTS";

export interface GroundingClaim {
  readonly storyClusterId: string;
  readonly rawPostId: string | null;
  readonly discoveryObservationId?: string | null;
  readonly claimFingerprint: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly claimText: string;
  readonly origin: "caption" | "image" | "carousel_slide" | "thumbnail" | "discovery_observation";
  readonly extractionConfidence: number | null;
}

export interface GroundingObservation {
  readonly id: string;
  readonly editorialRole: EditorialSourceRole;
  readonly canonicalName: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly relation: GroundingRelation;
}

export interface GroundingEvidence {
  readonly sourceObservationId: string;
  readonly editorialRole: EditorialSourceRole;
  readonly relation: GroundingRelation;
  readonly evidenceText: string;
  readonly evidenceConfidence: number;
  readonly isGrounding: boolean;
}

export interface GroundedClaim extends GroundingClaim {
  readonly status: GroundingStatus;
  readonly confidence: number | null;
  readonly decisionReason: string;
  readonly evidence: readonly GroundingEvidence[];
}

export interface GroundingRepository {
  listClaims(options?: GroundingPageOptions | Date): Promise<GroundingClaimPage | readonly GroundingClaim[]>;
  listObservations(asOf?: Date): Promise<readonly GroundingObservation[]>;
  upsertClaim(claim: GroundedClaim, version: string): Promise<string>;
  upsertEvidence(claimId: string, evidence: GroundingEvidence): Promise<void>;
}

export interface GroundingRunInput {
  readonly asOf?: Date;
  readonly storyClusterIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly requestId?: string;
  readonly log?: (entry: Record<string, unknown>) => void;
}

export interface GroundingPageOptions {
  readonly asOf?: Date;
  readonly storyClusterIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string | null;
}

export interface GroundingClaimPage {
  readonly claims: readonly GroundingClaim[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

export interface GroundingSummary {
  readonly status: "COMPLETED" | "PARTIAL";
  readonly claimsProcessed: number;
  readonly verified: number;
  readonly discoveryOnly: number;
  readonly contradicted: number;
  readonly insufficient: number;
  readonly hasMore?: boolean;
  readonly nextCursor?: string | null;
}
