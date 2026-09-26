import assert from "node:assert/strict";

import {
  canonicalInputHash,
  DEFAULT_INTELLIGENCE_DICTIONARY,
  extractStoryFeatures,
} from "../../intelligence/features.ts";

const dictionary = DEFAULT_INTELLIGENCE_DICTIONARY;

Deno.test("normalizes Unicode with NFKC and folds English case", () => {
  const features = extractStoryFeatures(
    "ＭＡＮＣＨＥＳＴＥＲ UNITED announce Bruno Fernandes",
    "2026-09-18T10:00:00Z",
    dictionary,
  );

  assert.match(features.normalizedCaption, /manchester united/);
  assert.deepEqual(features.entities, ["manchester_united", "bruno_fernandes"]);
});

Deno.test("normalizes Korean spacing and common particles before alias lookup", () => {
  const features = extractStoryFeatures(
    "브루노는 부상의 소식을 전했다",
    "2026-09-18T10:00:00Z",
    dictionary,
  );

  assert.deepEqual(features.entities, ["bruno_fernandes"]);
  assert.deepEqual(features.events, ["injury"]);
  assert.ok(features.tokens.includes("브루노"));
  assert.ok(features.tokens.includes("부상"));
});

Deno.test("maps Bruno aliases to one canonical entity", () => {
  const captions = [
    "Bruno Fernandes",
    "Bruno",
    "브루노 페르난데스",
  ];

  for (const caption of captions) {
    assert.deepEqual(
      extractStoryFeatures(caption, "2026-09-18T10:00:00Z", dictionary)
        .entities,
      ["bruno_fernandes"],
    );
  }
});

Deno.test("maps injury aliases to one canonical event", () => {
  const captions = [
    "injury",
    "injured",
    "injury update",
    "부상",
    "부상 소식",
  ];

  for (const caption of captions) {
    assert.deepEqual(
      extractStoryFeatures(caption, "2026-09-18T10:00:00Z", dictionary).events,
      ["injury"],
    );
  }
});

Deno.test("normalizes recognized information source aliases", () => {
  const features = extractStoryFeatures(
    "According to Fabrizio Romano and 파브리치오 로마노",
    "2026-09-18T10:00:00Z",
    dictionary,
  );

  assert.deepEqual(features.sources, ["fabrizio_romano"]);
});

Deno.test("enriches features from multimodal semantics without flattening slide evidence", () => {
  const features = extractStoryFeatures(
    "Thoughts? 👀",
    "2026-09-18T10:00:00Z",
    dictionary,
    {
      entities: ["Jadon Sancho", "Manchester United"],
      topics: ["injury update", "clubless period"],
      sourceNames: ["Fabrizio Romano"],
      importantNumbers: ["3 months"],
      visualSummary: "Jadon Sancho training away from a club environment",
      combinedSummary: "The post claims a three-month clubless period.",
      onImageText: [{ text: "3 months without a club", slideIndex: 2, confidence: 0.96 }],
      claims: [{
        subject: "Jadon Sancho",
        predicate: "without_a_club_for",
        object: "3 months",
        text: "The post claims three months without a club.",
        origin: "carousel_slide",
        confidence: 0.94,
        evidence: [{ slideIndex: 2, mediaAssetId: "asset-3" }],
      }],
    },
  );

  assert.ok(features.entities.includes("jadon_sancho"));
  assert.ok(features.entities.includes("manchester_united"));
  assert.ok(features.events.includes("injury"));
  assert.ok(features.events.includes("clubless_period"));
  assert.ok(features.sources.includes("fabrizio_romano"));
  assert.ok(features.numbers.includes("3"));
  assert.ok(features.tokens.includes("jadon"));
  assert.ok(features.multimodalContext?.includes("The post claims a three-month clubless period."));
  assert.equal(features.tokens.includes("slide"), false);
});

