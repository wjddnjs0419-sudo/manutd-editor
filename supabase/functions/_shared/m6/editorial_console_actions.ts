import {
  callbackData,
  renderAllStoryList,
  renderCarouselDraft,
  renderEvidenceView,
  renderRecommendedList,
  renderTrendingList,
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
  | { type: "OPEN_TRENDING"; page: number }
  | { type: "DISCOVER_MORE" }
  | { type: "REFRESH_DISCOVERY" }
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
  mode: "recommended" | "all" | "trending" | null;
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
  listTrendingStories?: (page: number) => Promise<StoryPage>;
  discoverMore?: () => Promise<{ status: string; run_id?: string; new_story_count?: number; provider_failures?: number }>;
  refreshDiscovery?: () => Promise<{ status: string; run_id?: string; new_story_count?: number; provider_failures?: number }>;
  getStoryByToken: (token: string) => Promise<CanonicalStory | null>;
  skipStory: (story: CanonicalStory) => Promise<void>;
  generateCarousel: (story: CanonicalStory) => Promise<ManutdEditorCarouselDraft>;
  selectDraft: (briefId: string) => Promise<void>;
}

type ParsedCallback = Exclude<ConsoleAction, { type: "NEXT_PAGE" | "BACK" }> | { type: "BACK" };

export function canHandleStaleConsoleCallback(action: ConsoleAction): boolean {
  switch (action.type) {
    case "OPEN_RECOMMENDED":
    case "OPEN_ALL":
    case "OPEN_TRENDING":
    case "DISCOVER_MORE":
    case "REFRESH_DISCOVERY":
    case "NEXT_PAGE":
    case "OPEN_STORY":
    case "OPEN_EVIDENCE":
    case "SKIP_STORY":
    case "GENERATE_CAROUSEL":
    case "OPEN_REEL":
    case "BACK":
      return true;
    case "SELECT_DRAFT":
    case "SHOW_ALTERNATE_HOOKS":
    case "EDIT_DRAFT":
      return false;
  }
}

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
  const trending = /^ideas:trending:(\d{1,3})$/u.exec(value);
  if (trending) {
    const page = positivePage(trending[1]!);
    return page ? { type: "OPEN_TRENDING", page } : null;
  }
  if (value === "discovery:more") return { type: "DISCOVER_MORE" };
  if (value === "discovery:refresh") return { type: "REFRESH_DISCOVERY" };
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
  if (/^(지금 뭐 뜨고 있어\??|요즘 맨유 뭐가 핫해\??|지금 트렌드 보여줘|지금 뜨는 소재)$/u.test(normalized)) return { type: "OPEN_TRENDING", page: 1 };
  if (/^(다른 거 더 없어\??|좀 더 찾아봐|새로운 소재 찾아줘|이거 말고 다른 이슈)$/u.test(normalized)) return { type: "DISCOVER_MORE" };
  const numericSelection = /^(\d{1,3})번?\s*(?:소재\s*)?(?:선택(?:해줘)?|열어(?:줘)?|보여줘)?$/u.exec(normalized);
  if (numericSelection) return { type: "OPEN_STORY", token: numericSelection[1]! };
  const ordinalSelection = /^(첫|첫째|두|둘째|세|셋째|네|넷째|다섯|다섯째)\s*번째?\s*(?:소재\s*)?(?:선택(?:해줘)?|열어(?:줘)?|보여줘)?$/u.exec(normalized);
  if (ordinalSelection) {
    const ordinal = { 첫: 1, 첫째: 1, 두: 2, 둘째: 2, 세: 3, 셋째: 3, 네: 4, 넷째: 4, 다섯: 5, 다섯째: 5 }[ordinalSelection[1]!];
    return { type: "OPEN_STORY", token: String(ordinal) };
  }
  if (normalized === "다음 거 보여줘") return { type: "NEXT_PAGE" };
  if (normalized === "카드뉴스 생성") return { type: "GENERATE_CAROUSEL", token: activeStoryToken ?? null };
  if (/^이거 카드뉴스로 (?:만들어줘|만들거야|만들어야)$/u.test(normalized)) return { type: "GENERATE_CAROUSEL", token: activeStoryToken ?? null };
  return null;
}

