import assert from "node:assert/strict";

import {
  candidatePrefilter,
  decideDeterministicMatch,
  deterministicSimilarity,
  mergeSignature,
  type RepresentativeMember,
  selectRepresentativeMembers,
  type SimilarityResult,
} from "../../intelligence/clustering.ts";
import type {
  ClusterSignature,
  StoryFeatures,
} from "../../intelligence/types.ts";

const post = (
  overrides: Partial<StoryFeatures> = {},
): StoryFeatures => ({
  entities: ["manchester_united", "bruno_fernandes"],
  events: ["injury"],
  sources: ["fabrizio_romano"],
  numbers: ["8"],
  dates: [],
  normalizedCaption: "bruno injury update manchester united",
  tokens: ["bruno", "injury", "update", "manchester", "united"],
  publishedAt: "2026-09-18T10:00:00.000Z",
  dictionaryVersion: "entity-v1",
  ...overrides,
});

type TestSignature = ClusterSignature & { normalizedCaptions?: string[] };

const signature = (
  overrides: Partial<TestSignature> = {},
): TestSignature => ({
  entities: ["manchester_united", "bruno_fernandes"],
  events: ["injury"],
  sources: ["fabrizio_romano"],
  numbers: ["8"],
  firstPublishedAt: "2026-09-18T09:00:00.000Z",
  lastPublishedAt: "2026-09-18T10:00:00.000Z",
  representativePostIds: ["post-existing"],
  dictionaryVersion: "entity-v1",
  normalizedCaptions: ["bruno injury update manchester united"],
  ...overrides,
});

const decisionResult = (
  overrides: Partial<SimilarityResult> = {},
): SimilarityResult => ({
  score: 0.95,
  primaryEntityOverlap: true,
  contradiction: false,
  signals: {
    entityOverlap: 1,
    eventOverlap: 1,
    sourceOverlap: 1,
    numberOverlap: 1,
    timeProximity: 1,
    captionSimilarity: 1,
  },
  reasonCode: "UNSET",
  ...overrides,
});

Deno.test("same English story produces high similarity", () => {
  const result = deterministicSimilarity(post(), signature());

  assert.ok(result.score >= 0.85);
  assert.equal(decideDeterministicMatch(result).decision, "AUTO_MERGE");
});

Deno.test("different English story produces low similarity", () => {
  const result = deterministicSimilarity(
    post({
      entities: ["marcus_rashford"],
      events: ["lineup"],
      sources: [],
      numbers: ["10"],
      normalizedCaption: "rashford lineup update",
      tokens: ["rashford", "lineup", "update"],
      publishedAt: "2026-09-20T10:00:00.000Z",
    }),
    signature({
      entities: ["bruno_fernandes"],
      events: ["injury"],
      sources: ["fabrizio_romano"],
      numbers: ["8"],
      firstPublishedAt: "2026-09-18T10:00:00.000Z",
      lastPublishedAt: "2026-09-18T10:00:00.000Z",
      normalizedCaptions: ["bruno injury update"],
    }),
  );

  assert.ok(result.score <= 0.4);
  assert.equal(decideDeterministicMatch(result).decision, "SEPARATE");
});

Deno.test("English and Korean Bruno injury posts merge as one story", () => {
  const result = deterministicSimilarity(
    post({ normalizedCaption: "브루노 부상 소식 맨체스터 유나이티드" }),
    signature({
      normalizedCaptions: ["bruno injury update manchester united"],
    }),
  );

  assert.equal(result.primaryEntityOverlap, true);
  assert.ok(result.score >= 0.85);
  assert.equal(decideDeterministicMatch(result).decision, "AUTO_MERGE");
});

