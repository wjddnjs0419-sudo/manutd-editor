import type { DiscoveryObservation } from "../trend-discovery/types.ts";

export interface PromotionObservation extends DiscoveryObservation {
  readonly id: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly publisherCanonicalUrl: string | null;
  readonly googleNewsOriginalUrl: string | null;
  readonly articleFetchStatus: string;
  readonly articleExtractionStatus: string;
  storyClusterId: string | null;
}

export interface PromotionStory {
  readonly id: string;
  readonly canonicalTitle: string;
  readonly summary: string | null;
  readonly topic: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly promotionKey: string | null;
  readonly signature: Readonly<Record<string, unknown>>;
}

export interface PromotionStoryInput {
  readonly canonicalTitle: string;
  readonly summary: string | null;
  readonly topic: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly promotionKey: string;
  readonly signature: Readonly<Record<string, unknown>>;
}

export interface DiscoveryPromotionRepository {
  listFreshUnassigned(asOf: Date, limit: number, promotionJobId?: string): Promise<readonly PromotionObservation[]>;
  listStories(asOf: Date): Promise<readonly PromotionStory[]>;
  upsertStory(input: PromotionStoryInput): Promise<{ id: string; created: boolean }>;
  assignObservation(observationId: string, storyClusterId: string, sourceObservationId: string, promotionJobId?: string): Promise<void>;
  ensureSourceObservation(observation: PromotionObservation): Promise<string>;
  ensureReviewedPublisherObservation(observation: PromotionObservation): Promise<string | null>;
  ensurePublisherReportClaims(input: { observation: PromotionObservation; storyClusterId: string; publisherSourceObservationId: string }): Promise<void>;
  ensureDiscoveryClaim(input: { observationId: string; storyClusterId: string; sourceObservationId: string; status: "DISCOVERY_ONLY" }): Promise<void>;
}

export interface PromotionSummary {
  readonly status: "COMPLETED";
  readonly observationsProcessed: number;
  readonly storiesCreated: number;
  readonly storiesUpdated: number;
  readonly claimsCreated: number;
  readonly editorialCandidatesEnsured: number;
  readonly affectedStoryIds: readonly string[];
}
