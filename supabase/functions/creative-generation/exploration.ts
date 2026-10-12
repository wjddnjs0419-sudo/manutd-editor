import { validPublisherUrl } from "./evidence.ts";
import { canonicalJson, sha256 } from "./fingerprint.ts";
import { classifyManchesterUnitedRelevance } from "../_shared/m8/manchester_united_relevance.ts";
import type { EvidenceSnapshot, ExplorationArticleEvidenceInput } from "./types.ts";
import type { ContentMode } from "./types.ts";

export interface ExplorationConfig {
  readonly enabled: boolean;
  /** Separate opt-in for the priority runner's automatic Exploration batch. */
  readonly autoEnabled: boolean;
  readonly maxDraftsPerDay: number;
  readonly maxArticleAgeHours: number;
  readonly minArticleTextChars: number;
  readonly maxArticlesPerStory: number;
  readonly minSlides: number;
  readonly maxSlides: number;
  readonly maxHashtags: number;
  readonly inputCostPerMillionUsd: number | null;
  readonly outputCostPerMillionUsd: number | null;
  /** Set only by an explicit one-story MANUAL review request. */
  readonly allowHistoricalReview?: boolean;
}

export interface ExplorationArticleAssessment {
  readonly eligible: boolean;
  readonly reason: string | null;
}

export interface ExplorationSnapshotAssessment {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly articles: readonly ExplorationArticleEvidenceInput[];
}

export const DEFAULT_EXPLORATION_CONFIG: ExplorationConfig = {
  enabled: false,
  autoEnabled: false,
  maxDraftsPerDay: 10,
  maxArticleAgeHours: 72,
  minArticleTextChars: 300,
  maxArticlesPerStory: 5,
  minSlides: 3,
  maxSlides: 5,
  maxHashtags: 5,
  inputCostPerMillionUsd: null,
  outputCostPerMillionUsd: null,
};

export interface ExplorationSlideBounds {
  readonly min: number;
  readonly max: number;
}

/** Content-slide bounds for Exploration DRAFTs; the fixed CTA is rendered separately. */
export function explorationSlideBounds(mode: ContentMode): ExplorationSlideBounds {
  switch (mode) {
    case "NEWS_UPDATE": return { min: 2, max: 4 };
    case "ANALYSIS_CONTEXT": return { min: 4, max: 6 };
    case "MATCH_CONTENT": return { min: 3, max: 5 };
  }
}

function readPositiveInteger(
  readEnv: (name: string) => string | undefined,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = readEnv(name);
  if (!value || !/^\d+$/u.test(value)) return fallback;
  return Math.min(maximum, Number(value));
}

function readOptionalRate(readEnv: (name: string) => string | undefined, name: string): number | null {
  const value = readEnv(name);
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value)) return null;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : null;
}

export function readExplorationConfig(readEnv: (name: string) => string | undefined): ExplorationConfig {
  const enabledValue = (readEnv("EDITORIAL_EXPLORATION_MODE") ?? "").trim().toLocaleLowerCase("en-US");
  const autoEnabledValue = (readEnv("EDITORIAL_EXPLORATION_AUTO_MODE") ?? "").trim().toLocaleLowerCase("en-US");
  const enabled = enabledValue === "true" || enabledValue === "1" || enabledValue === "yes";
  return {
    enabled,
    autoEnabled: enabled && (autoEnabledValue === "true" || autoEnabledValue === "1" || autoEnabledValue === "yes"),
    maxDraftsPerDay: readPositiveInteger(readEnv, "EDITORIAL_EXPLORATION_MAX_DRAFTS_PER_DAY", DEFAULT_EXPLORATION_CONFIG.maxDraftsPerDay, 10),
    maxArticleAgeHours: readPositiveInteger(readEnv, "EDITORIAL_EXPLORATION_MAX_ARTICLE_AGE_HOURS", DEFAULT_EXPLORATION_CONFIG.maxArticleAgeHours, 72),
    minArticleTextChars: readPositiveInteger(readEnv, "EDITORIAL_EXPLORATION_MIN_ARTICLE_CHARS", DEFAULT_EXPLORATION_CONFIG.minArticleTextChars, 6_000),
    maxArticlesPerStory: readPositiveInteger(readEnv, "EDITORIAL_EXPLORATION_MAX_ARTICLES_PER_STORY", DEFAULT_EXPLORATION_CONFIG.maxArticlesPerStory, 10),
    minSlides: DEFAULT_EXPLORATION_CONFIG.minSlides,
    maxSlides: DEFAULT_EXPLORATION_CONFIG.maxSlides,
    maxHashtags: DEFAULT_EXPLORATION_CONFIG.maxHashtags,
    inputCostPerMillionUsd: readOptionalRate(readEnv, "EDITORIAL_EXPLORATION_INPUT_COST_PER_MILLION_USD"),
    outputCostPerMillionUsd: readOptionalRate(readEnv, "EDITORIAL_EXPLORATION_OUTPUT_COST_PER_MILLION_USD"),
  };
}

