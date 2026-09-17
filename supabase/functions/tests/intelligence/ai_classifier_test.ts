import assert from "node:assert/strict";

import {
  type ClassifierInput,
  classifierVersion,
  createStoryClassifier,
  type StoryClusterEvaluation,
} from "../../intelligence/ai_classifier.ts";
import { createEvaluationRepository } from "../../intelligence/repository.ts";
import { canonicalInputHash } from "../../intelligence/features.ts";
import type {
  ClusterSignature,
  StoryFeatures,
} from "../../intelligence/types.ts";

const rawPost: StoryFeatures = {
  entities: ["manchester_united", "bruno_fernandes"],
  events: ["injury"],
  sources: ["fabrizio_romano"],
  numbers: ["8"],
  dates: [],
  normalizedCaption: "bruno injury update manchester united",
  tokens: ["bruno", "injury", "update", "manchester", "united"],
  publishedAt: "2026-09-18T10:00:00.000Z",
  dictionaryVersion: "entity-v1",
};

const aggregateSignature: ClusterSignature = {
  entities: ["manchester_united", "bruno_fernandes"],
  events: ["injury"],
  sources: ["fabrizio_romano"],
  numbers: ["8"],
  firstPublishedAt: "2026-09-18T09:00:00.000Z",
  lastPublishedAt: "2026-09-18T10:00:00.000Z",
  representativePostIds: ["post-existing"],
  dictionaryVersion: "entity-v1",
};

const input = (
  overrides: Partial<ClassifierInput> = {},
): ClassifierInput => ({
  rawPostId: "00000000-0000-4000-8000-000000000001",
  candidateClusterId: "00000000-0000-4000-8000-000000000002",
  deterministicScore: 0.62,
  deterministicDecision: "AMBIGUOUS",
  rawPost,
  aggregateSignature,
  ...overrides,
});

const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const aiResponse = (
  sameStory: boolean,
  confidence = 0.94,
  reason = "same normalized story anchors",
): Response =>
  response({
    choices: [{
      message: {
        content: JSON.stringify({ same_story: sameStory, confidence, reason }),
      },
    }],
  });

const deps = (
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
) => ({
  aiEnabled: true,
  model: "gpt-5-mini",
  promptVersion: "cluster-v1",
  dictionaryVersion: "entity-v1",
  apiKey: "test-openai-key",
  endpoint: "https://example.test/v1/chat/completions",
  fetch: fetchImpl,
  timeoutMs: 100,
  ...overrides,
});

Deno.test("high deterministic decision does not call OpenAI", async () => {
  let calls = 0;
  const classifier = createStoryClassifier(
    deps(() => {
      calls += 1;
      return Promise.resolve(aiResponse(false));
    }),
  );

  const result = await classifier.classifyAmbiguousPair(
    input({ deterministicDecision: "AUTO_MERGE", deterministicScore: 0.85 }),
  );

  assert.equal(calls, 0);
  assert.equal(result.decision, "SAME_STORY");
  assert.equal(result.confidence, 1);
});

Deno.test("low deterministic decision does not call OpenAI", async () => {
  let calls = 0;
  const classifier = createStoryClassifier(
    deps(() => {
      calls += 1;
      return Promise.resolve(aiResponse(true));
    }),
  );

  const result = await classifier.classifyAmbiguousPair(
    input({ deterministicDecision: "SEPARATE", deterministicScore: 0.4 }),
  );

  assert.equal(calls, 0);
  assert.equal(result.decision, "DIFFERENT_STORY");
  assert.equal(result.confidence, 1);
});

Deno.test("only an ambiguity decision calls OpenAI once", async () => {
  let calls = 0;
  let requestBody: Record<string, unknown> | undefined;
  const classifier = createStoryClassifier(
    deps((_, init) => {
      calls += 1;
      requestBody = JSON.parse(String((init as RequestInit | undefined)?.body));
      return Promise.resolve(aiResponse(true));
    }),
  );

  const result = await classifier.classifyAmbiguousPair(input());

  assert.equal(calls, 1);
  assert.equal(result.decision, "SAME_STORY");
  assert.equal(result.confidence, 0.94);
  const bodyText = JSON.stringify(requestBody);
  assert.ok(bodyText.includes("aggregate_cluster_signature"));
  assert.ok(bodyText.includes("normalizedCaption"));
  assert.equal(bodyText.includes("raw_payload"), false);
  assert.equal(bodyText.includes("test-openai-key"), false);
});

Deno.test("AI feature flag off returns manual review without a call", async () => {
  let calls = 0;
  const classifier = createStoryClassifier(
    deps(() => {
      calls += 1;
      return Promise.resolve(aiResponse(true));
    }, { aiEnabled: false }),
  );

  const result = await classifier.classifyAmbiguousPair(input());

  assert.equal(calls, 0);
  assert.equal(result.decision, "MANUAL_REVIEW");
  assert.equal(result.sameStory, null);
});