function safeError(message: string, state: ConsoleState, action: string): ConsoleActionResult {
  return { view: { text: `⚠️ ${message}`, inline_keyboard: [[{ text: "◀ 돌아가기", callback_data: "idea:back:list" }]] }, next_state: state, event: { action, status: "FAILED" } };
}

function listState(state: ConsoleState, mode: "recommended" | "all" | "trending", page: number): ConsoleState {
  return { ...state, view: "LIST", mode, page, story_id: null, story_fingerprint: null, brief_id: null, state_version: state.state_version + 1 };
}

async function listResult(mode: "recommended" | "all" | "trending", page: number, state: ConsoleState, dependencies: ConsoleActionDependencies, action: string): Promise<ConsoleActionResult> {
  const result = mode === "trending" ? await dependencies.listTrendingStories?.(page) : await dependencies.listStories(mode, page);
  if (!result) return safeError("트렌드 데이터를 아직 준비하지 못했습니다.", state, "TRENDING_UNAVAILABLE");
  return {
    view: mode === "recommended" ? renderRecommendedList(result, "recommended") : mode === "all" ? renderAllStoryList(result) : renderTrendingList(result),
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
  if (action.type === "OPEN_TRENDING") return listResult("trending", action.page, state, dependencies, "TRENDING_OPENED");
  if (action.type === "DISCOVER_MORE" || action.type === "REFRESH_DISCOVERY") {
    let result: Awaited<ReturnType<NonNullable<ConsoleActionDependencies["discoverMore"]>>> | undefined;
    try {
      result = action.type === "DISCOVER_MORE" ? await dependencies.discoverMore?.() : await (dependencies.refreshDiscovery ?? dependencies.discoverMore)?.();
    } catch {
      return safeError("새 discovery 작업을 대기열에 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.", state, action.type === "DISCOVER_MORE" ? "DISCOVERY_MORE_FAILED" : "DISCOVERY_REFRESH_FAILED");
    }
    if (!result) return safeError("discovery를 실행할 수 없습니다. 설정된 provider가 없습니다.", state, "DISCOVERY_UNAVAILABLE");
    const queued = result.status === "QUEUED";
    const failures = result.provider_failures ?? 0;
    return {
      view: { text: queued
        ? `🔎 새 discovery run\n\n상태: 대기열 등록됨\n검색 작업이 백그라운드에서 시작됩니다. 잠시 후 /current 또는 📈 지금 뜨는 소재에서 확인해 주세요.`
        : `🔎 새 discovery run\n\n상태: ${result.status}\n새롭게 확인된 소재: ${result.new_story_count ?? 0}개\nprovider 실패: ${failures}개`, inline_keyboard: [[{ text: "📈 지금 뜨는 소재", callback_data: "ideas:trending:1" }, { text: "🔎 다시 찾아보기", callback_data: "discovery:more" }]] },
      next_state: { ...state, mode: "trending", state_version: state.state_version + 1 },
      event: { action: action.type === "DISCOVER_MORE" ? queued ? "DISCOVERY_MORE_QUEUED" : "DISCOVERY_MORE_COMPLETED" : queued ? "DISCOVERY_REFRESH_QUEUED" : "DISCOVERY_REFRESHED", status: "COMPLETED", metadata: { run_id: result.run_id ?? null, status: result.status, provider_failures: failures } },
    };
  }
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
    const token = action.token ?? state.story_id;
    if (!token) return safeError("먼저 소재를 열어 주세요.", state, "CREATIVE_GENERATION_FAILED");
    let story = await dependencies.getStoryByToken(token);
    if (!story && state.story_id && state.story_id !== token) story = await dependencies.getStoryByToken(state.story_id);
    if (!story || !story.candidate_id) return safeError("최신 canonical 소재를 찾지 못했습니다.", state, "CREATIVE_GENERATION_FAILED");
    if (!story.news_eligible || story.evidence.length === 0 || (story.information_gap_score <= 0 && story.hook_strength <= 0)) {
      return safeError("현재 공개용 카드뉴스 생성에 필요한 검증된 근거가 부족합니다.\n🔎 근거 보기에서 출처를 확인해 주세요.", state, "CREATIVE_GENERATION_BLOCKED");
    }
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
