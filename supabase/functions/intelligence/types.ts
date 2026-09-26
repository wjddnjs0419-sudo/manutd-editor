export type EnvReader = (name: string) => string | undefined;

export type AliasMap = Readonly<Record<string, string>>;

export interface IntelligenceDictionary {
  readonly version: string;
  readonly entities: AliasMap;
  readonly events: AliasMap;
  readonly sources: AliasMap;
}

export interface IntelligenceConfig {
  readonly aiEnabled: boolean;
  readonly aiModel: string;
  readonly aiPromptVersion: string;
  readonly dictionaryVersion: string;
  readonly leaseSeconds: number;
  readonly heartbeatSeconds: number;
}

export interface StoryFeatures {
  readonly entities: string[];
  readonly events: string[];
  readonly sources: string[];
  readonly numbers: string[];
  readonly dates: string[];
  readonly normalizedCaption: string;
  readonly tokens: string[];
  readonly publishedAt: string;
  readonly dictionaryVersion: string;
  readonly multimodalContext?: string[];
}

export interface MultimodalEvidence {
  readonly slideIndex: number | null;
  readonly mediaAssetId: string | null;
}

export interface MultimodalClaim {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly text: string;
  readonly origin: string;
  readonly confidence: number;
  readonly evidence: readonly MultimodalEvidence[];
}

export interface MultimodalFeatureInput {
  readonly entities: readonly string[];
  readonly topics: readonly string[];
  readonly sourceNames: readonly string[];
  readonly importantNumbers: readonly string[];
  readonly visualSummary: string | null;
  readonly combinedSummary: string | null;
  readonly onImageText: readonly { readonly text: string; readonly slideIndex: number | null; readonly confidence: number | null }[];
  readonly claims: readonly MultimodalClaim[];
}

export interface RecentContentUnderstanding extends MultimodalFeatureInput {
  readonly status: "SUCCEEDED" | "PARTIAL";
  readonly analysisVersion: string;
}

export interface ClusterSignature {
  readonly entities: string[];
  readonly events: string[];
  readonly sources: string[];
  readonly numbers: string[];
  readonly firstPublishedAt: string;
  readonly lastPublishedAt: string;
  readonly representativePostIds: string[];
  readonly dictionaryVersion: string;
  readonly multimodalContext?: string[];
}

export interface StoryEvaluationInput {
  readonly rawPostId: string;
  readonly candidateClusterId: string;
  readonly rawPost: StoryFeatures;
  readonly aggregateSignature: ClusterSignature;
}

export interface IntelligenceRunSummary {
  readonly runId: string;
  readonly status: "completed" | "already_running";
  readonly clustersProcessed: number;
  readonly candidatesUpserted: number;
}

export const INTELLIGENCE_DICTIONARY_VERSION = "entity-v1";
