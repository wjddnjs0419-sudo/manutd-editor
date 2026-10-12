import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import * as qualityGate from "../../creative-generation/quality_gate.ts";
import type { EvidenceSnapshot, CreativeBriefOutput } from "../../creative-generation/types.ts";
import type { QualityGateConfig } from "../../creative-generation/quality_gate.ts";

const articleId = "article:observation-1";
const evidence: EvidenceSnapshot = {
  schema_version: "1.0",
  candidate: { story_cluster_id: "cluster-1" } as EvidenceSnapshot["candidate"],
  story: { id: "cluster-1", canonical_title: "맨유 이적설", status: "ACTIVE", first_seen_at: "2026-10-12T08:00:00Z", last_seen_at: "2026-10-12T09:00:00Z" },
  posts: [],
  sources: [],
  exploration_articles: [{
    evidence_id: articleId,
    source_observation_id: "observation-1",
    publisher_name: "BBC Sport",
    canonical_url: "https://bbc.test/article/1",
    published_at: "2026-10-12T08:00:00Z",
    extraction_status: "EXTRACTED",
    article_text: "BBC Sport reports Manchester United are considering a move, but no deal has been agreed. This remains an unconfirmed report from the outlet. " + "The publisher says discussions remain preliminary and does not report an agreement. ".repeat(5),
    content_fingerprint: "fingerprint-1",
    modality: "RUMOR",
    verified: false,
  }],
  score_evidence: {},
  evidence_ids: [articleId],
};

const config: QualityGateConfig = { min_slides: 3, max_slides: 5, hook_count: 3, max_repair_attempts: 1, require_visual_direction: true };

function validExplorationOutput(overrides: Partial<CreativeBriefOutput> = {}): CreativeBriefOutput {
  const report = "BBC Sport 보도에 따르면 맨유의 관심은 아직 루머 단계이며 영입이 확정된 것은 아닙니다.";
  return {
    schema_version: "1.0",
    content_mode: "NEWS_UPDATE",
    match_phase: null,
    generation_quality: "FULL",
    angle: "맨유 관심 보도",
    key_takeaway: report,
    hooks: [1, 2, 3].map((id) => ({ id: `hook-${id}`, text: `BBC Sport 보도: 맨유 관심은 아직 루머 ${id}` })),
    slides: Array.from({ length: 3 }, (_, index) => ({
      slide_number: index + 1,
      purpose: index === 0 ? "HOOK" : "DETAIL",
      headline: `BBC Sport 보도: 맨유 관심은 아직 루머 ${index + 1}`,
      body: `${report} https://bbc.test/article/1`,
      claims: [{ claim_id: `claim-${index + 1}`, type: "FACT" as const, text: report, evidence_ids: [articleId] }],
      visual_direction: { subject: "Manchester United", image_type: "photo", layout_intent: "clear", stat_emphasis: null, text_hierarchy: ["headline", "body"] },
    })),
    caption: { body: `${report} https://bbc.test/article/1 #ManUtd #MUFC`, cta: "의견을 남겨주세요" },
    sources: [{ evidence_id: articleId, label: "BBC Sport", url: "https://bbc.test/article/1" }],
    editor_warning: "미승인 출처 보도입니다. 원문과 사실을 편집자가 확인해야 합니다.",
    ...overrides,
  };
}

Deno.test("Exploration DRAFT quality gate accepts attributed 3–5 slide briefs without VERIFIED evidence", () => {
  const validateExplorationDraft = (qualityGate as unknown as { validateExplorationDraft?: (value: unknown, evidence: EvidenceSnapshot, config: QualityGateConfig, now?: Date) => { valid: boolean; errors: readonly { code: string }[] } }).validateExplorationDraft;
  assertEquals(typeof validateExplorationDraft, "function");
  const result = validateExplorationDraft!(validExplorationOutput(), evidence, config, new Date("2026-10-12T10:00:00Z"));
  assertEquals(result.errors, []);
  assertEquals(result.valid, true);
});

Deno.test("Exploration DRAFT rejects certainty that overrides an article rumor", () => {
  const validateExplorationDraft = (qualityGate as unknown as { validateExplorationDraft?: (value: unknown, evidence: EvidenceSnapshot, config: QualityGateConfig, now?: Date) => { valid: boolean; errors: readonly { code: string }[] } }).validateExplorationDraft;
  assertEquals(typeof validateExplorationDraft, "function");
  const output = validExplorationOutput({
    slides: validExplorationOutput().slides.map((slide) => ({
      ...slide,
      headline: "맨유, 영입 확정",
      body: "맨유가 영입을 확정했습니다.",
      claims: [{ ...slide.claims[0]!, text: "맨유가 영입을 확정했습니다." }],
    })),
    caption: { body: "맨유가 영입을 확정했습니다.", cta: "의견을 남겨주세요" },
  });
  const result = validateExplorationDraft!(output, evidence, config, new Date("2026-10-12T10:00:00Z"));
  assertEquals(result.valid, false);
  assert(result.errors.some((entry) => entry.code === "EXPLORATION_MODALITY_OVERRIDDEN"));
});

Deno.test("Exploration DRAFT enforces at most five hashtags", () => {
  const validateExplorationDraft = (qualityGate as unknown as { validateExplorationDraft?: (value: unknown, evidence: EvidenceSnapshot, config: QualityGateConfig, now?: Date) => { valid: boolean; errors: readonly { code: string }[] } }).validateExplorationDraft;
  assertEquals(typeof validateExplorationDraft, "function");
  const output = validExplorationOutput({ caption: { body: "BBC Sport 보도에 따르면 루머입니다. https://bbc.test/article/1 #1 #2 #3 #4 #5 #6", cta: "의견" } });
  const result = validateExplorationDraft!(output, evidence, config, new Date("2026-10-12T10:00:00Z"));
  assert(result.errors.some((entry) => entry.code === "EXPLORATION_HASHTAG_LIMIT"));
});
