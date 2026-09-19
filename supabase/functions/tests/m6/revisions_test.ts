import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import { reviseCaption, reviseSlide, selectHook } from "../../_shared/m6/revisions.ts";
import type { StoredCreativeBrief } from "../../creative-generation/repository.ts";
import type { CreativeBriefSlide } from "../../creative-generation/types.ts";

const evidence = {
  schema_version: "1.0" as const,
  candidate: { id: "candidate-1", story_cluster_id: "cluster-1", ranking_date: "2026-09-19", rank: 1, priority_score: 88, data_confidence: 0.9, first_mover_flag: true, must_cover_flag: false, korea_coverage_status: "KNOWN" as const, score_version: "v1", score_inputs: {} },
  story: { id: "story-1", canonical_title: "Mainoo", status: "ACTIVE", first_seen_at: "2026-09-19T00:00:00Z", last_seen_at: "2026-09-19T01:00:00Z" },
  posts: [], sources: [{ evidence_id: "source:1", source_id: "source-1", canonical_name: "United", entity_type: "CLUB", reliability_score: 9, evidence_text: "confirmed", first_cited_post_id: null, citation_count: 1 }], score_evidence: {}, evidence_ids: ["source:1"],
};
const slide = (number: number): CreativeBriefSlide => ({ slide_number: number, purpose: `purpose-${number}`, headline: `headline-${number}`, body: `body-${number}`, claims: [{ claim_id: `claim-${number}`, type: "FACT", text: "확인된 사실", evidence_ids: ["source:1"] }], visual_direction: { subject: "player", image_type: "photo", layout_intent: "clean", stat_emphasis: null, text_hierarchy: ["headline"] } });
const base: StoredCreativeBrief = { id: "brief-3", candidate_id: "candidate-1", version: 3, headline: "Hook 1", angle: "각도", format: "INSTAGRAM_CAROUSEL", slide_count: 3, slides_json: { slides: [slide(1), slide(2), slide(3)], key_takeaway: "takeaway" }, design_json: { slides: [] }, caption_draft: "caption", cta: "더 알아보기", status: "READY", content_mode: "NEWS_UPDATE", match_phase: null, generation_config_id: "config", input_fingerprint: "fingerprint", evidence_snapshot: evidence, hooks_json: [{ id: "h1", text: "Hook 1" }, { id: "h2", text: "Hook 2" }, { id: "h3", text: "Hook 3" }], grounding_json: {}, generation_metadata: {}, generation_quality: "FULL", model_name: "test", generated_at: "2026-09-19T00:00:00Z" };
const deps = { qualityConfig: { min_slides: 3, max_slides: 7, hook_count: 3, max_repair_attempts: 0, require_visual_direction: true }, idFactory: () => "brief-4" };

Deno.test("selectHook creates revision 4 and leaves base byte-equivalent", async () => {
  const before = structuredClone(base);
  const revised = await selectHook(base, 2, deps);
  assertEquals(revised.version, 4);
  assertEquals(revised.headline, "Hook 2");
  assertEquals(revised.status, "DRAFT");
  assertEquals(revised.evidence_snapshot, base.evidence_snapshot);
  assertEquals(base, before);
  assertNotEquals(revised.id, base.id);
});

Deno.test("slide and caption revisions change only their targeted fields", async () => {
  const nextSlide = await reviseSlide(base, 3, "더 짧게", { ...deps, reviseSlide: async () => ({ ...slide(3), headline: "새 제목" }) });
  assertEquals((nextSlide.slides_json.slides as CreativeBriefSlide[])[2].headline, "새 제목");
  assertEquals((nextSlide.slides_json.slides as CreativeBriefSlide[])[0], (base.slides_json.slides as CreativeBriefSlide[])[0]);
  const nextCaption = await reviseCaption(base, "덜 자극적으로", { ...deps, reviseCaption: async () => ({ body: "새 캡션", cta: "확인하기" }) });
  assertEquals(nextCaption.caption_draft, "새 캡션");
  assertEquals(nextCaption.cta, "확인하기");
  assertEquals(nextCaption.angle, base.angle);
});

Deno.test("revision rejects unknown evidence and ungrounded fact claims", async () => {
  await assertRejects(() => reviseSlide(base, 1, "bad", { ...deps, reviseSlide: async () => ({ ...slide(1), claims: [{ ...slide(1).claims[0], evidence_ids: ["source:unknown"] }] }) }), Error, "REVISION_INVALID");
});
