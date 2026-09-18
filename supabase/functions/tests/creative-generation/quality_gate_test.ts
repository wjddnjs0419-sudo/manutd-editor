import { assertEquals, assert } from "jsr:@std/assert@1.0.8";
import { validateCreativeBrief, generateWithOneRepair, type QualityGateConfig } from "../../creative-generation/quality_gate.ts";
import type { EvidenceSnapshot, CreativeBriefOutput } from "../../creative-generation/types.ts";
import type { ProviderPromptInput } from "../../creative-generation/provider.ts";

const evidence: EvidenceSnapshot = {
  schema_version: "1.0",
  candidate: {} as EvidenceSnapshot["candidate"],
  story: {} as EvidenceSnapshot["story"],
  posts: [],
  sources: [{ evidence_id: "source:1", source_id: "source-1", canonical_name: "United", entity_type: "CLUB", reliability_score: 10, evidence_text: "Confirmed", first_cited_post_id: "post-1", citation_count: 1 }],
  score_evidence: {},
  evidence_ids: ["post:1", "source:1"],
};

const config: QualityGateConfig = { min_slides: 4, max_slides: 7, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true };

function valid(overrides: Partial<CreativeBriefOutput> = {}): CreativeBriefOutput {
  return {
    schema_version: "1.0",
    content_mode: "NEWS_UPDATE",
    match_phase: null,
    generation_quality: "FULL",
    angle: "Confirmed angle",
    key_takeaway: "Confirmed takeaway",
    hooks: ["1", "2", "3"].map((id) => ({ id: `hook_${id}`, text: `Hook ${id}` })),
    slides: Array.from({ length: 4 }, (_, index) => ({
      slide_number: index + 1,
      purpose: index === 0 ? "HOOK" : "DETAIL",
      headline: `Headline ${index + 1}`,
      body: `Body ${index + 1}`,
      claims: [{ claim_id: `claim_${index + 1}`, type: "FACT" as const, text: "Confirmed claim", evidence_ids: ["source:1"] }],
      visual_direction: { subject: "United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline", "body"] },
    })),
    caption: { body: "Caption", cta: "Tell us" },
    sources: [{ evidence_id: "source:1", label: "Manchester United" }],
    ...overrides,
  };
}

const providerInput: ProviderPromptInput = { content_mode: "NEWS_UPDATE", match_phase: null, evidence_snapshot: evidence };

Deno.test("accepts a fully grounded four-slide brief", () => {
  const result = validateCreativeBrief(valid(), evidence, config);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("rejects hook count and carousel length violations", () => {
  const result = validateCreativeBrief(valid({ hooks: [{ id: "only", text: "Only" }], slides: [] }), evidence, config);
  assert(result.errors.some((error) => error.code === "HOOK_COUNT"));
  assert(result.errors.some((error) => error.code === "SLIDE_COUNT"));
});

Deno.test("rejects invalid evidence IDs and missing FACT grounding", () => {
  const output = valid({ slides: valid().slides.map((slide) => ({ ...slide, claims: [{ ...slide.claims[0]!, evidence_ids: ["unknown:1"] }] })) });
  const result = validateCreativeBrief(output, evidence, config);
  assert(result.errors.some((error) => error.code === "EVIDENCE_ID_UNKNOWN"));
  assert(result.errors.some((error) => error.code === "FACT_UNGROUNDED"));
});

Deno.test("requires supporting evidence for INFERENCE and visual direction", () => {
  const output = valid({ slides: valid().slides.map((slide) => ({ ...slide, claims: [{ ...slide.claims[0]!, type: "INFERENCE", evidence_ids: [] }], visual_direction: undefined as never })) });
  const result = validateCreativeBrief(output, evidence, config);
  assert(result.errors.some((error) => error.code === "INFERENCE_UNGROUNDED"));
  assert(result.errors.some((error) => error.code === "VISUAL_DIRECTION_MISSING"));
});

Deno.test("blocks NEWS_UPDATE without reliable source evidence", () => {
  const sparse = { ...evidence, sources: [], evidence_ids: ["post:1"] };
  const result = validateCreativeBrief(valid({ sources: [] }), sparse, config);
  assert(result.errors.some((error) => error.code === "NEWS_EVIDENCE_BLOCKED"));
});

Deno.test("repairs once and validates the repaired output", async () => {
  let calls = 0;
  const result = await generateWithOneRepair({
    repair: async () => {
      calls += 1;
      return valid();
    },
  }, valid({ hooks: [] }), providerInput, evidence, config);
  assertEquals(calls, 1);
  assertEquals(result.ok, true);
  assertEquals(result.repair_attempted, true);
});

Deno.test("failed repair never triggers a second repair", async () => {
  let calls = 0;
  const result = await generateWithOneRepair({
    repair: async () => {
      calls += 1;
      return valid({ hooks: [] });
    },
  }, valid({ hooks: [] }), providerInput, evidence, config);
  assertEquals(calls, 1);
  assertEquals(result.ok, false);
  assertEquals(result.repair_attempted, true);
});