Deno.test("same journalist repost contributes source overlap", () => {
  const result = deterministicSimilarity(
    post({
      entities: ["bruno_fernandes"],
      events: ["injury"],
      sources: ["fabrizio_romano"],
      numbers: [],
    }),
    signature({
      entities: ["bruno_fernandes"],
      events: ["injury"],
      sources: ["fabrizio_romano"],
      numbers: [],
    }),
  );

  assert.equal(result.signals.sourceOverlap, 1);
  assert.equal(
    candidatePrefilter(
      post({ entities: ["bruno_fernandes"] }),
      signature({
        entities: ["bruno_fernandes"],
        events: [],
        sources: ["fabrizio_romano"],
        numbers: [],
      }),
    ),
    true,
  );
});

Deno.test("same player with different events is not merged", () => {
  const result = deterministicSimilarity(
    post({ entities: ["bruno_fernandes"], events: ["lineup"] }),
    signature({ entities: ["bruno_fernandes"], events: ["injury"] }),
  );

  assert.equal(result.contradiction, true);
  assert.equal(decideDeterministicMatch(result).decision, "SEPARATE");
});

Deno.test("same match with different events is not merged", () => {
  const result = deterministicSimilarity(
    post({ entities: ["manchester_united", "arsenal"], events: ["lineup"] }),
    signature({
      entities: ["manchester_united", "arsenal"],
      events: ["match"],
    }),
  );

  assert.equal(result.contradiction, true);
  assert.equal(decideDeterministicMatch(result).decision, "SEPARATE");
});

Deno.test("candidate pre-filter excludes a wholly unrelated post", () => {
  assert.equal(
    candidatePrefilter(
      post({
        entities: ["marcus_rashford"],
        events: ["transfer"],
        sources: [],
        numbers: ["99"],
        normalizedCaption: "rashford transfer rumor",
        tokens: ["rashford", "transfer", "rumor"],
      }),
      signature({
        entities: ["bruno_fernandes"],
        events: ["injury"],
        sources: ["fabrizio_romano"],
        numbers: ["8"],
        normalizedCaptions: ["bruno injury update"],
      }),
    ),
    false,
  );
});

Deno.test("deterministic thresholds include exactly 0.40 and 0.85", () => {
  const highBoundary = deterministicSimilarity(
    post({
      events: ["injury"],
      normalizedCaption: "bruno injury",
      tokens: ["bruno", "injury"],
    }),
    signature({
      firstPublishedAt: "2026-09-16T10:00:00.000Z",
      lastPublishedAt: "2026-09-16T10:00:00.000Z",
      normalizedCaptions: ["bruno"],
    }),
  );
  const lowBoundary = deterministicSimilarity(
    post({
      entities: ["bruno_fernandes"],
      events: [],
      sources: [],
      numbers: [],
      normalizedCaption: "bruno injury",
      tokens: ["bruno", "injury"],
    }),
    signature({
      entities: ["bruno_fernandes"],
      events: [],
      sources: [],
      numbers: [],
      firstPublishedAt: "2026-09-16T10:00:00.000Z",
      lastPublishedAt: "2026-09-16T10:00:00.000Z",
      normalizedCaptions: ["bruno"],
    }),
  );

  assert.equal(highBoundary.score, 0.85);
  assert.equal(decideDeterministicMatch(highBoundary).decision, "AUTO_MERGE");
  assert.equal(lowBoundary.score, 0.4);
  assert.equal(decideDeterministicMatch(lowBoundary).decision, "SEPARATE");
});

Deno.test("high score without primary entity overlap cannot auto-merge", () => {
  const decision = decideDeterministicMatch(
    decisionResult({ score: 0.99, primaryEntityOverlap: false }),
  );

  assert.equal(decision.decision, "SEPARATE");
  assert.equal(decision.reasonCode, "NO_PRIMARY_ENTITY");
});

Deno.test("contradictory anchors prevent auto-merge", () => {
  const decision = decideDeterministicMatch(
    decisionResult({ score: 0.99, contradiction: true }),
  );

  assert.equal(decision.decision, "SEPARATE");
  assert.equal(decision.reasonCode, "CONTRADICTORY_ANCHOR");
});

