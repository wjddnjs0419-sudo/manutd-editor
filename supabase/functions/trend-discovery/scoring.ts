import type { DiscoveryObservation, TrendState } from "./types.ts";

export const TREND_SCORING_CONFIG = {
  version: "m8.5-v1",
  weights: {
    velocity: 0.30,
    crossSource: 0.20,
    engagement: 0.15,
    freshness: 0.15,
    novelty: 0.10,
    manutdRelevance: 0.10,
  },
} as const;

export interface NoveltyInput {
  readonly competitorAccountCount: number;
  readonly similarPostCount: number;
  readonly alreadyPublished: boolean;
  readonly minutesSinceFirstCompetitorCoverage?: number | null;
}

export interface TrendSignalInput {
  readonly asOf: Date | string;
  readonly mentionsLast1h: number;
  readonly mentionsLast3h: number;
  readonly mentionsPrevious3h: number;
  readonly mentionsLast12h: number;
  readonly sourceCategories: readonly string[];
  readonly platforms: readonly string[];
  readonly normalizedEngagementScore: number | null;
  readonly engagementAvailable: boolean;
  readonly freshestPublishedAt: string | null;
  readonly novelty: NoveltyInput;
  readonly manutdRelevanceScore: number;
  readonly groundingStatus: string;
  readonly editorialScore: number | null;
}

export interface TrendComponents {
  readonly velocity: number;
  readonly crossSource: number;
  readonly engagement: number;
  readonly freshness: number;
  readonly novelty: number;
  readonly manutdRelevance: number;
}

export interface TrendScoreResult {
  readonly trendScore: number;
  readonly editorialScore: number | null;
  readonly components: TrendComponents;
  readonly acceleration: number;
  readonly engagementAvailable: boolean;
}

export interface TrendStateInput {
  readonly trendScore: number;
  readonly velocityScore: number;
  readonly crossSourceScore: number;
  readonly freshnessScore: number;
  readonly noveltyScore: number;
  readonly acceleration: number;
}

export interface OpportunityInput extends TrendComponents {
  readonly trendScore: number;
  readonly state: TrendState;
  readonly groundingStatus: string;
  readonly competitorAccountCount: number;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function round(value: number): number {
  return Number(clamp(value).toFixed(3));
}

function date(value: Date | string): Date {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error("INVALID_TREND_TIMESTAMP");
  return result;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value !== ""))];
}

function velocity(input: TrendSignalInput): { score: number; acceleration: number } {
  const recentRate = Math.max(0, input.mentionsLast1h) * 0.6 + Math.max(0, input.mentionsLast3h) / 3 * 0.4;
  const previousRate = Math.max(0.25, Math.max(0, input.mentionsPrevious3h) / 3);
  const acceleration = recentRate / previousRate;
  const volume = clamp(Math.max(0, input.mentionsLast12h) / 30 * 100);
  return { score: round(50 + (acceleration - 1) * 25 + volume * 0.25), acceleration };
}

function crossSource(input: TrendSignalInput): number {
  const categoryScore = clamp(unique(input.sourceCategories).length / 4 * 100);
  const platformScore = clamp(unique(input.platforms).length / 4 * 100);
  return round(categoryScore * 0.6 + platformScore * 0.4);
}

function freshness(input: TrendSignalInput): number {
  if (!input.freshestPublishedAt) return 30;
  const ageHours = Math.max(0, date(input.asOf).getTime() - date(input.freshestPublishedAt).getTime()) / 3_600_000;
  if (ageHours <= 3) return 100;
  if (ageHours <= 12) return 85;
  if (ageHours <= 24) return 65;
  if (ageHours <= 72) return 35;
  return 10;
}

function novelty(input: NoveltyInput): number {
  const competitorPenalty = Math.max(0, input.competitorAccountCount) * 7;
  const similarPenalty = Math.max(0, input.similarPostCount) * 2;
  const agePenalty = input.minutesSinceFirstCompetitorCoverage === null || input.minutesSinceFirstCompetitorCoverage === undefined
    ? 0
    : Math.min(20, Math.max(0, input.minutesSinceFirstCompetitorCoverage) / 30);
  const score = clamp(100 - competitorPenalty - similarPenalty - agePenalty);
  return input.alreadyPublished ? Math.min(score, 20) : round(score);
}

