import type { EditorialTrustState } from "../_shared/m6/editorial_trust.ts";
import type { TelegramInlineKeyboardMarkup } from "../_shared/m6/telegram_client.ts";

export interface EditorialDigestStory {
  readonly story_id: string;
  readonly title: string;
  readonly trust_state: EditorialTrustState;
  readonly source_name: string | null;
  readonly source_url: string | null;
  readonly last_seen_at: string;
  readonly trend_state?: string | null;
  readonly material_fingerprint?: string;
}

export function buildEditorialDigest(
  stories: readonly EditorialDigestStory[],
  windowStart: Date,
  windowEnd: Date,
  previouslySentFingerprints: ReadonlySet<string> = new Set(),
): { event_fingerprint: string; stories: readonly EditorialDigestStory[] } | null {
  const start = windowStart.getTime();
  const end = windowEnd.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("EDITORIAL_DIGEST_WINDOW_INVALID");
  const unique = new Map<string, EditorialDigestStory>();
  for (const story of stories) {
    const seen = Date.parse(story.last_seen_at);
    if (!story.story_id || !story.title.trim() || !Number.isFinite(seen) || seen < start || seen >= end) continue;
    if (story.material_fingerprint && previouslySentFingerprints.has(story.material_fingerprint)) continue;
    const previous = unique.get(story.story_id);
    if (!previous || Date.parse(story.last_seen_at) > Date.parse(previous.last_seen_at)) unique.set(story.story_id, story);
  }
  if (unique.size === 0) return null;
  const order: Record<EditorialTrustState, number> = { VERIFIED: 0, REPORTED: 1, DISCOVERY: 2 };
  const selected = [...unique.values()].sort((a, b) => order[a.trust_state] - order[b.trust_state] || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at));
  return { event_fingerprint: `EDITORIAL_DIGEST:${windowStart.toISOString()}`, stories: selected };
}

function trustLabel(state: EditorialTrustState): string {
  return state === "VERIFIED" ? "🟢" : state === "REPORTED" ? "🟡" : "🔴";
}

export function renderEditorialDigest(payload: Record<string, unknown>): { text: string; reply_markup: TelegramInlineKeyboardMarkup } {
  const stories = (Array.isArray(payload.stories) ? payload.stories : []).filter((value): value is Record<string, unknown> =>
    Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).story_id === "string" && typeof (value as Record<string, unknown>).title === "string")
  );
  const windowStart = typeof payload.window_start === "string" ? new Date(payload.window_start) : new Date();
  const hour = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", hourCycle: "h23" }).format(windowStart);
  const lines = stories.map((value, index) => {
    const state = value.trust_state === "VERIFIED" || value.trust_state === "REPORTED" ? value.trust_state : "DISCOVERY";
    const source = typeof value.source_name === "string" ? value.source_name : "출처 확인 중";
    const url = typeof value.source_url === "string" ? `\n   ${value.source_url}` : "";
    const trend = value.trend_state === "RISING" || value.trend_state === "BREAKING" || value.trend_state === "HOT" ? ` · ${value.trend_state === "BREAKING" ? "🚨 BREAKING" : "🔥 급상승"}` : "";
    return `${index + 1}. ${value.title} ${trustLabel(state)}${trend}\n   ${source}${url}`;
  });
  const buttons = stories.slice(0, 5).map((value, index) => ({ text: `${index + 1}번 카드뉴스`, callback_data: `idea:carousel:${String(value.story_id).replaceAll("-", "").slice(0, 12)}` }));
  const markup = buttons.length ? { inline_keyboard: buttons.map((button) => [button]) } : { inline_keyboard: [] };
  return {
    text: `🕑 ${hour}:00 맨유 업데이트\n지난 1시간 새 이슈 ${stories.length}건\n\n${lines.join("\n\n")}\n\n번호를 말하면 바로 카드뉴스 초안을 만들어요.`,
    reply_markup: markup,
  };
}
