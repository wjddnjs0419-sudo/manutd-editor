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

