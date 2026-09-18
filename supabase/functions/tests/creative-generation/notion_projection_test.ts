import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { projectCreativeBriefToContentPipeline, dailyIntelligenceCreativeProperties } from "../../creative-generation/notion_projection.ts";
import type { StoredCreativeBrief } from "../../creative-generation/repository.ts";
import type { NotionBlock, NotionPagePayload } from "../../notion-sync/mapper.ts";

const brief = {
  id: "brief-1", candidate_id: "candidate-1", version: 2, content_mode: "ANALYSIS_CONTEXT", match_phase: null,
  headline: "Hook one", angle: "Why it matters", slide_count: 4, caption_draft: "Caption", cta: "Tell us",
  slides_json: { key_takeaway: "Takeaway", slides: [{ slide_number: 1, headline: "Slide one", body: "Body one" }, { slide_number: 2, headline: "Slide two", body: "Body two" }] },
  design_json: { slides: [{ slide_number: 1, visual_direction: { subject: "United", image_type: "photo", layout_intent: "clear" } }] },
  hooks_json: [{ id: "hook_1", text: "Hook one" }, { id: "hook_2", text: "Hook two" }, { id: "hook_3", text: "Hook three" }],
  grounding_json: { claims: [{ claim_id: "claim_1", evidence_ids: ["post:1"] }] },
  evidence_snapshot: { sources: [{ evidence_id: "post:1", account_username: "utdreport" }] }, generation_metadata: {}, generation_quality: "FULL", model_name: "gpt-5.6-terra", generated_at: "2026-09-18T10:00:00Z",
  status: "READY", format: "INSTAGRAM_CAROUSEL", generation_config_id: "config-1", input_fingerprint: "hash", created_at: "", updated_at: "",
};

function notion() {
  const calls: Array<{ pageId?: string; payload: Record<string, unknown> }> = [];
  return {
    calls,
    createPage: async (payload: NotionPagePayload) => { calls.push({ payload: payload as unknown as Record<string, unknown> }); return { id: "new-page", url: "https://notion.test/new-page" }; },
    updatePage: async (pageId: string, payload: { properties: Record<string, unknown> }) => { calls.push({ pageId, payload }); return { id: pageId, url: "https://notion.test/existing" }; },
    appendBlockChildren: async (pageId: string, children: NotionBlock[]) => { calls.push({ pageId, payload: { children } }); return { id: pageId, url: "https://notion.test/existing" }; },
  };
}

Deno.test("projects an editable brief in place without human-owned fields", async () => {
  const api = notion();
  const result = await projectCreativeBriefToContentPipeline(brief as unknown as StoredCreativeBrief, { notion_page_id: "page-1", production_status: "EDITABLE", current_revision: 1 }, api);
  assertEquals(result.action, "UPDATED");
  assertEquals(api.calls[0]?.pageId, "page-1");
  const properties = api.calls[0]?.payload.properties as Record<string, unknown>;
  assertEquals(properties.Selected, undefined);
  assertEquals(properties["Editor Notes"], undefined);
  assert(properties["Creative Brief ID"] !== undefined);
  assert(api.calls[1]?.payload.children !== undefined);
});

Deno.test("creates a new page when the existing production item is locked", async () => {
  const api = notion();
  const result = await projectCreativeBriefToContentPipeline(brief as unknown as StoredCreativeBrief, { notion_page_id: "page-locked", production_status: "LOCKED", current_revision: 1 }, api);
  assertEquals(result.action, "CREATED");
  assertEquals(result.notion_page_id, "new-page");
});

Deno.test("maps Daily Intelligence creative status as system-owned properties", () => {
  const properties = dailyIntelligenceCreativeProperties({ status: "READY", revision: 2, contentPipelineUrl: "https://notion.test/new-page" });
  assertEquals(Object.keys(properties).sort(), ["Content Pipeline URL", "Creative Status", "Current Brief Revision"].sort());
  assertEquals(properties.Selected, undefined);
});
