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
  assertEquals(body.tools, undefined);
  assertEquals(body.store, false);
  assertEquals(request?.headers instanceof Headers ? request.headers.get("authorization") : undefined, undefined);
});

Deno.test("classifies through the configured classifier model and parses structured output", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    sleep: async () => {},
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init?.body));
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
