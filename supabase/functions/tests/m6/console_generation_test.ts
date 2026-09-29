import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { invokeCanonicalCarousel } from "../../_shared/m6/console_generation.ts";

Deno.test("console card generation invokes the canonical creative path with MANUAL and reloads the brief", async () => {
  let invocation: unknown = null;
  let loadedId = "";
  const brief = { id: "brief-1", candidate_id: "candidate-1", style_profile: "manutd_editor" };
  const result = await invokeCanonicalCarousel("candidate-1", {
    invoke: async (input) => {
      invocation = input;
      return { status: "READY", creative_brief_id: "brief-1" };
    },
    loadBrief: async (id) => {
      loadedId = id;
      return brief;
    },
  });
  assertEquals(invocation, { candidate_id: "candidate-1", trigger_type: "MANUAL" });
  assertEquals(loadedId, "brief-1");
  assertEquals(result, brief);
});

Deno.test("console card generation rejects a failed or stale canonical response", async () => {
  await assertRejects(
    () => invokeCanonicalCarousel("candidate-1", { invoke: async () => ({ status: "FAILED_PROVIDER" }), loadBrief: async () => null }),
    Error,
    "CREATIVE_GENERATION_FAILED",
  );
});

Deno.test("console card generation refuses a brief belonging to a different candidate", async () => {
  await assertRejects(
    () => invokeCanonicalCarousel("candidate-selected", {
      invoke: async () => ({ status: "NOOP", creative_brief_id: "brief-old" }),
      loadBrief: async () => ({ id: "brief-old", candidate_id: "candidate-costa" }),
    }),
    Error,
    "CREATIVE_BRIEF_CANDIDATE_MISMATCH",
  );
});

Deno.test("console card generation refuses a brief grounded on a different story cluster", async () => {
  await assertRejects(
    () => invokeCanonicalCarousel("candidate-selected", {
      invoke: async () => ({ status: "NOOP", creative_brief_id: "brief-old" }),
      loadBrief: async () => ({
        id: "brief-old",
        candidate_id: "candidate-selected",
        evidence_snapshot: { candidate: { story_cluster_id: "story-costa" }, story: { id: "story-costa" } },
      }),
    }, "story-selected"),
    Error,
    "CREATIVE_BRIEF_STORY_MISMATCH",
  );
});
