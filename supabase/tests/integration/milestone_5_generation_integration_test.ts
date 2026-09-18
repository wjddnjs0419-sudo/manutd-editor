import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.8";
import { classifyDeterministically } from "../../functions/creative-generation/classifier.ts";
import { validateGenerationConfig } from "../../functions/creative-generation/config.ts";
import { buildEvidenceSnapshot } from "../../functions/creative-generation/evidence.ts";
import { generateWithOneRepair, validateCreativeBrief } from "../../functions/creative-generation/quality_gate.ts";
import { projectCreativeBriefToContentPipeline } from "../../functions/creative-generation/notion_projection.ts";
import type { CreativeBriefOutput } from "../../functions/creative-generation/types.ts";
import type { StoredCreativeBrief } from "../../functions/creative-generation/repository.ts";

const config = validateGenerationConfig({
  id: "config-1", version: "m5-v1",
  classifier_config: {
    version: "classifier-v1", model: "gpt-5.6-luna", reasoning: "low", confidence_threshold: 0.75,
    keywords: { match: ["goal", "lineup"], news: ["injury", "transfer"], analysis: ["tactical", "stats"] },
    phase_keywords: { PRE_MATCH: ["lineup"], LIVE: ["goal"], POST_MATCH: ["full time"] },
  },
  generation_config: { model: "gpt-5.6-terra", reasoning: "medium", max_output_tokens: 5000 },
  mode_configs: {
    NEWS_UPDATE: { evidence_policy: "STRICT", prompt_version: "news-v1" },
    ANALYSIS_CONTEXT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "analysis-v1" },
    MATCH_CONTENT: { evidence_policy: "PARTIAL_ALLOWED", prompt_version: "match-v1" },
  },
  quality_gate_config: { min_slides: 4, max_slides: 7, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true },
});

const evidenceInput = {
  candidate: { id: "candidate-1", story_cluster_id: "cluster-1", ranking_date: "2026-09-18", rank: 1, priority_score: 90, data_confidence: 90, first_mover_flag: true, must_cover_flag: false, korea_coverage_status: "KNOWN" as const, score_version: "v1", score_inputs: { global_coverage: 0.8 } },
  story: { id: "cluster-1", canonical_title: "United tactical story", status: "ACTIVE", first_seen_at: "2026-09-18T08:00:00Z", last_seen_at: "2026-09-18T09:00:00Z" },
  posts: [{ raw_post_id: "post-1", source_account_id: "account-1", account_username: "utdreport", region: "GLOBAL" as const, caption: "United tactical story", permalink: "https://test/post-1", published_at: "2026-09-18T09:00:00Z", media_type: "IMAGE" as const }],
  sources: [],
};

function output(mode: CreativeBriefOutput["content_mode"]): CreativeBriefOutput {
  return {
    schema_version: "1.0", content_mode: mode, match_phase: mode === "MATCH_CONTENT" ? "LIVE" : null, generation_quality: "FULL", angle: "Evidence-backed angle", key_takeaway: "Evidence-backed takeaway",
    hooks: [1, 2, 3].map((id) => ({ id: `hook_${id}`, text: `Hook ${id}` })),
    slides: Array.from({ length: 4 }, (_, index) => ({ slide_number: index + 1, purpose: index === 0 ? "HOOK" : "DETAIL", headline: `Headline ${index + 1}`, body: `Body ${index + 1}`, claims: [{ claim_id: `claim_${index + 1}`, type: "FACT" as const, text: "Evidence-backed fact", evidence_ids: ["post:post-1"] }], visual_direction: { subject: "United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline"] } })),
    caption: { body: "Caption", cta: "Tell us" }, sources: [{ evidence_id: "post:post-1", label: "utdreport" }],
  };
}

function brief(): StoredCreativeBrief {
  const value = output("ANALYSIS_CONTEXT");
  return { id: "brief-1", candidate_id: "candidate-1", version: 2, headline: value.hooks[0]!.text, angle: value.angle, format: "INSTAGRAM_CAROUSEL", slide_count: 4, slides_json: { slides: value.slides, key_takeaway: value.key_takeaway }, design_json: { slides: value.slides.map((slide) => ({ slide_number: slide.slide_number, visual_direction: slide.visual_direction })) }, caption_draft: value.caption.body, cta: value.caption.cta, status: "READY", content_mode: value.content_mode, match_phase: value.match_phase, generation_config_id: "config-1", input_fingerprint: "fingerprint", evidence_snapshot: buildEvidenceSnapshot(evidenceInput), hooks_json: value.hooks, grounding_json: { claims: value.slides.flatMap((slide) => slide.claims) }, generation_metadata: {}, generation_quality: value.generation_quality, model_name: "gpt-5.6-terra", generated_at: "2026-09-18T10:00:00Z" };
}

Deno.test("covers all deterministic modes and phases", () => {
  assertEquals(classifyDeterministically("Manchester United confirmed the lineup", config.classifier_config).content_mode, "MATCH_CONTENT");
  assertEquals(classifyDeterministically("The manager explains the tactical setup", config.classifier_config).content_mode, "ANALYSIS_CONTEXT");
  assertEquals(classifyDeterministically("United injury update", config.classifier_config).content_mode, "NEWS_UPDATE");
  assertEquals(classifyDeterministically("United scored a goal", config.classifier_config).match_phase, "LIVE");
});

Deno.test("covers grounding, one-shot repair, and evidence immutability", async () => {
  const snapshot = buildEvidenceSnapshot(evidenceInput);
  const valid = output("ANALYSIS_CONTEXT");
  const quality = { min_slides: 4, max_slides: 7, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true };
  assertEquals(validateCreativeBrief(valid, snapshot, quality).valid, true);
  let repairs = 0;
  const repaired = await generateWithOneRepair({ repair: async () => { repairs += 1; return valid; } }, { ...valid, hooks: [] }, { content_mode: "ANALYSIS_CONTEXT", match_phase: null, evidence_snapshot: snapshot }, snapshot, quality);
  assertEquals(repaired.ok, true);
  assertEquals(repairs, 1);
  assertNotEquals(JSON.stringify(snapshot), "");
});

Deno.test("covers editable update and locked/approved create-new branching", async () => {
  const calls: string[] = [];
  const notion = { createPage: async () => { calls.push("create"); return { id: "new-page", url: "https://notion.test/new" }; }, updatePage: async () => { calls.push("update"); return { id: "page-1", url: "https://notion.test/page-1" }; }, appendBlockChildren: async () => { calls.push("append"); return { id: "page-1" }; } };
  assertEquals((await projectCreativeBriefToContentPipeline(brief(), { notion_page_id: "page-1", production_status: "EDITABLE", current_revision: 1 }, notion)).action, "UPDATED");
  assertEquals(calls, ["update", "append"]);
  calls.length = 0;
  assertEquals((await projectCreativeBriefToContentPipeline(brief(), { notion_page_id: "page-1", production_status: "APPROVED", current_revision: 1 }, notion)).action, "CREATED");
  assertEquals(calls, ["create"]);
  assert(!JSON.stringify(brief()).includes("sk-"));
});