Deno.test("aggregate signature unions entity, event, source, number, and time", () => {
  const merged = mergeSignature(
    signature({
      entities: ["bruno_fernandes"],
      events: ["injury"],
      sources: ["fabrizio_romano"],
      numbers: ["8"],
      firstPublishedAt: "2026-09-18T10:00:00.000Z",
      lastPublishedAt: "2026-09-18T10:00:00.000Z",
      representativePostIds: ["post-1"],
    }),
    post({
      entities: ["bruno_fernandes", "manchester_united"],
      events: ["injury", "match"],
      sources: ["fabrizio_romano", "bbc"],
      numbers: ["8", "10"],
      publishedAt: "2026-09-18T08:00:00.000Z",
    }),
    "post-2",
  );

  assert.deepEqual(merged.entities, ["bruno_fernandes", "manchester_united"]);
  assert.deepEqual(merged.events, ["injury", "match"]);
  assert.deepEqual(merged.sources, ["fabrizio_romano", "bbc"]);
  assert.deepEqual(merged.numbers, ["8", "10"]);
  assert.equal(merged.firstPublishedAt, "2026-09-18T08:00:00.000Z");
  assert.equal(merged.lastPublishedAt, "2026-09-18T10:00:00.000Z");
  assert.deepEqual(merged.representativePostIds, ["post-1", "post-2"]);
});

Deno.test("aggregate signature retains context beyond one representative", () => {
  const newPost = post({
    entities: ["manchester_united"],
    events: ["injury"],
    sources: ["fabrizio_romano"],
    numbers: ["8"],
  });
  const representativeOnly = signature({
    entities: ["bruno_fernandes"],
    events: ["injury"],
    sources: [],
    numbers: [],
    normalizedCaptions: ["unrelated report"],
  });
  const aggregate = signature({
    entities: ["bruno_fernandes", "manchester_united"],
    events: ["injury"],
    sources: ["fabrizio_romano"],
    numbers: ["8"],
  });

  assert.equal(candidatePrefilter(newPost, representativeOnly), false);
  assert.equal(candidatePrefilter(newPost, aggregate), true);
  assert.ok(
    deterministicSimilarity(newPost, aggregate).score >
      deterministicSimilarity(newPost, representativeOnly).score,
  );
});

Deno.test("representatives are selected by reliability then freshness up to three", () => {
  const members: RepresentativeMember[] = [
    {
      postId: "old-low",
      reliability: 0.2,
      publishedAt: "2026-09-18T08:00:00Z",
    },
    {
      postId: "high-old",
      reliability: 0.9,
      publishedAt: "2026-09-18T09:00:00Z",
    },
    {
      postId: "high-new",
      reliability: 0.9,
      publishedAt: "2026-09-18T11:00:00Z",
    },
    {
      postId: "medium-new",
      reliability: 0.7,
      publishedAt: "2026-09-18T12:00:00Z",
    },
    {
      postId: "high-earlier",
      reliability: 0.9,
      publishedAt: "2026-09-18T08:30:00Z",
    },
  ];

  assert.deepEqual(selectRepresentativeMembers(members), [
    "high-new",
    "high-old",
    "high-earlier",
  ]);
});

Deno.test("representative limit defaults to three", () => {
  const members: RepresentativeMember[] = [
    { postId: "first", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
    { postId: "second", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
    { postId: "third", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
    { postId: "fourth", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
  ];

  assert.deepEqual(selectRepresentativeMembers(members), [
    "first",
    "second",
    "third",
  ]);
});

Deno.test("representative ties preserve input order and do not canonicalize post pairs", () => {
  const members: RepresentativeMember[] = [
    { postId: "z-post", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
    { postId: "a-post", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
    { postId: "m-post", reliability: 0.5, publishedAt: "2026-09-18T10:00:00Z" },
  ];

  assert.deepEqual(selectRepresentativeMembers(members), [
    "z-post",
    "a-post",
    "m-post",
  ]);
  assert.deepEqual(
    mergeSignature(
      signature({ representativePostIds: ["z-post", "a-post"] }),
      post(),
      "m-post",
    )
      .representativePostIds,
    ["z-post", "a-post", "m-post"],
  );
});