Deno.test("classifier version changes when model, prompt, or dictionary changes", () => {
  const baseline = classifierVersion("model-a", "prompt-a", "dictionary-a");
  assert.notEqual(
    baseline,
    classifierVersion("model-b", "prompt-a", "dictionary-a"),
  );
  assert.notEqual(
    baseline,
    classifierVersion("model-a", "prompt-b", "dictionary-a"),
  );
  assert.notEqual(
    baseline,
    classifierVersion("model-a", "prompt-a", "dictionary-b"),
  );
});

Deno.test("timeout is converted to safe manual review", async () => {
  const classifier = createStoryClassifier(
    deps(() => new Promise<Response>(() => {}), { timeoutMs: 5 }),
  );

  const result = await classifier.classifyAmbiguousPair(input());

  assert.equal(result.decision, "MANUAL_REVIEW");
  assert.equal(result.reason, "UPSTREAM_TIMEOUT");
});

Deno.test("429 and 5xx responses are converted to safe manual review", async () => {
  for (const status of [429, 500, 503]) {
    const classifier = createStoryClassifier(
      deps(() => Promise.resolve(response({ secret: "do-not-copy" }, status))),
    );
    const result = await classifier.classifyAmbiguousPair(input());
    assert.equal(result.decision, "MANUAL_REVIEW");
    assert.equal(result.reason, "UPSTREAM_UNAVAILABLE");
    assert.equal(result.reason.includes("do-not-copy"), false);
  }
});

Deno.test("malformed JSON and missing classifier fields are rejected safely", async () => {
  const malformed = createStoryClassifier(
    deps(() => Promise.resolve(new Response("not-json", { status: 200 }))),
  );
  const missing = createStoryClassifier(
    deps(() =>
      Promise.resolve(
        response({
          choices: [{ message: { content: '{"same_story":true}' } }],
        }),
      )
    ),
  );

  assert.equal(
    (await malformed.classifyAmbiguousPair(input())).decision,
    "MANUAL_REVIEW",
  );
  assert.equal(
    (await missing.classifyAmbiguousPair(input())).decision,
    "MANUAL_REVIEW",
  );
});

Deno.test("missing required input fields are rejected", async () => {
  const classifier = createStoryClassifier(
    deps(() => Promise.resolve(aiResponse(true))),
  );

  await assert.rejects(
    classifier.classifyAmbiguousPair({
      ...input(),
      candidateClusterId: "",
    } as ClassifierInput),
    /invalid classifier input/,
  );
});

Deno.test("confidence below 0.90 cannot produce an automatic decision", async () => {
  const classifier = createStoryClassifier(
    deps(() => Promise.resolve(aiResponse(true, 0.89))),
  );

  const result = await classifier.classifyAmbiguousPair(input());

  assert.equal(result.decision, "MANUAL_REVIEW");
  assert.equal(result.sameStory, true);
  assert.equal(result.confidence, 0.89);
});

Deno.test("oversized reason is rejected without preserving the upstream text", async () => {
  const classifier = createStoryClassifier(
    deps(() => Promise.resolve(aiResponse(true, 0.99, "x".repeat(5000)))),
  );

  const result = await classifier.classifyAmbiguousPair(input());

  assert.equal(result.decision, "MANUAL_REVIEW");
  assert.equal(result.reason, "INVALID_RESPONSE");
  assert.equal(result.reason.includes("xxx"), false);
});

Deno.test("aggregate signature and member changes produce different input hashes", async () => {
  const first = await canonicalInputHash({
    raw_post_id: input().rawPostId,
    candidate_cluster_id: input().candidateClusterId,
    raw_post: input().rawPost,
    aggregate_signature: input().aggregateSignature,
  });
  const changedSignature = {
    ...input().aggregateSignature,
    representativePostIds: ["post-existing", "post-new"],
  };
  const second = await canonicalInputHash({
    raw_post_id: input().rawPostId,
    candidate_cluster_id: input().candidateClusterId,
    raw_post: input().rawPost,
    aggregate_signature: changedSignature,
  });

  assert.notEqual(first, second);
});

const evaluation: StoryClusterEvaluation = {
  rawPostId: input().rawPostId,
  candidateClusterId: input().candidateClusterId,
  deterministicScore: 0.62,
  decision: "MANUAL_REVIEW",
  sameStory: null,
  confidence: null,
  reason: "AI_DISABLED",
  model: "gpt-5-mini",
  promptVersion: "cluster-v1",
  dictionaryVersion: "entity-v1",
  classifierVersion: classifierVersion("gpt-5-mini", "cluster-v1", "entity-v1"),
  inputHash: "a".repeat(64),
  inputSnapshot: { raw_post: rawPost, aggregate_signature: aggregateSignature },
  result: { same_story: null, confidence: null, reason: "AI_DISABLED" },
};

Deno.test("duplicate audit identity and input hash are saved only once", async () => {
  let calls = 0;
  const repository = createEvaluationRepository({
    supabaseUrl: "https://example.test",
    serviceRoleKey: "service-role-secret",
    fetch: () => {
      calls += 1;
      return Promise.resolve(new Response(null, { status: 201 }));
    },
  });

  await repository.saveEvaluation(evaluation);
  await repository.saveEvaluation(evaluation);

  assert.equal(calls, 1);
});
