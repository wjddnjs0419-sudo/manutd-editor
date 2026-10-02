export type EditorialSlideRole = "HOOK" | "CONTEXT" | "KEY_FACT" | "IMPLICATION";

export interface EditorialSlide {
  index: number;
  role: EditorialSlideRole;
  headline: string;
  highlight: string | null;
  body: string | null;
  closing_line: string | null;
  evidence_ids: string[];
}

export interface EditorialCaption {
  body: string;
  cta: string | null;
}

export interface EditorialInternalGrounding {
  evidence_ids: string[];
  source_caveats: string[];
  unsupported_claims: string[];
}

export interface ManutdEditorCarouselDraft {
  style_profile: string;
  style_version: string;
  story_id: string;
  creative_brief_id: string | null;
  slides: EditorialSlide[];
  caption: EditorialCaption;
  editor_warning: string | null;
  internal_grounding: EditorialInternalGrounding;
}

export interface ManutdEditorStyleProfile {
  name: "manutd_editor";
  version: "manutd-editor-v1";
  language: "ko";
  default_slide_count: { min: 3; max: 4 };
  roles: readonly EditorialSlideRole[];
  max_hook_line_characters: number;
  max_body_lines: number;
  max_caption_characters: number;
  max_caption_hashtags: number;
  max_body_characters: number;
  forbidden_public_phrases: readonly string[];
  forbidden_hype_phrases: readonly string[];
  generic_caption_questions: readonly string[];
}

export type StyleValidationErrorCode =
  | "STYLE_IDENTITY"
  | "STORY_ID_MISSING"
  | "SLIDE_COUNT"
  | "SLIDE_INDEX"
  | "ROLE_ORDER"
  | "HEADLINE_EMPTY"
  | "HOOK_BODY_NOT_EMPTY"
  | "HOOK_CLOSING_NOT_EMPTY"
  | "HOOK_MAIN_LINES"
  | "HOOK_LINE_TOO_LONG"
  | "BODY_TOO_LONG"
  | "BODY_TOO_MANY_LINES"
  | "KOREAN_COPY_REQUIRED"
  | "FORBIDDEN_PUBLIC_COPY"
  | "HYPE_COPY"
  | "CAPTION_TOO_LONG"
  | "CAPTION_HASHTAG_LIMIT"
  | "CAPTION_QUESTION_MISSING"
  | "CAPTION_GENERIC_QUESTION"
  | "CAPTION_FORMAL_STYLE"
  | "UNSUPPORTED_NUMBER"
  | "RUMOR_STRENGTH"
  | "RUMOR_ATTRIBUTION"
  | "EVIDENCE_ID_UNKNOWN"
  | "EVIDENCE_MISSING";

export interface StyleValidationError {
  code: StyleValidationErrorCode;
  message: string;
  path?: string;
}

export interface StyleValidationResult {
  valid: boolean;
  errors: StyleValidationError[];
}
