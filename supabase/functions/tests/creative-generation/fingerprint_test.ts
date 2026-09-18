import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.8";
import { hashGenerationInput } from "../../creative-generation/fingerprint.ts";

const base = {
  candidate_id: "candidate-1",
  evidence_snapshot: {
    posts: [{ evidence_id: "post:1", caption: "A" }],
    score_evidence: { "score:velocity": 2 },
  },
  content_mode: "NEWS_UPDATE" as const,
  match_phase: null,
  generation_config_version: "m5-v1",
  classifier_config_version: "classifier-v1",
  generator_model_config: { model: "gpt-5.6-terra", reasoning: "medium" },
};

Deno.test("same semantic input hashes identically despite key ordering", async () => {
  const first = await hashGenerationInput(base);
  const second = await hashGenerationInput({
    ...base,
    evidence_snapshot: {
      score_evidence: { "score:velocity": 2 },
      posts: [{ caption: "A", evidence_id: "post:1" }],
    },
  });
  assertEquals(first, second);
});

Deno.test("changed evidence produces a different hash", async () => {
  const first = await hashGenerationInput(base);
  const second = await hashGenerationInput({
    ...base,
    evidence_snapshot: {
      posts: [{ evidence_id: "post:1", caption: "B" }],
      score_evidence: { "score:velocity": 2 },
    },
  });
  assertNotEquals(first, second);
});

Deno.test("runtime metadata does not affect the semantic hash", async () => {
  const first = await hashGenerationInput(base);
  const second = await hashGenerationInput({
    ...base,
    request_id: "different-request",
    lease_owner: "different-worker",
    created_at: "2026-09-18T00:00:00Z",
  });
  assertEquals(first, second);
});
