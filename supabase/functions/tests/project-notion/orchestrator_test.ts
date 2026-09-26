import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { runProjectNotion } from "../../project-notion/orchestrator.ts";
import type { StoredCreativeBrief } from "../../creative-generation/repository.ts";
import type { ContentPipelineNotionClientLike } from "../../creative-generation/notion_projection.ts";

const brief = {
  id: "brief-1", candidate_id: "candidate-1", version: 1, content_mode: "ANALYSIS_CONTEXT", match_phase: null,
  headline: "Hook", angle: "Angle", slide_count: 4, caption_draft: "Caption", cta: "Tell us",
  slides_json: { key_takeaway: "Takeaway", slides: [{ slide_number: 1, headline: "Slide", body: "Body" }] },
  design_json: { slides: [] }, hooks_json: [{ id: "hook-1", text: "Hook" }], grounding_json: { claims: [] },
  evidence_snapshot: { sources: [] }, generation_metadata: {}, generation_quality: "FULL", model_name: "test", generated_at: "2026-09-27T00:00:00Z",
  status: "READY", format: "INSTAGRAM_CAROUSEL", generation_config_id: "config-1", input_fingerprint: "fingerprint", created_at: "", updated_at: "",
} as unknown as StoredCreativeBrief;

function notion(overrides: Partial<ContentPipelineNotionClientLike> = {}) {
  const calls: string[] = [];
  return {
    calls,
    async createPage() { calls.push("create"); return { id: "page-1", url: "https://notion.test/page-1" }; },
    async updatePage(id: string) { calls.push(`update:${id}`); return { id, url: "https://notion.test/page-1" }; },
    async appendBlockChildren(id: string) { calls.push(`append:${id}`); return { id }; },
    ...overrides,
  } satisfies ContentPipelineNotionClientLike & { calls: string[] };
}

Deno.test("projects a READY brief and persists independent pipeline state", async () => {
  const saved: unknown[] = [];
  const api = notion();
  const result = await runProjectNotion("brief-1", {
    repository: {
      getCreativeBrief: async () => brief,
      getPipelineState: async () => null,
      savePipelineState: async (state) => { saved.push(state); },
      getDailyIntelligencePageId: async () => null,
    },
    notion: api,
  });

  assertEquals(result, { status: "PROJECTED", creative_brief_id: "brief-1", action: "CREATED", revision: 1, notion_page_id: "page-1", url: "https://notion.test/page-1" });
  assertEquals(api.calls, ["create"]);
  assertEquals(saved, [{ candidate_id: "candidate-1", creative_brief_id: "brief-1", revision: 1, notion_page_id: "page-1", sync_hash: "fingerprint", production_status: "EDITABLE" }]);
});

Deno.test("propagates Notion failure for editorial retry without changing canonical data", async () => {
  const api = notion({ createPage: async () => { throw new Error("Notion unavailable"); } });
  let saves = 0;

  await assertRejects(
    () => runProjectNotion("brief-1", {
      repository: { getCreativeBrief: async () => brief, getPipelineState: async () => null, savePipelineState: async () => { saves += 1; }, getDailyIntelligencePageId: async () => null },
      notion: api,
    }),
    Error,
    "Notion unavailable",
  );
  assertEquals(saves, 0);
});
