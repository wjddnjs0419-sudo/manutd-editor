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
