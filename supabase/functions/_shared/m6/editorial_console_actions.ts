import {
  callbackData,
  renderAllStoryList,
  renderCarouselDraft,
  renderEvidenceView,
  renderRecommendedList,
  renderStoryDetail,
  renderTextReel,
  type CanonicalStory,
  type ConsoleView,
  type StoryPage,
} from "./editorial_console.ts";
import type { ManutdEditorCarouselDraft } from "../editorial-style/types.ts";

export type ConsoleAction =
  | { type: "OPEN_RECOMMENDED"; page: number }
  | { type: "OPEN_ALL"; page: number }
  | { type: "NEXT_PAGE" }
  | { type: "OPEN_STORY"; token: string }
  | { type: "OPEN_EVIDENCE"; token: string }
  | { type: "SKIP_STORY"; token: string }
  | { type: "GENERATE_CAROUSEL"; token: string | null }
  | { type: "OPEN_REEL"; token: string }
  | { type: "SELECT_DRAFT"; token: string }
  | { type: "SHOW_ALTERNATE_HOOKS"; token: string }
  | { type: "EDIT_DRAFT"; token: string }
  | { type: "BACK" };

export interface ConsoleState {
  view: "HOME" | "LIST" | "DETAIL" | "EVIDENCE" | "REEL" | "DRAFT";
  mode: "recommended" | "all" | null;
  page: number;
  story_id: string | null;
  story_fingerprint: string | null;
  brief_id: string | null;
  telegram_message_id: number | null;
  state_version: number;
}

export interface ConsoleEvent {
  action: string;
  status: "COMPLETED" | "FAILED" | "STALE";
  metadata?: Record<string, unknown>;
}

export interface ConsoleActionResult {
  view: ConsoleView;
  next_state: ConsoleState;
  event: ConsoleEvent;
}

export interface ConsoleActionDependencies {
  listStories: (mode: "recommended" | "all", page: number) => Promise<StoryPage>;
  getStoryByToken: (token: string) => Promise<CanonicalStory | null>;
  skipStory: (story: CanonicalStory) => Promise<void>;
  generateCarousel: (story: CanonicalStory) => Promise<ManutdEditorCarouselDraft>;
  selectDraft: (briefId: string) => Promise<void>;
}

type ParsedCallback = Exclude<ConsoleAction, { type: "NEXT_PAGE" | "BACK" }> | { type: "BACK" };

function positivePage(value: string): number | null {
  const page = Number(value);
  return Number.isInteger(page) && page > 0 && page <= 999 ? page : null;
}

export function parseConsoleCallback(value: string): ParsedCallback | null {
  const recommended = /^ideas:recommended:(\d{1,3})$/u.exec(value);
  if (recommended) {
    const page = positivePage(recommended[1]!);
    return page ? { type: "OPEN_RECOMMENDED", page } : null;
  }
  const all = /^ideas:all:(\d{1,3})$/u.exec(value);
  if (all) {
    const page = positivePage(all[1]!);
    return page ? { type: "OPEN_ALL", page } : null;
  }
  const idea = /^idea:(open|evidence|skip|reel|carousel):([A-Za-z0-9_-]{1,32})$/u.exec(value);
  if (idea) {
    const map = { open: "OPEN_STORY", evidence: "OPEN_EVIDENCE", skip: "SKIP_STORY", reel: "OPEN_REEL", carousel: "GENERATE_CAROUSEL" } as const;
    return { type: map[idea[1] as keyof typeof map], token: idea[2]! } as ParsedCallback;
  }
  if (value === "idea:back:list" || value === "draft:back:list") return { type: "BACK" };
  const draft = /^draft:(rehook|approve|edit|evidence):([A-Za-z0-9_-]{1,32})$/u.exec(value);
  if (draft) {
    const map = { rehook: "SHOW_ALTERNATE_HOOKS", approve: "SELECT_DRAFT", edit: "EDIT_DRAFT", evidence: "OPEN_EVIDENCE" } as const;
    return { type: map[draft[1] as keyof typeof map], token: draft[2]! } as ParsedCallback;
  }
  return null;
}

export function parseConsoleIntent(value: string, activeStoryToken?: string | null): ConsoleAction | null {
  const normalized = value.trim().toLocaleLowerCase("ko-KR").replace(/\s+/gu, " ");
  if (/^(\/today|오늘 뭐 있어\??|오늘 올릴 거 보여줘|추천 소재)$/u.test(normalized)) return { type: "OPEN_RECOMMENDED", page: 1 };
  if (/^(전체 수집한 거 보여줘|전체 소재|전체 수집본)$/u.test(normalized)) return { type: "OPEN_ALL", page: 1 };
  if (normalized === "다음 거 보여줘") return { type: "NEXT_PAGE" };
  if (/^이거 카드뉴스로 (?:만들어줘|만들거야|만들어야)$/u.test(normalized)) return { type: "GENERATE_CAROUSEL", token: activeStoryToken ?? null };
  return null;
}

function safeError(message: string, state: ConsoleState, action: string): ConsoleActionResult {
  return { view: { text: `⚠️ ${message}`, inline_keyboard: [[{ text: "◀ 돌아가기", callback_data: "idea:back:list" }]] }, next_state: state, event: { action, status: "FAILED" } };
}

function listState(state: ConsoleState, mode: "recommended" | "all", page: number): ConsoleState {
  return { ...state, view: "LIST", mode, page, story_id: null, story_fingerprint: null, brief_id: null, state_version: state.state_version + 1 };
}

