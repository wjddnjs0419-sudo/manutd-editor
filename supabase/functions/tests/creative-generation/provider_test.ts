import { assertEquals, assertRejects, assert } from "jsr:@std/assert@1.0.8";
import { createOpenAIProvider, type ProviderPromptInput } from "../../creative-generation/provider.ts";
import type { CreativeBriefOutput } from "../../creative-generation/types.ts";

const output: CreativeBriefOutput = {
  schema_version: "1.0",
  content_mode: "NEWS_UPDATE",
  match_phase: null,
  generation_quality: "FULL",
  angle: "Confirmed update",
  key_takeaway: "The confirmed update matters now.",
  hooks: [
    { id: "hook_1", text: "Hook one" },
    { id: "hook_2", text: "Hook two" },
    { id: "hook_3", text: "Hook three" },
  ],
  slides: [
    ...Array.from({ length: 4 }, (_, index) => ({
      slide_number: index + 1,
      purpose: index === 0 ? "HOOK" : "DETAIL",
      headline: `Headline ${index + 1}`,
      body: `Body ${index + 1}`,
      claims: [{ claim_id: `claim_${index + 1}`, type: "FACT" as const, text: "Supported fact", evidence_ids: ["post:1"] }],
      visual_direction: { subject: "United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline"] },
    })),
  ],
  caption: { body: "Caption", cta: "What do you think?" },
  sources: [{ evidence_id: "post:1", label: "United source" }],
};

const input: ProviderPromptInput = {
  content_mode: "NEWS_UPDATE",
  match_phase: null,
  evidence_snapshot: { evidence_ids: ["post:1"], posts: [{ evidence_id: "post:1", caption: "Confirmed" }] },
};

function response(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

Deno.test("uses Responses API strict JSON Schema without web search", async () => {
  let request: RequestInit | undefined;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async (_input, init) => {
      request = init;
      return response({ output_text: JSON.stringify(output) });
    },
  });
  const result = await provider.generate(input);
  assertEquals(result.angle, output.angle);
  const body = JSON.parse(String(request?.body));
  assertEquals(body.model, "gpt-5.6-terra");
  assertEquals(body.text.format.type, "json_schema");
  assertEquals(body.text.format.strict, true);
  assertEquals(body.text.format.schema.properties.hooks.minItems, 3);
  assertEquals(body.text.format.schema.properties.hooks.maxItems, 3);
  assertEquals(body.tools, undefined);
  assertEquals(body.store, false);
  assertEquals(request?.headers instanceof Headers ? request.headers.get("authorization") : undefined, undefined);
  const prompt = ((body.input as Array<{ content?: Array<{ text?: string }> }>)[0]?.content?.[0]?.text) ?? "";
  assert(prompt.includes("manutd_editor"));
  assert(prompt.includes("HOOK"));
  assert(!prompt.includes("현재 확보된 자료"));
});

Deno.test("classifies through the configured classifier model and parses structured output", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String((init as RequestInit | undefined)?.body));
      return response({ output_text: JSON.stringify({ content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.9, reason_code: "MODEL" }) });
    },
  });
  const result = await provider.classify("A caption", { version: "classifier-v1", model: "gpt-5.6-luna", reasoning: "low", confidence_threshold: 0.75, keywords: { match: [], news: [], analysis: [] }, phase_keywords: { PRE_MATCH: [], LIVE: [], POST_MATCH: [] } });
  assertEquals(result.content_mode, "NEWS_UPDATE");
  assertEquals(body?.model, "gpt-5.6-luna");
});

Deno.test("retries a 429 then succeeds without logging provider body", async () => {
  let attempts = 0;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? response({ error: { message: "secret detail" } }, 429, { "retry-after": "0" }) : response({ output_text: JSON.stringify(output) });
    },
  });
  const result = await provider.generate(input);
  assertEquals(result.generation_quality, "FULL");
  assertEquals(attempts, 2);
  assertEquals(provider.getUsageStats(), { provider_calls: 2, input_tokens: 0, output_tokens: 0, retry_count: 1 });
});

Deno.test("records provider call and token totals without retaining response content", async () => {
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => response({ output_text: JSON.stringify(output), usage: { input_tokens: 1234, output_tokens: 567 } }),
  });
  await provider.generate(input);
  assertEquals(provider.getUsageStats(), { provider_calls: 1, input_tokens: 1234, output_tokens: 567, retry_count: 0 });
});

Deno.test("does not retry permanent authorization failures", async () => {
  let attempts = 0;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response({ error: { message: "do not persist" } }, 401);
    },
  });
  await assertRejects(() => provider.generate(input), Error, "FAILED_PROVIDER");
  assertEquals(attempts, 1);
});

