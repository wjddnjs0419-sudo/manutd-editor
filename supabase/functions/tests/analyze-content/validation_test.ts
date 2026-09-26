import assert from "node:assert/strict";

import {
  AnalysisValidationError,
  validateAnalysisOutput,
} from "../../analyze-content/validation.ts";
import { goldenAnalysisOutput } from "../fixtures/m8_phase_a.ts";

const context = {
  visualFormat: "CAROUSEL" as const,
  slideCount: 4,
};

Deno.test("validates the golden multimodal output and preserves slide evidence", () => {
  const result = validateAnalysisOutput(goldenAnalysisOutput, context);

  assert.equal(result.combinedSummary, goldenAnalysisOutput.combinedSummary);
  assert.equal(result.claims[0]?.evidence[0]?.slideIndex, 2);
  assert.equal(result.claims[0]?.origin, "carousel_slide");
  assert.equal(result.evidenceState.combinedSummary, "INFERRED");
});

Deno.test("rejects a claim with an unsupported origin", () => {
  assert.throws(
    () => validateAnalysisOutput({
      ...goldenAnalysisOutput,
      claims: [{ ...goldenAnalysisOutput.claims[0], origin: "verified_fact" }],
    }, context),
    (error: unknown) => error instanceof AnalysisValidationError && error.code === "INVALID_CLAIM",
  );
});

Deno.test("rejects confidence outside the extraction range", () => {
  assert.throws(
    () => validateAnalysisOutput({
      ...goldenAnalysisOutput,
      analysisConfidence: 1.2,
    }, context),
    (error: unknown) => error instanceof AnalysisValidationError && error.code === "INVALID_CONFIDENCE",
  );
});

Deno.test("rejects a model response that omits evidence states", () => {
  const { evidenceState: _ignored, ...withoutStates } = goldenAnalysisOutput;
  assert.throws(
    () => validateAnalysisOutput(withoutStates, context),
    (error: unknown) => error instanceof AnalysisValidationError && error.code === "INVALID_EVIDENCE_STATE",
  );
});

Deno.test("rejects a Reel response that claims full-video visual understanding", () => {
  assert.throws(
    () => validateAnalysisOutput({ ...goldenAnalysisOutput, visualFormat: "VIDEO_FULL" }, {
      visualFormat: "THUMBNAIL_ONLY",
      slideCount: 1,
    }),
    (error: unknown) => error instanceof AnalysisValidationError && error.code === "VISUAL_FORMAT_MISMATCH",
  );
});
