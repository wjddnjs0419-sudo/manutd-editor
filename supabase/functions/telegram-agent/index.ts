import { parseCommand, type ParsedCommand } from "../_shared/m6/commands.ts";
import { buildConversationContext } from "../_shared/m6/memory.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createTelegramAgentHandler } from "./handler.ts";

const invokeSecret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? "";
const ownerUserId = Deno.env.get("TELEGRAM_OWNER_USER_ID") ?? "";
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const base = supabaseUrl.replace(/\/$/u, "");

function profileHeaders(profile: string): Record<string, string> { return { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, accept: "application/json", "accept-profile": profile, "content-profile": profile }; }
async function rest(path: string, init: RequestInit = {}, profile?: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(profile ? profileHeaders(profile) : { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, accept: "application/json" })) headers.set(key, value);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) throw new Error("AGENT_REPOSITORY_FAILED");
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

interface TelegramUpdate { update_id?: number; message?: { text?: string; from?: { id?: number; first_name?: string }; chat?: { id?: number } } }
interface ThreadRow { id: string; telegram_user_id: string; active_candidate_id: string | null; active_brief_id: string | null; active_match_id: string | null; context_history: unknown[]; conversation_summary: string | null; summary_message_count: number; pending_action: Record<string, unknown> | null; pending_action_expires_at: string | null; }

function update(value: unknown): TelegramUpdate { return value as TelegramUpdate; }
function content(value: TelegramUpdate): string { return value.message?.text?.trim() || "[Telegram update]"; }

async function ensureThread(value: TelegramUpdate): Promise<ThreadRow> {
  const chatId = value.message?.chat?.id;
  if (typeof chatId !== "number" || !ownerUserId) throw new Error("TELEGRAM_THREAD_CONFIGURATION_MISSING");
  const users = await rest("/rest/v1/telegram_users?on_conflict=telegram_user_id", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ telegram_user_id: Number(ownerUserId), display_name: value.message?.from?.first_name ?? null, role: "OWNER", is_active: true }) }, "app_private");
  const user = Array.isArray(users) ? users[0] as { id?: string } | undefined : undefined;
  if (!user?.id) throw new Error("TELEGRAM_USER_INITIALIZATION_FAILED");
  const threads = await rest("/rest/v1/telegram_threads?on_conflict=telegram_chat_id,telegram_user_id", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify({ telegram_chat_id: chatId, telegram_user_id: user.id }) }, "app_private");
  const thread = Array.isArray(threads) ? threads[0] : null;
  if (!thread || typeof thread !== "object" || typeof (thread as { id?: unknown }).id !== "string") throw new Error("TELEGRAM_THREAD_INITIALIZATION_FAILED");
  return thread as ThreadRow;
}

async function claimUpdate(value: unknown): Promise<boolean> {
  const incoming = update(value);
  if (typeof incoming.update_id !== "number") return true;
  const thread = await ensureThread(incoming);
  const claimed = await rest("/rest/v1/telegram_messages?on_conflict=telegram_update_id", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ thread_id: thread.id, telegram_update_id: incoming.update_id, role: "USER", message_type: parseCommand(content(incoming)) ? "COMMAND" : "TEXT", content: content(incoming), metadata: {} }) }, "app_private");
  return Array.isArray(claimed) && claimed.length > 0;
}

async function sendAndPersist(thread: ThreadRow, value: TelegramUpdate, reply: string): Promise<void> {
  const client = createTelegramClient({ token: botToken });
  const sent = await client.sendText(value.message?.chat?.id ?? "", reply);
  await rest("/rest/v1/telegram_messages", { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ thread_id: thread.id, telegram_message_id: sent.message_id, telegram_update_id: null, role: "ASSISTANT", message_type: "TEXT", content: reply, metadata: { in_reply_to_update_id: value.update_id ?? null } }) }, "app_private");
}

const HELP = "/today · /open <1..3|uuid|alert> · /brief · /hook <1..3> · /slide <1..7> <지시> · /caption <지시> · /select · /status · /back · /reset · /confirm · /cancel · /help";

async function commandReply(command: ParsedCommand, thread: ThreadRow): Promise<string> {
  if (command.type === "HELP") return HELP;
  if (command.type === "RESET") {
    await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: null, active_brief_id: null, active_match_id: null, context_history: [], pending_action: null, pending_action_expires_at: null }) }, "app_private");
    return "현재 작업 맥락을 초기화했습니다. 대화 기록과 요약은 보존됩니다.";
  }
  if (command.type === "TODAY") {
    const rows = await rest(`/rest/v1/telegram_briefings?select=rendered_message,briefing_date&thread_id=eq.${encodeURIComponent(thread.id)}&order=briefing_date.desc&limit=1`, {}, "app_private");
    return Array.isArray(rows) && rows[0] && typeof rows[0].rendered_message === "string" ? rows[0].rendered_message : "저장된 오늘 브리핑이 없습니다.";
  }
  if (command.type === "STATUS") return thread.active_candidate_id ? `현재 후보 ${thread.active_candidate_id}의 최신 상태를 확인하세요.` : "활성 후보가 없습니다. /today 또는 /open으로 시작하세요.";
  if (command.type === "BACK") return "이전 작업 맥락으로 돌아갔습니다.";
  if (command.type === "CANCEL") return "대기 중인 작업을 취소했습니다.";
  if (command.type === "CONFIRM") return "확인은 최신 상태를 다시 검증한 뒤 처리됩니다.";
  if (command.type === "OPEN") return `후보 ${command.target}을(를) 열었습니다. 원문과 근거를 확인하세요.`;
  if (command.type === "BRIEF") return thread.active_brief_id ? `현재 Creative Brief: ${thread.active_brief_id}` : "활성 Creative Brief가 없습니다.";
  if (command.type === "SELECT") return "선택 상태는 Daily Intelligence의 Selected 필드에서 관리됩니다.";
  if (command.type === "HOOK" || command.type === "SLIDE" || command.type === "CAPTION") return "명령을 접수했지만 현재 활성 Creative Brief가 없습니다.";
  return "요청을 처리하지 못했습니다.";
}

async function runAgent(value: unknown): Promise<{ status: string; reply: string }> {
  const incoming = update(value);
  const thread = await ensureThread(incoming);
  const text = content(incoming);
  const command = parseCommand(text);
  const reply = command ? await commandReply(command, thread) : (await buildConversationContext(thread.id, text, { getThread: async () => thread, listMessages: async () => [] })).system_rules + "\n\n현재 질문에 대한 충분한 canonical context가 없습니다.";
  await sendAndPersist(thread, incoming, reply);
  return { status: "SENT", reply };
}

Deno.serve(createTelegramAgentHandler({ invokeSecret, ownerUserId, claimUpdate, run: runAgent }));
