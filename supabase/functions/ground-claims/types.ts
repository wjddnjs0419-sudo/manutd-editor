import type { EditorialSourceRole } from "../source-discovery/types.ts";

export type GroundingStatus = "VERIFIED" | "DISCOVERY_ONLY" | "INSUFFICIENT" | "CONTRADICTED";
export type GroundingRelation = "SUPPORTS" | "CONTRADICTS";

export interface GroundingClaim {
  readonly storyClusterId: string;
  readonly rawPostId: string;
  readonly claimFingerprint: string;
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly claimText: string;
  readonly origin: "caption" | "image" | "carousel_slide" | "thumbnail";
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
  listClaims(asOf?: Date): Promise<readonly GroundingClaim[]>;
  listObservations(asOf?: Date): Promise<readonly GroundingObservation[]>;
  upsertClaim(claim: GroundedClaim, version: string): Promise<string>;
  upsertEvidence(claimId: string, evidence: GroundingEvidence): Promise<void>;
}

export interface GroundingRunInput {
  readonly asOf?: Date;
}

export interface GroundingSummary {
  readonly status: "COMPLETED";
  readonly claimsProcessed: number;
  readonly verified: number;
  readonly discoveryOnly: number;
  readonly contradicted: number;
  readonly insufficient: number;
}
