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

export function validateManutdEditorDraft(
  draft: ManutdEditorCarouselDraft,
  availableEvidenceIds: ReadonlySet<string>,
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
    if ((slide.body?.length ?? 0) > MANUTD_EDITOR_STYLE_PROFILE.max_body_characters) add(errors, "BODY_TOO_LONG", "Body copy is too long for a visual slide.", `slides[${index}].body`);
    if (slide.evidence_ids.length === 0) add(errors, "EVIDENCE_MISSING", "Every public slide must reference grounded evidence.", `slides[${index}].evidence_ids`);
    for (const evidenceId of slide.evidence_ids) {
      if (!availableEvidenceIds.has(evidenceId)) add(errors, "EVIDENCE_ID_UNKNOWN", `Unknown evidence id: ${evidenceId}`, `slides[${index}].evidence_ids`);
    }
  });

  if (draft.caption.body.length + (draft.caption.cta?.length ?? 0) > MANUTD_EDITOR_STYLE_PROFILE.max_caption_characters) {
    add(errors, "CAPTION_TOO_LONG", "Caption is too long for the account style.", "caption");
  }

  const copy = publicCopy(draft);
  if (!hasHangul(copy)) add(errors, "KOREAN_COPY_REQUIRED", "Public copy must be written in Korean.");
  for (const phrase of MANUTD_EDITOR_STYLE_PROFILE.forbidden_public_phrases) {
    if (copy.includes(phrase)) add(errors, "FORBIDDEN_PUBLIC_COPY", `Internal research language leaked into public copy: ${phrase}`);
  }

  return { valid: errors.length === 0, errors };
}

export { MANUTD_EDITOR_STYLE_PROFILE } from "./manutd_editor.ts";
export type { ManutdEditorCarouselDraft } from "./types.ts";

