import assert from "node:assert/strict";

import {
  createContentUnderstandingProvider,
  ProviderError,
} from "../../analyze-content/provider.ts";
import { resolveContentUnderstandingConfig } from "../../analyze-content/config.ts";
import { goldenAnalysisOutput } from "../fixtures/m8_phase_a.ts";

const input = {
  caption: "Thoughts? 👀",
  visualFormat: "CAROUSEL" as const,
  media: [
    {
      mediaAssetId: "asset-1",
      assetType: "CAROUSEL_CHILD" as const,
      carouselIndex: 0,
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
      dataUrl: "data:image/jpeg;base64,aGVsbG8=",
    },
    {
      mediaAssetId: "asset-2",
      assetType: "CAROUSEL_CHILD" as const,
      carouselIndex: 1,
      mimeType: "image/jpeg",
      sha256: "b".repeat(64),
      dataUrl: "data:image/jpeg;base64,d29ybGQ=",
    },
    {
      mediaAssetId: "asset-3",
      assetType: "CAROUSEL_CHILD" as const,
      carouselIndex: 2,
      mimeType: "image/jpeg",
      sha256: "c".repeat(64),
      dataUrl: "data:image/jpeg;base64,Y2hhbmdlZA==",
    },
  ],
};

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function config(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    CONTENT_UNDERSTANDING_MODEL: "test-model",
    CONTENT_UNDERSTANDING_PROMPT_VERSION: "prompt-v1",
    CONTENT_UNDERSTANDING_TIMEOUT_MS: "1000",
    CONTENT_UNDERSTANDING_MAX_SLIDES: "6",
    CONTENT_UNDERSTANDING_MAX_BYTES: "1048576",
    CONTENT_UNDERSTANDING_BATCH_SIZE: "20",
    CONTENT_UNDERSTANDING_CONCURRENCY: "2",
    ...overrides,
  };
  return resolveContentUnderstandingConfig((name) => values[name]);
}

Deno.test("sends caption and ordered image data through strict private Responses input", async () => {
  let request: RequestInit | undefined;
  const provider = createContentUnderstandingProvider({
    apiKey: "test-key",
    config: config(),
    sleep: async () => {},
    fetchImpl: async (_input, init) => {
      request = init;
      return response({ output_text: JSON.stringify(goldenAnalysisOutput) });
    },
  });

  const result = await provider.analyze(input);
  const body = JSON.parse(String(request?.body)) as Record<string, any>;
  const content = body.input[0].content as Array<Record<string, unknown>>;

  assert.equal(result.visualFormat, "CAROUSEL");
  assert.equal(body.model, "test-model");
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(content[0]?.type, "input_text");
  assert.match(String(content[0]?.text), /Thoughts\?/);
  assert.deepEqual(content.slice(1).map((item) => item.image_url), input.media.map((item) => item.dataUrl));
  assert.equal(String(request?.body).includes("storage_path"), false);
  assert.equal(String(request?.body).includes("https://"), false);
});

Deno.test("supports a weak caption with visual text and claims without a live model", async () => {
  const provider = createContentUnderstandingProvider({
    apiKey: "test-key",
    config: config(),
    sleep: async () => {},
    fetchImpl: async () => response({ output_text: JSON.stringify(goldenAnalysisOutput) }),
  });

  const result = await provider.analyze(input);

  assert.equal(result.onImageText[1]?.text, "3 months without a club");
  assert.equal(result.claims[0]?.origin, "carousel_slide");
});

Deno.test("rejects malformed JSON and missing output text without upstream details", async () => {
  for (const body of [{ output_text: "not-json" }, { output: [] }]) {
    const provider = createContentUnderstandingProvider({
      apiKey: "test-key",
      config: config(),
      maxRetries: 0,
      fetchImpl: async () => response(body),
    });
    await assert.rejects(
      () => provider.analyze(input),
      (error: unknown) => error instanceof ProviderError && error.category === "MALFORMED_PROVIDER_RESPONSE" &&
        !String(error).includes("not-json"),
    );
  }
});

Deno.test("converts timeouts, rate limits, and upstream failures to safe categories", async () => {
  const timeoutProvider = createContentUnderstandingProvider({
    apiKey: "test-key",
    config: { ...config(), timeoutMs: 1 },
    maxRetries: 0,
    fetchImpl: async (_input, init) => await new Promise((_, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("secret timeout", "AbortError")));
    }),
  });
  await assert.rejects(
    () => timeoutProvider.analyze(input),
    (error: unknown) => error instanceof ProviderError && error.category === "PROVIDER_TIMEOUT",
  );

  let attempts = 0;
  const rateLimitProvider = createContentUnderstandingProvider({
    apiKey: "test-key",
    config: config(),
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? response({ error: { message: "secret upstream body" } }, 429, { "retry-after": "0" }) : response({ output_text: JSON.stringify(goldenAnalysisOutput) });
    },
  });
  await rateLimitProvider.analyze(input);
  assert.equal(attempts, 2);

  const upstreamProvider = createContentUnderstandingProvider({
    apiKey: "test-key",
    config: config(),
    maxRetries: 0,
    fetchImpl: async () => response({ error: { message: "secret upstream body" } }, 503),
  });
  await assert.rejects(
    () => upstreamProvider.analyze(input),
    (error: unknown) => error instanceof ProviderError && error.category === "PROVIDER_UPSTREAM_5XX" &&
      !String(error).includes("secret upstream body"),
  );
});
