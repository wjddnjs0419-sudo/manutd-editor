import type { ManutdEditorStyleProfile } from "./types.ts";

export const MANUTD_EDITOR_STYLE_PROFILE: ManutdEditorStyleProfile = {
  name: "manutd_editor",
  version: "manutd-editor-v1",
  language: "ko",
  default_slide_count: { min: 3, max: 4 },
  roles: ["HOOK", "CONTEXT", "KEY_FACT", "IMPLICATION"],
  max_hook_line_characters: 40,
  max_body_lines: 5,
  max_caption_characters: 500,
  max_caption_hashtags: 5,
  max_body_characters: 280,
  forbidden_public_phrases: [
    "현재 확보된 자료",
    "제공된 정보",
    "자료가 부족",
    "확인할 수 없습니다",
    "구체적인 내용은 확인할 수 없습니다",
  ],
  forbidden_hype_phrases: [
    "충격",
    "역대급",
    "초대형",
    "대반전",
    "팬들을 놀라게 했다",
    "관심이 집중되고 있다",
    "귀추가 주목된다",
    "향후 행보가 주목된다",
    "어떤 선택을 내릴지 지켜봐야 한다",
    "축구팬들의 이목을 끌고 있다",
  ],
  generic_caption_questions: [
    "여러분의 생각은 어떠신가요?",
    "여러분의 생각은?",
  ],
};

export const MANUTD_EDITOR_STYLE_INSTRUCTIONS = [
  "Style profile: manutd_editor, version manutd-editor-v1.",
  "Write concise, direct Korean for football fans: friendly and easy to scan, credible without sounding like a formal news wire or a football-community meme.",
  "Page 1: output exactly two short main-copy lines using headline and highlight; keep body and closing_line empty. Keep each line under 40 characters when possible and reveal the player/event immediately.",
  "Later slides: use one main message per slide in WHAT HAPPENED, KEY EVIDENCE or NUMBER, then WHAT IT MEANS FOR MANCHESTER UNITED. Add a slide instead of compressing a dense paragraph.",
  "Use short direct endings such as 했다, 중이다, 로 알려졌다, 가능성이 있다, 라는 보도가 나왔다, 지켜보고 있다, and 연결되고 있다. Avoid repeated formal honorific endings, academic/report prose, fake quotes, speculation, and filler.",
  "Build three or four meaningful slides in this order: HOOK, CONTEXT, KEY_FACT, optional IMPLICATION.",
  "HOOK uses exactly two short main-copy lines and no explanatory paragraph. Body copy uses short visual lines, normally no more than five lines.",
  "Rumor strength must never be increased: monitoring/interest/linked/candidate stays weak; considering/contact stays medium; talks/negotiation/offer stays strong only when the evidence is strong. Preserve attribution for reported or unconfirmed claims. Never strengthen the source claim.",
  "Use concrete numbers only when they appear in the frozen evidence. Never invent numbers, appearances, fees, contract lengths, injury durations, ages, minutes, or statistics.",
  "Caption: write one or two short core-news sentences, one current-situation sentence, one easy fan question, and maximum five hashtags that are relevant. Never default to 여러분의 생각은 어떠신가요?.",
  "All hook alternatives and revisions must preserve the same concise tone, page-one shape, evidence strength, and caption rules.",
  "Keep public slide copy separate from internal grounding, source caveats, unsupported claims, and research limitations. Put those only in editor_warning or internal_grounding.",
  "Preserve attribution when a fact is reported, disputed, or single-source, but do not repeat outlet names unnecessarily.",
].join("\n");

export const MANUTD_EDITOR_REVISION_INSTRUCTIONS = [
  "Apply the canonical ManUtd Editor card-news style to this revision.",
  MANUTD_EDITOR_STYLE_INSTRUCTIONS,
].join("\n");
