export type DiscoveryMode = "GENERAL" | "BREAKING" | "TRANSFERS" | "MATCH" | "PLAYERS" | "COMMUNITY";

export type DiscoveryWindow = "BREAKING" | "HOT" | "CURRENT" | "BACKGROUND";

export type DiscoveryQueryFamily =
  | "LATEST"
  | "BREAKING"
  | "TRENDING"
  | "INJURY"
  | "TRANSFER"
  | "MANAGER"
  | "TACTICS"
  | "STATS"
  | "CONTROVERSY"
  | "FAN_REACTION"
  | "REDDIT"
  | "ACADEMY"
  | "INTERVIEW"
  | "PRESS_CONFERENCE"
  | "NEXT_MATCH"
  | "PLAYER"
  | "OPPONENT"
  | "COMPETITION"
  | "ENTITY";

export interface DiscoveryEntityContext {
  readonly manager?: string | null;
  readonly firstTeamPlayers?: readonly string[];
  readonly injuredPlayers?: readonly string[];
  readonly recentOpponents?: readonly string[];
  readonly nextOpponent?: string | null;
  readonly competitions?: readonly string[];
  readonly recentlyDetectedEntities?: readonly string[];
}

export interface DiscoveryQuery {
  readonly queryId: string;
  readonly text: string;
  readonly family: DiscoveryQueryFamily;
  readonly mode: DiscoveryMode;
  readonly window: DiscoveryWindow;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly priority: number;
}

export interface QueryExpansionInput {
  readonly asOf: Date | string;
  readonly mode?: DiscoveryMode;
  readonly entityContext?: DiscoveryEntityContext;
  readonly maxQueries?: number;
}

export interface EngagementMetrics {
  readonly likes?: number;
  readonly comments?: number;
  readonly views?: number;
  readonly upvotes?: number;
  readonly replies?: number;
}

export interface DiscoveryObservation {
  readonly providerId: string;
  readonly sourceCanonicalName: string;
  readonly sourceRole: "FACT_PRIMARY" | "FACT_INDEPENDENT" | "DISCOVERY_COMPETITOR" | "DISCOVERY_COMMUNITY" | "DISCOVERY_VIDEO";
  readonly externalId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly excerpt: string | null;
  readonly publishedAt: string | null;
  readonly observedAt: string;
  readonly platform: "WEB" | "RSS" | "ATOM" | "REDDIT" | "INSTAGRAM" | "YOUTUBE" | "OTHER";
  readonly engagement: EngagementMetrics;
  readonly engagementAvailable: boolean;
  readonly discoveryQueryId: string;
  readonly contentFingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface DiscoveryProvider {
  readonly providerId: string;
  readonly sourceRole: DiscoveryObservation["sourceRole"];
  readonly platform: DiscoveryObservation["platform"];
  discover(input: DiscoveryQuery): Promise<readonly DiscoveryObservation[]>;
}

export type TrendState = "BREAKING" | "RISING" | "HOT" | "STABLE" | "COOLING" | "SATURATED";

export interface TrendSnapshot {
  readonly storyClusterId: string | null;
  readonly clusterKey: string;
  readonly snapshotAt: string;
  readonly trendScore: number;
  readonly velocityScore: number;
  readonly crossSourceScore: number;
  readonly engagementScore: number;
  readonly freshnessScore: number;
  readonly noveltyScore: number;
  readonly manutdRelevanceScore: number;
  readonly state: TrendState;
  readonly opportunityLabels: readonly string[];
  readonly mentionCount: number;
  readonly sourceCount: number;
  readonly platformCount: number;
  readonly engagementAvailable: boolean;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
}

export interface ProviderRunStatus {
  readonly providerId: string;
  readonly status: "COMPLETED" | "FAILED" | "DISABLED";
  readonly observations: number;
  readonly errorCategory?: string;
}

export interface DiscoveryRunSummary {
  readonly runId: string;
  readonly status: "COMPLETED" | "PARTIAL" | "FAILED" | "NOOP";
  readonly mode: DiscoveryMode;
  readonly queryCount: number;
  readonly observationCount: number;
  readonly newObservationCount: number;
  readonly newStoryCount: number;
  readonly updatedStoryCount: number;
  readonly providerStatuses: readonly ProviderRunStatus[];
  readonly durationMs: number;
}
