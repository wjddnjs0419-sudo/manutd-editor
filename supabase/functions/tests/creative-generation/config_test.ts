import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { validateGenerationConfig } from "../../creative-generation/config.ts";

const valid = {
  id: "config-1",
  version: "m5-v1",
  classifier_config: {
    version: "classifier-v1",
    model: "gpt-5.6-luna",
    reasoning: "low",
    confidence_threshold: 0.75,
    keywords: { match: ["goal"], news: ["injury"], analysis: ["tactical"] },
    phase_keywords: { PRE_MATCH: ["lineup"], LIVE: ["goal"], POST_MATCH: ["full time"] },
  },
  generation_config: { model: "gpt-5.6-terra", reasoning: "medium", max_output_tokens: 5000, max_retries: 2, timeout_ms: 30000 },
  mode_configs: {
    NEWS_UPDATE: { evidence_policy: "STRICT", prompt_version: "news-v1" },
    ANALYSIS_CONTEXT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "analysis-v1" },
    MATCH_CONTENT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "match-v1" },
  },
  quality_gate_config: { min_slides: 4, max_slides: 7, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true },
};

Deno.test("accepts the seeded generation config contract", () => {
  assertEquals(validateGenerationConfig(valid).version, "m5-v1");
});

Deno.test("rejects config without separate classifier and generator models", () => {
  assertThrows(() => validateGenerationConfig({ ...valid, generation_config: { ...valid.generation_config, model: "" } }));
});