export function assessExplorationArticle(
  article: ExplorationArticleEvidenceInput,
  now: Date,
  config: ExplorationConfig = DEFAULT_EXPLORATION_CONFIG,
): ExplorationArticleAssessment {
  if (!article.publisher_name.trim()) return { eligible: false, reason: "PUBLISHER_NAME_MISSING" };
  if (!validPublisherUrl(article.canonical_url)) return { eligible: false, reason: "PUBLISHER_URL_INVALID" };
  if (article.extraction_status !== "EXTRACTED") return { eligible: false, reason: "ARTICLE_NOT_EXTRACTED" };
  if (!article.article_text || article.article_text.trim().length < config.minArticleTextChars) {
    return { eligible: false, reason: "ARTICLE_BODY_TOO_SHORT" };
  }
  if (!article.published_at) return { eligible: false, reason: "PUBLISHED_AT_MISSING" };
  const publishedAt = Date.parse(article.published_at);
  if (!Number.isFinite(publishedAt)) return { eligible: false, reason: "PUBLISHED_AT_INVALID" };
  const age = now.getTime() - publishedAt;
  if (age < 0) return { eligible: false, reason: "PUBLISHED_AT_IN_FUTURE" };
  if (age > config.maxArticleAgeHours * 60 * 60 * 1000 && config.allowHistoricalReview !== true) return { eligible: false, reason: "ARTICLE_TOO_OLD" };
  return { eligible: true, reason: null };
}

export function assessExplorationSnapshot(
  snapshot: EvidenceSnapshot,
  now: Date,
  config: ExplorationConfig = DEFAULT_EXPLORATION_CONFIG,
): ExplorationSnapshotAssessment {
  if (snapshot.story.status.toLocaleUpperCase("en-US") === "ARCHIVED") return { eligible: false, reason: "ARCHIVED_STORY", articles: [] };
  const articles = (snapshot.exploration_articles ?? [])
    .filter((article) => assessExplorationArticle(article, now, config).eligible)
    .slice(0, config.maxArticlesPerStory);
  if (articles.length === 0) {
    const reason = (snapshot.exploration_articles ?? []).map((article) => assessExplorationArticle(article, now, config).reason).find(Boolean) ?? "ARTICLE_EVIDENCE_MISSING";
    return { eligible: false, reason, articles: [] };
  }
  // Publisher RSS headlines can omit the club even when the extracted page
  // opens with a direct United match report. Keep that short lead beside the
  // story title so a later Manchester City comparison does not mask the
  // article's primary subject.
  const articleTexts = articles.map((article) => article.article_text ?? "");
  const articleLead = articleTexts.map((article) => article.trim().slice(0, 240)).join(" ");
  const relevance = classifyManchesterUnitedRelevance({
    canonicalTitle: snapshot.story.canonical_title,
    primaryText: articleLead,
    body: articleTexts.join(" "),
    entities: snapshot.candidate.score_inputs.entities,
    topic: snapshot.candidate.score_inputs.topic,
  });
  if (!relevance.autoEligible) return { eligible: false, reason: relevance.reasonCodes[0] ?? "STORY_NOT_RELEVANT", articles };
  return { eligible: true, reason: null, articles };
}

export async function explorationFingerprint(snapshot: EvidenceSnapshot, articles: readonly ExplorationArticleEvidenceInput[]): Promise<string> {
  // Keep retries and date-scoped candidates idempotent while allowing a new
  // publisher-page revision to produce a review draft when its extracted facts
  // have changed. Provider fingerprints can describe a feed item rather than
  // the fetched article body, so hash the exact text frozen into the evidence.
  const articleContentFingerprints = await Promise.all(articles.map((article) =>
    sha256((article.article_text ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim())
  ));
  return await sha256(canonicalJson({
    story_cluster_id: snapshot.story.id,
    article_content_fingerprints: [...new Set(articleContentFingerprints)].sort((left, right) => left.localeCompare(right)),
  }));
}
