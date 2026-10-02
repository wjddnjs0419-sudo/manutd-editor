import { MANUTD_EDITOR_STYLE_PROFILE } from "./manutd_editor.ts";
import type {
  ManutdEditorCarouselDraft,
  StyleValidationError,
  StyleValidationResult,
} from "./types.ts";

function add(errors: StyleValidationError[], code: StyleValidationError["code"], message: string, path?: string): void {
  errors.push({ code, message, ...(path ? { path } : {}) });
}

function publicCopy(draft: ManutdEditorCarouselDraft): string {
  return [
    ...draft.slides.flatMap((slide) => [slide.headline, slide.highlight, slide.body, slide.closing_line]),
    draft.caption.body,
    draft.caption.cta,
  ].filter((value): value is string => typeof value === "string").join("\n");
}

function hasHangul(value: string): boolean {
  return /[가-힣]/u.test(value);
}

function lines(value: string | null): string[] {
  return typeof value === "string" ? value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean) : [];
}

function numericTokens(value: string): Set<string> {
  return new Set((value.match(/\d+(?:[.,]\d+)?%?/gu) ?? []).map((token) => token.replaceAll(",", "").replace(/%$/u, "")));
}

function containsAny(value: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => value.includes(phrase));
}

type RumorStrength = 0 | 1 | 2 | 3;

function rumorStrength(value: string): RumorStrength {
  if (/(?:in talks|negotiat|official offer|made an offer|agreed|agreement|협상\s*(?:중|을 진행|을 시작)|제안(?:을|이)?\s*(?:보냈|준비)|영입에 나섰|공식 제안을 보냈)/iu.test(value)) return 3;
  if (/(?:consider(?:ing)?|contact is possible|explor(?:e|ing)|검토|접촉 가능|고려)/iu.test(value)) return 2;
  if (/(?:monitor(?:ing)?|watch(?:ing)?|interest(?:ed)?|linked|candidate|지켜보고|주시|관심|연결|후보)/iu.test(value)) return 1;
  return 0;
}