Deno.test("does not retry an Exploration generation request after a transient failure", async () => {
  let attempts = 0;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response({ error: { message: "transient" } }, 503);
    },
  });
  await assertRejects(() => provider.generate({ ...input, generation_intent: "EXPLORATION" }), Error, "FAILED_PROVIDER");
  assertEquals(attempts, 1);
  assertEquals(provider.getUsageStats(), { provider_calls: 1, input_tokens: 0, output_tokens: 0, retry_count: 0 });
});

Deno.test("supports a request-scoped zero-retry limit for the Exploration classifier", async () => {
  let attempts = 0;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async () => {
      attempts += 1;
      return response({ error: { message: "transient" } }, 503);
    },
  });
  const classify = provider.classify as unknown as (
    text: string,
    config: Parameters<typeof provider.classify>[1],
    options: { maxRetries: number },
  ) => Promise<unknown>;
  await assertRejects(() => classify("ambiguous story", {
    version: "classifier-v1", model: "gpt-5.6-luna", reasoning: "low", confidence_threshold: 0.75,
    keywords: { match: [], news: [], analysis: [] },
    phase_keywords: { PRE_MATCH: [], LIVE: [], POST_MATCH: [] },
  }, { maxRetries: 0 }), Error, "FAILED_PROVIDER");
  assertEquals(attempts, 1);
  assertEquals(provider.getUsageStats().retry_count, 0);
});

Deno.test("classifies HTTP failures using status and allowlisted quota code only", async () => {
  for (const [status, upstreamCode, expected] of [
    [401, "secret-key", "HTTP_AUTH"], [403, "secret", "HTTP_AUTH"],
    [404, "model_not_found", "HTTP_MODEL"], [400, "secret", "HTTP_REQUEST"],
    [422, "secret", "HTTP_REQUEST"], [429, "insufficient_quota", "HTTP_QUOTA"],
    [429, "rate_limit_exceeded", "HTTP_RATE_LIMIT"], [429, "sensitive unknown code", "HTTP_USAGE_LIMIT"], [500, "secret", "HTTP_SERVER"],
    [503, "secret", "HTTP_SERVER"], [418, "secret", "HTTP_OTHER"],
  ] as const) {
    const provider = createOpenAIProvider({ apiKey: "sensitive-key", maxRetries: 0,
      fetchImpl: async () => response({ error: { code: upstreamCode, message: "sensitive article and output" } }, status) });
    const error = await assertRejects(() => provider.generate(input));
    assertEquals((error as unknown as { code: string }).code, expected);
    assertEquals((error as unknown as { status: number }).status, status);
    assert(!JSON.stringify(error).includes("sensitive"));
    assert(error instanceof Error);
    assert(!error.message.includes("secret"));
  }
});

Deno.test("distinguishes transport and response parsing failures without raw diagnostics", async () => {
  for (const [fetchImpl, expected, status] of [
    [async () => { throw new TypeError("sensitive network detail"); }, "NETWORK", undefined],
    [async () => { throw new Error("sensitive unknown detail"); }, "UNKNOWN", undefined],
    [async () => {
      const result = response({});
      result.json = () => Promise.reject(new TypeError("sensitive body transport detail"));
      return result;
    }, "NETWORK", undefined],
    [async () => new Response("sensitive invalid JSON"), "INVALID_RESPONSE_JSON", 200],
    [async () => response({ output_text: "sensitive invalid JSON", usage: { input_tokens: 12, output_tokens: 3 } }), "INVALID_OUTPUT_JSON", 200],
    [async () => response({ output: [] }), "MISSING_OUTPUT", 200],
  ] as const) {
    const provider = createOpenAIProvider({ apiKey: "test", maxRetries: 0, fetchImpl });
    const error = await assertRejects(() => provider.generate(input));
    assertEquals((error as unknown as { code: string }).code, expected);
    assertEquals((error as unknown as { status?: number }).status, status);
    assert(!JSON.stringify(error).includes("sensitive"));
    if (expected === "INVALID_OUTPUT_JSON") assertEquals(provider.getUsageStats().output_tokens, 3);
  }
});

Deno.test("classifies deadline during fetch or body read as timeout without Exploration retry", async () => {
  for (const bodyRead of [false, true]) {
    const provider = createOpenAIProvider({ apiKey: "test", timeoutMs: 5,
      fetchImpl: (_url, init) => {
        const pending = new Promise<never>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new DOMException("sensitive timeout", "AbortError")), { once: true });
        });
        if (!bodyRead) return pending;
        const result = response({});
        result.json = () => pending;
        return Promise.resolve(result);
      },
    });
    const error = await assertRejects(() => provider.generate({ ...input, generation_intent: "EXPLORATION" }));
    assertEquals((error as unknown as { category: string }).category, "PROVIDER_TIMEOUT");
    assertEquals((error as unknown as { code: string }).code, "TIMEOUT");
    assertEquals(provider.getUsageStats().provider_calls, 1);
    assertEquals(provider.getUsageStats().retry_count, 0);
  }
});