async function listResult(mode: "recommended" | "all", page: number, state: ConsoleState, dependencies: ConsoleActionDependencies, action: string): Promise<ConsoleActionResult> {
  const result = await dependencies.listStories(mode, page);
  return {
    view: mode === "recommended" ? renderRecommendedList(result, "recommended") : renderAllStoryList(result),
    next_state: listState(state, mode, result.page),
    event: { action, status: "COMPLETED", metadata: { page: result.page, total: result.total, mode } },
  };
}

async function storyResult(type: "DETAIL" | "EVIDENCE" | "REEL", token: string, state: ConsoleState, dependencies: ConsoleActionDependencies): Promise<ConsoleActionResult> {
  const story = await dependencies.getStoryByToken(token);
  if (!story) return safeError("최신 소재를 찾지 못했습니다. 목록을 다시 열어 주세요.", state, "STALE_CALLBACK");
  const view = type === "DETAIL" ? renderStoryDetail(story) : type === "EVIDENCE" ? renderEvidenceView(story) : renderTextReel(story);
  return {
    view,
    next_state: { ...state, view: type, mode: state.mode, story_id: story.id, story_fingerprint: story.story_fingerprint, brief_id: story.latest_brief_id, state_version: state.state_version + 1 },
    event: { action: type === "DETAIL" ? "STORY_OPENED" : type === "EVIDENCE" ? "EVIDENCE_OPENED" : "REEL_OPENED", status: "COMPLETED", metadata: { story_id: story.id } },
  };
}

export async function dispatchEditorialConsoleAction(action: ConsoleAction, state: ConsoleState, dependencies: ConsoleActionDependencies): Promise<ConsoleActionResult> {
  if (action.type === "OPEN_RECOMMENDED") return listResult("recommended", action.page, state, dependencies, "LIST_OPENED");
  if (action.type === "OPEN_ALL") return listResult("all", action.page, state, dependencies, "LIST_OPENED");
  if (action.type === "NEXT_PAGE") return listResult(state.mode ?? "recommended", state.page + 1, state, dependencies, "LIST_OPENED");
  if (action.type === "OPEN_STORY") return storyResult("DETAIL", action.token, state, dependencies);
  if (action.type === "OPEN_EVIDENCE") return storyResult("EVIDENCE", action.token, state, dependencies);
  if (action.type === "OPEN_REEL") return storyResult("REEL", action.token, state, dependencies);
  if (action.type === "SKIP_STORY") {
    const story = await dependencies.getStoryByToken(action.token);
    if (!story) return safeError("이미 변경된 소재입니다. 목록을 다시 열어 주세요.", state, "STALE_CALLBACK");
    await dependencies.skipStory(story);
    return { ...(await listResult(state.mode ?? "recommended", state.page, state, dependencies, "STORY_SKIPPED")), event: { action: "STORY_SKIPPED", status: "COMPLETED", metadata: { story_id: story.id, deleted: false } } };
  }
  if (action.type === "GENERATE_CAROUSEL") {
    if (!action.token) return safeError("먼저 소재를 열어 주세요.", state, "CREATIVE_GENERATION_FAILED");
    const story = await dependencies.getStoryByToken(action.token);
    if (!story || !story.candidate_id) return safeError("최신 canonical 소재를 찾지 못했습니다.", state, "CREATIVE_GENERATION_FAILED");
    try {
      const draft = await dependencies.generateCarousel(story);
      return { view: renderCarouselDraft(draft), next_state: { ...state, view: "DRAFT", story_id: story.id, story_fingerprint: story.story_fingerprint, brief_id: draft.creative_brief_id, state_version: state.state_version + 1 }, event: { action: "CREATIVE_GENERATION_COMPLETED", status: "COMPLETED", metadata: { story_id: story.id, brief_id: draft.creative_brief_id } } };
    } catch {
      return safeError("canonical 카드뉴스 생성을 완료하지 못했습니다.", state, "CREATIVE_GENERATION_FAILED");
    }
  }
  if (action.type === "SELECT_DRAFT") {
    await dependencies.selectDraft(action.token);
    return { view: { text: "✅ 초안을 선택했습니다. 게시 전 검토 상태로 저장했습니다.", inline_keyboard: [[{ text: "◀ 소재로 돌아가기", callback_data: "draft:back:list" }]] }, next_state: { ...state, state_version: state.state_version + 1 }, event: { action: "DRAFT_SELECTED", status: "COMPLETED", metadata: { brief_token: action.token } } };
  }
  if (action.type === "SHOW_ALTERNATE_HOOKS") return safeError("다른 훅 생성은 canonical revision 경로에서 준비 중입니다. 자연어로 원하는 방향을 입력해 주세요.", state, "ALTERNATE_HOOK_REQUESTED");
  if (action.type === "EDIT_DRAFT") return safeError("수정할 내용을 짧게 입력해 주세요. 예: 3장 좀 짧게", state, "DRAFT_EDIT_REQUESTED");
  if (action.type === "BACK") {
    if ((state.view === "EVIDENCE" || state.view === "REEL" || state.view === "DRAFT") && state.story_id) return storyResult("DETAIL", state.story_id, state, dependencies);
    return listResult(state.mode ?? "recommended", state.page, state, dependencies, "LIST_OPENED");
  }
  return safeError("요청을 처리하지 못했습니다.", state, "UNKNOWN_ACTION");
}

export { callbackData };
