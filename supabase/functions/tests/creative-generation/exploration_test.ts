import { assertEquals } from "jsr:@std/assert@1.0.8";
import { buildEvidenceSnapshot } from "../../creative-generation/evidence.ts";
import type { CandidateEvidenceInput } from "../../creative-generation/types.ts";

Deno.test("Exploration config defaults off and keeps limits centrally configured", async () => {
  const exploration = await import("../../creative-generation/exploration.ts").catch(() => null);
  assertEquals(typeof exploration?.readExplorationConfig, "function");
  const defaults = exploration!.readExplorationConfig(() => undefined);
  assertEquals(defaults.enabled, false);
  assertEquals(defaults.maxDraftsPerDay, 10);
  assertEquals(defaults.maxArticleAgeHours, 72);
});

Deno.test("Exploration accepts only recent extracted publisher-page text", async () => {
  const exploration = await import("../../creative-generation/exploration.ts").catch(() => null);
  assertEquals(typeof exploration?.assessExplorationArticle, "function");
  const config = exploration!.readExplorationConfig((name: string) => name === "EDITORIAL_EXPLORATION_MODE" ? "true" : undefined);
  const valid = {
    source_observation_id: "observation-1",
    publisher_name: "The Athletic",
    canonical_url: "https://theathletic.com/123/manchester-united-report",
    published_at: "2026-10-12T09:30:00Z",
    extraction_status: "EXTRACTED",
    article_text: "Manchester United are considering the player. " + "The report describes the club's current interest and makes clear a move has not been agreed. ".repeat(5),
    content_fingerprint: "fingerprint-1",
  };
  assertEquals(exploration!.assessExplorationArticle(valid, new Date("2026-10-12T10:00:00Z"), config).eligible, true);
  assertEquals(exploration!.assessExplorationArticle({ ...valid, extraction_status: "FEED_SUMMARY" }, new Date("2026-10-12T10:00:00Z"), config).reason, "ARTICLE_NOT_EXTRACTED");
  assertEquals(exploration!.assessExplorationArticle({ ...valid, article_text: null }, new Date("2026-10-12T10:00:00Z"), config).reason, "ARTICLE_BODY_TOO_SHORT");
  assertEquals(exploration!.assessExplorationArticle({ ...valid, canonical_url: "https://news.google.com/rss/articles/abc" }, new Date("2026-10-12T10:00:00Z"), config).reason, "PUBLISHER_URL_INVALID");
  assertEquals(exploration!.assessExplorationArticle({ ...valid, published_at: "2026-10-09T09:59:59Z" }, new Date("2026-10-12T10:00:00Z"), config).reason, "ARTICLE_TOO_OLD");
  assertEquals(exploration!.assessExplorationArticle({ ...valid, published_at: "2026-09-01T09:30:00Z" }, new Date("2026-10-12T10:00:00Z"), { ...config, allowHistoricalReview: true }).eligible, true);
  assertEquals(exploration!.assessExplorationArticle({ ...valid, published_at: "2026-10-12T10:00:01Z" }, new Date("2026-10-12T10:00:00Z"), config).reason, "PUBLISHED_AT_IN_FUTURE");
});

Deno.test("Exploration config clamps daily and age limits and reads optional cost rates", async () => {
  const exploration = await import("../../creative-generation/exploration.ts");
  const config = exploration.readExplorationConfig((name) => ({
    EDITORIAL_EXPLORATION_MODE: "true",
    EDITORIAL_EXPLORATION_MAX_DRAFTS_PER_DAY: "99",
    EDITORIAL_EXPLORATION_MAX_ARTICLE_AGE_HOURS: "96",
    EDITORIAL_EXPLORATION_INPUT_COST_PER_MILLION_USD: "2.5",
    EDITORIAL_EXPLORATION_OUTPUT_COST_PER_MILLION_USD: "10",
  } as Record<string, string>)[name]);
  assertEquals(config.enabled, true);
  assertEquals(config.maxDraftsPerDay, 10);
  assertEquals(config.maxArticleAgeHours, 72);
  assertEquals(config.inputCostPerMillionUsd, 2.5);
  assertEquals(config.outputCostPerMillionUsd, 10);
});

Deno.test("Exploration rejects an article with only an incidental United mention", async () => {
  const { assessExplorationSnapshot, DEFAULT_EXPLORATION_CONFIG } = await import("../../creative-generation/exploration.ts");
  const base = {
    candidate: { id: "c", story_cluster_id: "story-1", ranking_date: "2026-10-12", rank: 1, priority_score: 50, data_confidence: 50, first_mover_flag: null, must_cover_flag: null, korea_coverage_status: "UNCERTAIN" as const, score_version: null, score_inputs: { entities: [], topic: "TRANSFER" } },
    story: { id: "story-1", canonical_title: "Player interview covers the season", status: "ACTIVE", first_seen_at: "2026-10-12T08:00:00Z", last_seen_at: "2026-10-12T09:00:00Z" },
    posts: [], sources: [],
    exploration_articles: [{ source_observation_id: "article-1", publisher_name: "BBC Sport", canonical_url: "https://www.bbc.com/sport/football/123", published_at: "2026-10-12T09:00:00Z", extraction_status: "EXTRACTED", article_text: "Liverpool discuss their season. Manchester United were mentioned once as a comparison. No club-specific report follows. " + "Liverpool have focused on their own squad and coaching staff. ".repeat(8), content_fingerprint: "fp", verified: false as const }],
  } as unknown as CandidateEvidenceInput;
  const result = assessExplorationSnapshot(buildEvidenceSnapshot(base, true), new Date("2026-10-12T10:00:00Z"), { ...DEFAULT_EXPLORATION_CONFIG, enabled: true });
  assertEquals(result.eligible, false);
  assertEquals(result.reason, "UNITED_SIGNAL_NOT_CENTRAL");
});
