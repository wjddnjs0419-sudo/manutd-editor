import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1.0.8";
import {
  MANUTD_EDITOR_STYLE_PROFILE,
  validateManutdEditorDraft,
  type ManutdEditorCarouselDraft,
} from "../../_shared/editorial-style/validator.ts";
import { MANUTD_EDITOR_GOLDEN_EXAMPLES } from "../../_shared/editorial-style/golden_examples.ts";

function draft(overrides: Partial<ManutdEditorCarouselDraft> = {}): ManutdEditorCarouselDraft {
  return {
    style_profile: "manutd_editor",
    style_version: "manutd-editor-v1",
    story_id: "story-sancho",
    creative_brief_id: "brief-1",
    slides: [
      { index: 1, role: "HOOK", headline: "3개월째 소속팀 없는 산초", highlight: "10부 리그에서 개인 훈련 중", body: null, closing_line: null, evidence_ids: ["source:bbc"] },
      { index: 2, role: "CONTEXT", headline: "자유 계약만 3개월째", highlight: null, body: "맨유와 계약이 끝난 뒤\n아직 새 소속팀을 찾지 못하고 있다.", closing_line: null, evidence_ids: ["source:bbc"] },
      { index: 3, role: "KEY_FACT", headline: "10부리그 훈련장", highlight: "Flixton FC", body: "현재는 잉글랜드 10부리그 시설에서\n몸 상태를 유지하고 있는 것으로 알려졌다.", closing_line: null, evidence_ids: ["source:bbc"] },
    ],
    caption: { body: "산초의 다음 행선지는 어디일까요?", cta: "여러분의 생각을 남겨주세요." },
    editor_warning: null,
    internal_grounding: { evidence_ids: ["source:bbc"], source_caveats: [], unsupported_claims: [] },
    ...overrides,
  };
}

Deno.test("exposes the versioned ManUtd Editor style identity", () => {
  assertEquals(MANUTD_EDITOR_STYLE_PROFILE.name, "manutd_editor");
  assertEquals(MANUTD_EDITOR_STYLE_PROFILE.version, "manutd-editor-v1");
  assertEquals(MANUTD_EDITOR_STYLE_PROFILE.default_slide_count, { min: 3, max: 4 });
});

Deno.test("accepts a grounded three-slide Korean editorial carousel", () => {
  const result = validateManutdEditorDraft(draft(), new Set(["source:bbc"]));
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("accepts an optional grounded implication slide", () => {
  const value = draft({ slides: [
    ...draft().slides,
    { index: 4, role: "IMPLICATION", headline: "다음 팀은 어디일까", highlight: null, body: "새 팀을 찾는 시간이 길어지고 있다.", closing_line: "산초의 다음 선택이 남았다.", evidence_ids: ["source:bbc"] },
  ] });
  assertEquals(validateManutdEditorDraft(value, new Set(["source:bbc"])).valid, true);
});

Deno.test("rejects internal research language from public copy", () => {
  const value = draft({ slides: [{ ...draft().slides[0]!, headline: "현재 확보된 자료에는 전술 문제가 없습니다." }, ...draft().slides.slice(1)] });
  const result = validateManutdEditorDraft(value, new Set(["source:bbc"]));
  assertFalse(result.valid);
  assert(result.errors.some((error) => error.code === "FORBIDDEN_PUBLIC_COPY"));
});

Deno.test("rejects invalid role order, empty headlines, and unknown evidence", () => {
  const value = draft({ slides: [
    { ...draft().slides[0]!, index: 1, role: "CONTEXT", headline: "", evidence_ids: ["source:missing"] },
    ...draft().slides.slice(1),
  ] });
  const result = validateManutdEditorDraft(value, new Set(["source:bbc"]));
  assert(result.errors.some((error) => error.code === "ROLE_ORDER"));
  assert(result.errors.some((error) => error.code === "HEADLINE_EMPTY"));
  assert(result.errors.some((error) => error.code === "EVIDENCE_ID_UNKNOWN"));
});

Deno.test("rejects filler-length carousels and overly long caption copy", () => {
  const value = draft({
    slides: [...draft().slides, { index: 4, role: "IMPLICATION", headline: "추가 정보", highlight: null, body: "더 많은 자료가 필요합니다.", closing_line: null, evidence_ids: ["source:bbc"] }, { index: 5, role: "IMPLICATION", headline: "또 다른 정보", highlight: null, body: "더 많은 자료가 필요합니다.", closing_line: null, evidence_ids: ["source:bbc"] }],
    caption: { body: "가".repeat(501), cta: null },
  });
  const result = validateManutdEditorDraft(value, new Set(["source:bbc"]));
  assert(result.errors.some((error) => error.code === "SLIDE_COUNT"));
  assert(result.errors.some((error) => error.code === "CAPTION_TOO_LONG"));
});

Deno.test("keeps golden examples isolated as style references", () => {
  assertEquals(MANUTD_EDITOR_GOLDEN_EXAMPLES.length, 2);
  assert(MANUTD_EDITOR_GOLDEN_EXAMPLES.every((example) => example.style_only));
  assert(MANUTD_EDITOR_GOLDEN_EXAMPLES.every((example) => example.generation_evidence_ids.length === 0));
  assert(MANUTD_EDITOR_GOLDEN_EXAMPLES.some((example) => example.slug === "sancho"));
  assert(MANUTD_EDITOR_GOLDEN_EXAMPLES.some((example) => example.slug === "garnacho"));
});