export function calculateTrendScore(input: TrendSignalInput): TrendScoreResult {
  const velocityResult = velocity(input);
  const components: TrendComponents = {
    velocity: velocityResult.score,
    crossSource: crossSource(input),
    engagement: input.engagementAvailable && input.normalizedEngagementScore !== null ? round(input.normalizedEngagementScore) : 50,
    freshness: freshness(input),
    novelty: novelty(input.novelty),
    manutdRelevance: round(input.manutdRelevanceScore),
  };
  const weights = TREND_SCORING_CONFIG.weights;
  const trendScore = round(
    components.velocity * weights.velocity +
      components.crossSource * weights.crossSource +
      components.engagement * weights.engagement +
      components.freshness * weights.freshness +
      components.novelty * weights.novelty +
      components.manutdRelevance * weights.manutdRelevance,
  );
  return {
    trendScore,
    editorialScore: input.editorialScore,
    components,
    acceleration: velocityResult.acceleration,
    engagementAvailable: input.engagementAvailable && input.normalizedEngagementScore !== null,
  };
}

export function trendSignalsFromObservations(
  observations: readonly DiscoveryObservation[],
  asOf: Date | string,
  options: Omit<TrendSignalInput, "asOf" | "mentionsLast1h" | "mentionsLast3h" | "mentionsPrevious3h" | "mentionsLast12h" | "sourceCategories" | "platforms" | "freshestPublishedAt"> & {
    readonly mentionWindows?: Partial<Pick<TrendSignalInput, "mentionsLast1h" | "mentionsLast3h" | "mentionsPrevious3h" | "mentionsLast12h">>;
  },
): TrendSignalInput {
  const published = observations.map((item) => item.publishedAt).filter((value): value is string => value !== null).sort();
  return {
    ...options,
    asOf,
    mentionsLast1h: options.mentionWindows?.mentionsLast1h ?? observations.length,
    mentionsLast3h: options.mentionWindows?.mentionsLast3h ?? observations.length,
    mentionsPrevious3h: options.mentionWindows?.mentionsPrevious3h ?? 0,
    mentionsLast12h: options.mentionWindows?.mentionsLast12h ?? observations.length,
    sourceCategories: [...new Set(observations.map((item) => item.sourceRole))],
    platforms: [...new Set(observations.map((item) => item.platform))],
    freshestPublishedAt: published.at(-1) ?? null,
  };
}

export function deriveTrendState(input: TrendStateInput): TrendState {
  if (input.noveltyScore <= 35 && input.trendScore >= 70 && input.crossSourceScore >= 60) return "SATURATED";
  if (input.freshnessScore >= 85 && input.velocityScore >= 80 && input.acceleration >= 1.8 && input.trendScore >= 75) return "BREAKING";
  if (input.acceleration >= 1.15 && input.velocityScore >= 55 && input.trendScore >= 55) return "RISING";
  if (input.trendScore >= 75 && input.crossSourceScore >= 50) return "HOT";
  if (input.velocityScore <= 40 || input.acceleration < 0.75) return "COOLING";
  return "STABLE";
}

export function deriveOpportunityLabels(input: OpportunityInput): readonly string[] {
  const labels: string[] = [];
  if (input.velocity >= 70 && input.trendScore >= 70) labels.push("🔥 빠르게 뜨는 중");
  if (input.novelty >= 65 && input.competitorAccountCount < 5) labels.push("🆕 아직 덜 다뤄짐");
  if (input.groundingStatus === "VERIFIED") labels.push("✅ 팩트 확인됨");
  if (input.groundingStatus !== "VERIFIED") labels.push("⚠️ 아직 검증 부족");
  if (input.novelty <= 35 || input.competitorAccountCount >= 5 || input.state === "SATURATED") labels.push("♻️ 이미 많이 다뤄짐");
  return labels.slice(0, 4);
}
