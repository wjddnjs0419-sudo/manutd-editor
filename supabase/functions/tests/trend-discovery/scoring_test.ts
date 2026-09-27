import { assert, assertEquals, assertGreater, assertLess } from "jsr:@std/assert@1.0.8";
import { calculateTrendScore, deriveOpportunityLabels, deriveTrendState, TREND_SCORING_CONFIG, type TrendSignalInput } from "../../trend-discovery/scoring.ts";
import { calculateManutdRelevanceScore, isTrendRelevant } from "../../trend-discovery/relevance.ts";

function signals(overrides: Partial<TrendSignalInput> = {}): TrendSignalInput {
  return {
    asOf: "2026-09-27T12:00:00.000Z",
    mentionsLast1h: 12,
    mentionsLast3h: 20,
    mentionsPrevious3h: 4,
    mentionsLast12h: 30,
    sourceCategories: ["NEWS", "COMMUNITY", "COMPETITOR"],
    platforms: ["WEB", "REDDIT", "INSTAGRAM"],
    normalizedEngagementScore: 72,
    engagementAvailable: true,
    freshestPublishedAt: "2026-09-27T11:00:00.000Z",
    novelty: { competitorAccountCount: 2, similarPostCount: 3, alreadyPublished: false },
    manutdRelevanceScore: 90,
    groundingStatus: "VERIFIED",
    editorialScore: 78,
    ...overrides,
  };
}

Deno.test("trend score uses versioned weights and remains separate from editorial score", () => {
  const result = calculateTrendScore(signals());
  assertEquals(TREND_SCORING_CONFIG.version, "m8.5-v1");
  assertEquals(result.editorialScore, 78);
  assert(result.trendScore >= 0 && result.trendScore <= 100);
  assertEquals(result.components.velocity * TREND_SCORING_CONFIG.weights.velocity + result.components.crossSource * TREND_SCORING_CONFIG.weights.crossSource + result.components.engagement * TREND_SCORING_CONFIG.weights.engagement + result.components.freshness * TREND_SCORING_CONFIG.weights.freshness + result.components.novelty * TREND_SCORING_CONFIG.weights.novelty + result.components.manutdRelevance * TREND_SCORING_CONFIG.weights.manutdRelevance, result.trendScore);
});

Deno.test("velocity rewards acceleration and falls when recent mentions decline", () => {
  const rising = calculateTrendScore(signals({ mentionsLast1h: 15, mentionsLast3h: 25, mentionsPrevious3h: 2 }));
  const cooling = calculateTrendScore(signals({ mentionsLast1h: 1, mentionsLast3h: 3, mentionsPrevious3h: 18 }));
  assertGreater(rising.components.velocity, cooling.components.velocity);
  assertGreater(rising.trendScore, cooling.trendScore);
});

Deno.test("cross-source score uses category/platform diversity, not repost count", () => {
  const diverse = calculateTrendScore(signals({ sourceCategories: ["NEWS", "COMMUNITY", "COMPETITOR"], platforms: ["WEB", "REDDIT", "INSTAGRAM"] }));
  const reposts = calculateTrendScore(signals({ mentionsLast12h: 100, sourceCategories: ["COMPETITOR"], platforms: ["INSTAGRAM"] }));
  assertGreater(diverse.components.crossSource, reposts.components.crossSource);
});

Deno.test("engagement unavailable is explicit and neutral", () => {
  const result = calculateTrendScore(signals({ normalizedEngagementScore: null, engagementAvailable: false }));
  assertEquals(result.engagementAvailable, false);
  assertEquals(result.components.engagement, 50);
});

Deno.test("novelty falls after competitor saturation", () => {
  const fresh = calculateTrendScore(signals({ novelty: { competitorAccountCount: 0, similarPostCount: 0, alreadyPublished: false } }));
  const saturated = calculateTrendScore(signals({ novelty: { competitorAccountCount: 10, similarPostCount: 20, alreadyPublished: true } }));
  assertGreater(fresh.components.novelty, saturated.components.novelty);
  assertLess(saturated.trendScore, fresh.trendScore);
});

Deno.test("deterministically derives every trend state", () => {
  assertEquals(deriveTrendState({ trendScore: 90, velocityScore: 90, crossSourceScore: 60, freshnessScore: 95, noveltyScore: 80, acceleration: 3 }), "BREAKING");
  assertEquals(deriveTrendState({ trendScore: 70, velocityScore: 70, crossSourceScore: 50, freshnessScore: 70, noveltyScore: 70, acceleration: 1.4 }), "RISING");
  assertEquals(deriveTrendState({ trendScore: 85, velocityScore: 45, crossSourceScore: 70, freshnessScore: 80, noveltyScore: 70, acceleration: 1 }), "HOT");
  assertEquals(deriveTrendState({ trendScore: 60, velocityScore: 50, crossSourceScore: 45, freshnessScore: 60, noveltyScore: 70, acceleration: 1 }), "STABLE");
  assertEquals(deriveTrendState({ trendScore: 48, velocityScore: 30, crossSourceScore: 40, freshnessScore: 60, noveltyScore: 70, acceleration: 0.5 }), "COOLING");
  assertEquals(deriveTrendState({ trendScore: 80, velocityScore: 55, crossSourceScore: 80, freshnessScore: 75, noveltyScore: 25, acceleration: 1 }), "SATURATED");
});

Deno.test("opportunity labels remain bounded and data-derived", () => {
  const labels = deriveOpportunityLabels({ ...calculateTrendScore(signals()).components, trendScore: 88, state: "RISING", groundingStatus: "VERIFIED", competitorAccountCount: 1 });
  assert(labels.includes("🔥 빠르게 뜨는 중"));
  assert(labels.includes("✅ 팩트 확인됨"));
  assert(labels.includes("🆕 아직 덜 다뤄짐"));
});

Deno.test("relevance rejects secondary United mentions and scores focused stories", () => {
  assertEquals(isTrendRelevant({ title: "Liverpool title race, with Manchester United mentioned later", excerpt: "Liverpool Liverpool news and a brief United mention." }), false);
  assertEquals(isTrendRelevant({ title: "Manchester United injury update", excerpt: "Luke Shaw update at Old Trafford" }), true);
  assertEquals(calculateManutdRelevanceScore({ title: "Manchester United injury update", excerpt: "Old Trafford" }), 100);
});
