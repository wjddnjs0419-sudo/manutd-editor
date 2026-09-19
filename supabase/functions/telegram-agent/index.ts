import { parseCommand, type ParsedCommand } from "../_shared/m6/commands.ts";
import { buildConversationContext } from "../_shared/m6/memory.ts";
import { createOpenAIGenerator } from "../_shared/m6/openai.ts";
import { reviseCaption, reviseSlide, selectHook } from "../_shared/m6/revisions.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createTelegramAgentHandler } from "./handler.ts";
import type { StoredCreativeBrief } from "../creative-generation/repository.ts";
import type { CreativeBriefSlide } from "../creative-generation/types.ts";

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

async function activeBrief(thread: ThreadRow): Promise<StoredCreativeBrief | null> {
  if (!thread.active_brief_id) return null;
  const rows = await rest(`/rest/v1/creative_briefs?select=*&id=eq.${encodeURIComponent(thread.active_brief_id)}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] as StoredCreativeBrief : null;
}

async function pipelineState(candidateId: string): Promise<{ production_status: "EDITABLE" | "LOCKED" | "APPROVED" | "UNKNOWN"; current_revision: number | null } | null> {
  const rows = await rest(`/rest/v1/creative_pipeline_sync_state?select=production_status,creative_brief_id&candidate_id=eq.${encodeURIComponent(candidateId)}&limit=1`, {}, "app_private");
  if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== "object") return null;
  const row = rows[0] as { production_status?: unknown; creative_brief_id?: unknown };
  const status = row.production_status === "LOCKED" || row.production_status === "APPROVED" || row.production_status === "EDITABLE" ? row.production_status : "UNKNOWN";
  const briefRows = typeof row.creative_brief_id === "string" ? await rest(`/rest/v1/creative_briefs?select=version&id=eq.${encodeURIComponent(row.creative_brief_id)}&limit=1`) : [];
  return { production_status: status, current_revision: Array.isArray(briefRows) && typeof briefRows[0]?.version === "number" ? briefRows[0].version : null };
}

async function saveRevision(revision: StoredCreativeBrief, thread: ThreadRow): Promise<void> {
  const { id: _id, ...insert } = revision;
  const inserted = await rest("/rest/v1/creative_briefs", { method: "POST", headers: { "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify(insert) });
  const storedId = Array.isArray(inserted) && inserted[0] && typeof inserted[0].id === "string" ? inserted[0].id : revision.id;
  await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_brief_id: storedId, active_candidate_id: revision.candidate_id, pending_action: null, pending_action_expires_at: null }) }, "app_private");
}

async function revisionForCommand(command: Extract<ParsedCommand, { type: "HOOK" | "SLIDE" | "CAPTION" }>, thread: ThreadRow): Promise<{ reply: string; revision?: StoredCreativeBrief }> {
  const baseBrief = await activeBrief(thread);
  if (!baseBrief) return { reply: "활성 Creative Brief가 없습니다. 먼저 /open으로 후보를 선택하세요." };
  const state = await pipelineState(baseBrief.candidate_id);
  if (state && (state.production_status === "LOCKED" || state.production_status === "APPROVED")) {
    const pending = { command_type: command.type, args: command, base_brief_id: baseBrief.id, base_revision: baseBrief.version, requested_at: new Date().toISOString() };
    await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ pending_action: pending, pending_action_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }) }, "app_private");
    return { reply: `현재 제작 상태가 ${state.production_status}입니다. 적용하려면 10분 안에 /confirm 하세요.` };
  }
  const qualityConfig = { min_slides: Math.max(1, baseBrief.slide_count), max_slides: 7, hook_count: 3, max_repair_attempts: 0, require_visual_direction: true };
  const provider = Deno.env.get("OPENAI_API_KEY") ? createOpenAIGenerator({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "" }) : undefined;
  try {
    let revision: StoredCreativeBrief;
    if (command.type === "HOOK") revision = await selectHook(baseBrief, command.hook, { qualityConfig });
    else if (!provider) return { reply: "현재 OPENAI_API_KEY가 없어 targeted revision을 실행할 수 없습니다." };
    else if (command.type === "SLIDE") revision = await reviseSlide(baseBrief, command.slide, command.instruction, { qualityConfig, reviseSlide: async (_brief, slide, instruction) => await provider({ task: "revise_one_slide", slide, instruction, rule: "Preserve evidence_ids and slide_number; return only one slide object." }) as CreativeBriefSlide });
    else revision = await reviseCaption(baseBrief, command.instruction, { qualityConfig, reviseCaption: async (brief, instruction) => await provider({ task: "revise_caption", caption: brief.caption, instruction, rule: "Return only {body,cta}; do not add evidence." }) as { body: string; cta: string } });
    await saveRevision(revision, thread);
    return { reply: `Creative Brief revision ${revision.version}을 DRAFT로 저장했습니다.`, revision };
  } catch (error) {
    return { reply: error instanceof Error && error.message === "REVISION_INVALID" ? "근거 경계를 통과하지 못해 revision을 저장하지 않았습니다." : "revision을 저장하지 못했습니다. canonical 상태는 변경되지 않았습니다." };
  }
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
  if (command.type === "CONFIRM") {
    const pending = thread.pending_action as { command_type?: string; args?: ParsedCommand; base_brief_id?: string; base_revision?: number; requested_at?: string } | null;
    const brief = await activeBrief(thread);
    const state = brief ? await pipelineState(brief.candidate_id) : null;
    if (!pending || !brief || !state) return "확인할 대기 작업이 없습니다.";
    if (pending.base_brief_id !== brief.id || pending.base_revision !== brief.version || Date.parse(thread.pending_action_expires_at ?? "") <= Date.now()) return "STALE_PENDING_ACTION 또는 PENDING_ACTION_EXPIRED: 최신 상태에서 명령을 다시 실행하세요.";
    if (!pending.args || (pending.args.type !== "HOOK" && pending.args.type !== "SLIDE" && pending.args.type !== "CAPTION")) return "대기 작업을 확인하지 못했습니다.";
    const result = await revisionForCommand(pending.args, { ...thread, pending_action: null, pending_action_expires_at: null });
    if (result.revision) return `확인 완료: revision ${result.revision.version}을 DRAFT로 저장했습니다.`;
    return result.reply;
  }
  if (command.type === "OPEN") {
    if (command.target.toLowerCase() === "alert") {
      const alerts = await rest(`/rest/v1/telegram_alert_events?select=payload,candidate_id,match_id&thread_id=eq.${encodeURIComponent(thread.id)}&status=eq.SENT&order=created_at.desc&limit=1`, {}, "app_private");
      const alert = Array.isArray(alerts) ? alerts[0] as { payload?: { permalink?: unknown }; candidate_id?: unknown; match_id?: unknown } | undefined : undefined;
      if (!alert) return "열 수 있는 최근 alert가 없습니다.";
      await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: typeof alert.candidate_id === "string" ? alert.candidate_id : null, active_match_id: typeof alert.match_id === "string" ? alert.match_id : null }) }, "app_private");
      return `최근 alert를 열었습니다.${typeof alert.payload?.permalink === "string" ? `\n🔗 원문: ${alert.payload.permalink}` : ""}`;
    }
    const rows = await rest(`/rest/v1/telegram_briefings?select=candidate_snapshot&thread_id=eq.${encodeURIComponent(thread.id)}&order=briefing_date.desc&limit=1`, {}, "app_private");
    const snapshot = Array.isArray(rows) && rows[0] && typeof rows[0].candidate_snapshot === "object" ? rows[0].candidate_snapshot as { items?: Array<Record<string, unknown>> } : {};
    const item = snapshot.items?.find((candidate) => command.target === String(candidate.position) || command.target === String(candidate.candidate_id));
    if (!item || typeof item.candidate_id !== "string") return "현재 브리핑에서 해당 후보를 찾지 못했습니다.";
    await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: item.candidate_id, active_brief_id: null, pending_action: null, pending_action_expires_at: null }) }, "app_private");
    const link = typeof item.reference_permalink === "string" ? `\n🔗 원문: ${item.reference_permalink}` : "";
    return `브리핑의 ${item.position}번 후보를 열었습니다.${link}`;
  }
  if (command.type === "BRIEF") return thread.active_brief_id ? `현재 Creative Brief: ${thread.active_brief_id}` : "활성 Creative Brief가 없습니다.";
  if (command.type === "SELECT") return "선택 상태는 Daily Intelligence의 Selected 필드에서 관리됩니다.";
  if (command.type === "HOOK" || command.type === "SLIDE" || command.type === "CAPTION") return (await revisionForCommand(command, thread)).reply;
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
