export type EditorialSourceRole =
  | "FACT_PRIMARY"
  | "FACT_INDEPENDENT"
  | "DISCOVERY_COMPETITOR"
  | "DISCOVERY_COMMUNITY"
  | "DISCOVERY_VIDEO"
  | "MATCH_CONTEXT"
  | "OWN_PERFORMANCE";

export type InformationSourceEntityType =
  | "CLUB"
  | "REPORTER"
  | "MEDIA_OUTLET"
  | "GOVERNING_BODY"
  | "OTHER";

export interface SourceFeed {
  readonly canonicalName: string;
  readonly editorialRole: EditorialSourceRole;
  readonly entityType: InformationSourceEntityType;
  readonly url: string;
  readonly format?: "RSS" | "ATOM" | "HTML";
  readonly includeTerms?: readonly string[];
}

export interface SourceObservationInput {
  readonly sourceCanonicalName: string;
  readonly editorialRole: EditorialSourceRole;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly publishedAt: string | null;
  readonly observedAt: string;
  readonly discoverySignal: number;
  readonly contentFingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface SourceDiscoveryRepository {
  ensureSource(feed: SourceFeed): Promise<string>;
  saveObservation(observation: SourceObservationInput & { readonly informationSourceId: string }): Promise<boolean>;
}

export interface SourceDiscoveryRunInput {
  readonly asOf?: Date;
  readonly limit?: number;
}

export type SourceDiscoveryStatus = "NOOP" | "COMPLETED";

export interface SourceDiscoverySummary {
  readonly status: SourceDiscoveryStatus;
  readonly observed: number;
  readonly duplicates: number;
  readonly failedFeeds: number;
  readonly feedCount: number;
}

export interface ParsedFeedObservation {
  readonly sourceCanonicalName: string;
  readonly editorialRole: EditorialSourceRole;
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly publishedAt: string | null;
  readonly discoverySignal: number;
  readonly contentFingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}