export function validateManutdEditorDraft(
  draft: ManutdEditorCarouselDraft,
  availableEvidenceIds: ReadonlySet<string>,
  groundingText = "",
): StyleValidationResult {
  const errors: StyleValidationError[] = [];

  if (draft.style_profile !== MANUTD_EDITOR_STYLE_PROFILE.name || draft.style_version !== MANUTD_EDITOR_STYLE_PROFILE.version) {
    add(errors, "STYLE_IDENTITY", "ManUtd Editor style identity/version is missing or invalid.");
  }
  if (!draft.story_id.trim()) add(errors, "STORY_ID_MISSING", "story_id is required.");

  const slideCount = draft.slides.length;
  if (slideCount < MANUTD_EDITOR_STYLE_PROFILE.default_slide_count.min || slideCount > MANUTD_EDITOR_STYLE_PROFILE.default_slide_count.max) {
    add(errors, "SLIDE_COUNT", "A completed ManUtd Editor carousel must contain three or four meaningful slides.", "slides");
  }

  const expectedRoles = slideCount === 4 ? MANUTD_EDITOR_STYLE_PROFILE.roles : MANUTD_EDITOR_STYLE_PROFILE.roles.slice(0, 3);
  draft.slides.forEach((slide, index) => {
    if (slide.index !== index + 1) add(errors, "SLIDE_INDEX", "Slide indexes must be sequential.", `slides[${index}].index`);
    if (slide.role !== expectedRoles[index]) add(errors, "ROLE_ORDER", "Slides must follow HOOK, CONTEXT, KEY_FACT, then optional IMPLICATION.", `slides[${index}].role`);
    if (!slide.headline.trim()) add(errors, "HEADLINE_EMPTY", "Every slide needs a headline.", `slides[${index}].headline`);
    if (slide.role === "HOOK" && slide.body?.trim()) add(errors, "HOOK_BODY_NOT_EMPTY", "HOOK slides should keep body copy empty.", `slides[${index}].body`);
    if (slide.role === "HOOK" && slide.closing_line?.trim()) add(errors, "HOOK_CLOSING_NOT_EMPTY", "HOOK slides should keep closing copy empty.", `slides[${index}].closing_line`);
    if (slide.role === "HOOK") {
      const mainLines = [...lines(slide.headline), ...lines(slide.highlight)];
      if (mainLines.length !== 2) add(errors, "HOOK_MAIN_LINES", "The first slide should contain exactly two short main-copy lines.", `slides[${index}]`);
      if (mainLines.some((line) => line.length > MANUTD_EDITOR_STYLE_PROFILE.max_hook_line_characters)) add(errors, "HOOK_LINE_TOO_LONG", "The first slide main-copy lines are too long.", `slides[${index}]`);
    }
    if ((slide.body?.length ?? 0) > MANUTD_EDITOR_STYLE_PROFILE.max_body_characters) add(errors, "BODY_TOO_LONG", "Body copy is too long for a visual slide.", `slides[${index}].body`);
    if (slide.role !== "HOOK" && lines(slide.body).length > MANUTD_EDITOR_STYLE_PROFILE.max_body_lines) add(errors, "BODY_TOO_MANY_LINES", "Body copy should use short visual lines or an additional slide.", `slides[${index}].body`);
    if (slide.evidence_ids.length === 0) add(errors, "EVIDENCE_MISSING", "Every public slide must reference grounded evidence.", `slides[${index}].evidence_ids`);
    for (const evidenceId of slide.evidence_ids) {
      if (!availableEvidenceIds.has(evidenceId)) add(errors, "EVIDENCE_ID_UNKNOWN", `Unknown evidence id: ${evidenceId}`, `slides[${index}].evidence_ids`);
    }
  });

  if (draft.caption.body.length + (draft.caption.cta?.length ?? 0) > MANUTD_EDITOR_STYLE_PROFILE.max_caption_characters) {
    add(errors, "CAPTION_TOO_LONG", "Caption is too long for the account style.", "caption");
  }

  const captionCopy = [draft.caption.body, draft.caption.cta].filter((value): value is string => typeof value === "string").join("\n");
  const hashtags = captionCopy.match(/#[^\s#]+/gu) ?? [];
  if (hashtags.length > MANUTD_EDITOR_STYLE_PROFILE.max_caption_hashtags) add(errors, "CAPTION_HASHTAG_LIMIT", "Caption hashtags must not exceed five.", "caption");
  if (!/[?？]/u.test(captionCopy)) add(errors, "CAPTION_QUESTION_MISSING", "Caption must end with or contain one easy fan question.", "caption");
  if (containsAny(captionCopy, MANUTD_EDITOR_STYLE_PROFILE.generic_caption_questions)) add(errors, "CAPTION_GENERIC_QUESTION", "Caption must use an easy specific engagement question.", "caption");
  if ((captionCopy.match(/습니다|습니까|십시오/gu) ?? []).length >= 2) add(errors, "CAPTION_FORMAL_STYLE", "Caption should not repeat formal honorific endings.", "caption");

  const copy = publicCopy(draft);
  if (!hasHangul(copy)) add(errors, "KOREAN_COPY_REQUIRED", "Public copy must be written in Korean.");
  for (const phrase of MANUTD_EDITOR_STYLE_PROFILE.forbidden_public_phrases) {
    if (copy.includes(phrase)) add(errors, "FORBIDDEN_PUBLIC_COPY", `Internal research language leaked into public copy: ${phrase}`);
  }
  if (containsAny(copy, MANUTD_EDITOR_STYLE_PROFILE.forbidden_hype_phrases)) add(errors, "HYPE_COPY", "Public copy contains prohibited hype language.");

  if (groundingText.trim()) {
    const evidenceNumbers = numericTokens(groundingText);
    for (const token of numericTokens(copy)) {
      if (!evidenceNumbers.has(token)) add(errors, "UNSUPPORTED_NUMBER", `Number is not present in frozen evidence: ${token}`);
    }

    const evidenceStrength = rumorStrength(groundingText);
    const copyStrength = rumorStrength(copy);
    if (evidenceStrength > 0 && copyStrength > evidenceStrength) add(errors, "RUMOR_STRENGTH", "Public transfer language is stronger than the frozen evidence.");
    if (evidenceStrength === 1 && copyStrength === 1 && !/(?:보도|알려졌|전해졌|거론|제기됐|이라는)/u.test(copy)) {
      add(errors, "RUMOR_ATTRIBUTION", "Weak transfer reports need clear attribution or uncertainty language.");
    }
  }

  return { valid: errors.length === 0, errors };
}

export { MANUTD_EDITOR_STYLE_PROFILE } from "./manutd_editor.ts";
export type { ManutdEditorCarouselDraft } from "./types.ts";