Deno.test("omitted multimodal input preserves the caption-only feature shape", () => {
  const features = extractStoryFeatures(
    "Bruno injury update",
    "2026-09-18T10:00:00Z",
    dictionary,
  );
  assert.equal(Object.hasOwn(features, "multimodalContext"), false);
});

Deno.test("canonicalizes numbers and dates while preserving publication time", () => {
  const features = extractStoryFeatures(
    "Bruno scored 1,000 goals on 18 September 2026 and wore number 8",
    "2026-09-18T10:00:00+09:00",
    dictionary,
  );

  assert.deepEqual(features.numbers, ["1000", "8"]);
  assert.deepEqual(features.dates, ["2026-09-18"]);
  assert.equal(features.publishedAt, "2026-09-18T01:00:00.000Z");
});

Deno.test("canonicalizes ISO and Korean calendar dates", () => {
  const features = extractStoryFeatures(
    "Update on 2026-09-18 and 2026년 9월 18일",
    "2026-09-18T10:00:00Z",
    dictionary,
  );

  assert.deepEqual(features.dates, ["2026-09-18"]);
});

Deno.test("preserves unknown entities and tokens instead of guessing", () => {
  const features = extractStoryFeatures(
    "Zeta Player from Xylophone FC reported an unknown-term",
    "2026-09-18T10:00:00Z",
    dictionary,
  );

  assert.deepEqual(features.entities, []);
  assert.ok(features.tokens.includes("zeta"));
  assert.ok(features.tokens.includes("unknown-term"));
  assert.match(features.normalizedCaption, /zeta player/);
});

Deno.test("hashes the same canonical input deterministically", async () => {
  const input = {
    rawPost: extractStoryFeatures(
      "Bruno injury update",
      "2026-09-18T10:00:00Z",
      dictionary,
    ),
    aggregateSignature: {
      entities: ["bruno_fernandes"],
      events: ["injury"],
    },
    dictionaryVersion: dictionary.version,
  };

  assert.equal(
    await canonicalInputHash(input),
    await canonicalInputHash(input),
  );
});

Deno.test("changes the hash when the raw post changes", async () => {
  const base = {
    rawPost: { postId: "post-1", normalizedCaption: "bruno injury" },
    aggregateSignature: { entities: ["bruno_fernandes"] },
    dictionaryVersion: "entity-v1",
  };

  assert.notEqual(
    await canonicalInputHash(base),
    await canonicalInputHash({
      ...base,
      rawPost: { ...base.rawPost, postId: "post-2" },
    }),
  );
});

Deno.test("changes the hash when the aggregate cluster signature changes", async () => {
  const base = {
    rawPost: { postId: "post-1", normalizedCaption: "bruno injury" },
    aggregateSignature: { entities: ["bruno_fernandes"], events: ["injury"] },
    dictionaryVersion: "entity-v1",
  };

  assert.notEqual(
    await canonicalInputHash(base),
    await canonicalInputHash({
      ...base,
      aggregateSignature: {
        entities: ["bruno_fernandes"],
        events: ["injury", "lineup"],
      },
    }),
  );
});

Deno.test("ignores stable object property insertion order but preserves array order", async () => {
  const first = {
    rawPost: { postId: "post-1", normalizedCaption: "bruno injury" },
    aggregateSignature: { entities: ["bruno_fernandes"], events: ["injury"] },
    dictionaryVersion: "entity-v1",
  };
  const reordered = {
    dictionaryVersion: "entity-v1",
    aggregateSignature: { events: ["injury"], entities: ["bruno_fernandes"] },
    rawPost: { normalizedCaption: "bruno injury", postId: "post-1" },
  };

  assert.equal(
    await canonicalInputHash(first),
    await canonicalInputHash(reordered),
  );
  assert.notEqual(
    await canonicalInputHash({
      ...first,
      aggregateSignature: { entities: ["x", "y"] },
    }),
    await canonicalInputHash({
      ...first,
      aggregateSignature: { entities: ["y", "x"] },
    }),
  );
});
