import type { ManutdEditorStyleProfile } from "./types.ts";

export const MANUTD_EDITOR_STYLE_PROFILE: ManutdEditorStyleProfile = {
  name: "manutd_editor",
  version: "manutd-editor-v1",
  language: "ko",
  default_slide_count: { min: 3, max: 4 },
  roles: ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION"],
  max_caption_characters: 500,
  max_body_characters: 280,
  forbidden_public_phrases: [
    "현재 확보된 자료",
    "제공된 정보",
    "자료가 부족",
    "확인할 수 없습니다",
    "구체적인 내용은 확인할 수 없습니다",
  ],
};

export const MANUTD_EDITOR_STYLE_INSTRUCTIONS = [
  "Style profile: manutd_editor, version manutd-editor-v1.",
  "Write concise, direct Korean for football fans. Lead with the current situation, useful numbers, contrast, or a meaningful change.",
  "Use a strong but supported hook; avoid academic/report prose, repeated formal sentence endings, invented cause and effect, fake quotes, speculation, and filler.",
  "Build three or four meaningful slides in this order: HOOK, CONTEXT, KEY_FACT, optional IMPLICATION.",
  "HOOK uses one or two headline lines and an optional highlight; keep its body empty. Body copy uses short visual lines, normally two to five lines.",
  "Keep public slide copy separate from internal grounding, source caveats, unsupported claims, and research limitations. Put those only in editor_warning or internal_grounding.",
  "Preserve attribution when a fact is reported, disputed, or single-source, but do not repeat outlet names unnecessarily.",
].join("\n");
