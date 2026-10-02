import { parseCommand, type ParsedCommand } from "../_shared/m6/commands.ts";
import { businessDate } from "../_shared/m6/business_date.ts";
import { selectBriefingCandidates } from "../_shared/m6/briefing.ts";
import { classifyReadiness, countReadinessCandidates } from "../_shared/m6/readiness.ts";
import { formatCurrentReply, snapshotCurrentCandidates } from "./current.ts";
import { MEMORY_SYSTEM_RULES, maybeRollSummary, type MemoryMessage, type MemoryThread } from "../_shared/m6/memory.ts";
import { createOpenAIGenerator } from "../_shared/m6/openai.ts";
import { retrieveHistoricalContext, type HistoricalContext, type RetrievalThreadState } from "../_shared/m6/retrieval.ts";
import { reviseCaption, reviseSlide, selectHook } from "../_shared/m6/revisions.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createM6Repository } from "../_shared/m6/repository.ts";
import { createEditorialConsoleRepository, findCanonicalStoryByToken, paginateStories, shortCallbackToken, type CanonicalStory, type ConsoleView } from "../_shared/m6/editorial_console.ts";
import { canHandleStaleConsoleCallback, dispatchEditorialConsoleAction, parseConsoleCallback, type ConsoleAction, type ConsoleState } from "../_shared/m6/editorial_console_actions.ts";
import { invokeCanonicalCarousel } from "../_shared/m6/console_generation.ts";
import { createEditorialJobQueue } from "../orchestration-worker/queue_client.ts";
import { createTelegramAgentHandler } from "./handler.ts";
import { answerNaturalLanguage, canonicalStoryFromReplyContext, parseEditorialIntent, parseReplyMessageId, replyConsoleIntent, resolvePresentedStoryPosition, resolveReplyContext, resolveReplyReference, type CanonicalConversationContext, type ReplyContext } from "./conversation.ts";
import { enqueueManualDiscovery, type ManualDiscoveryPayload } from "./manual_discovery.ts";
import type { StoredCreativeBrief } from "../creative-generation/repository.ts";
import type { CreativeBriefSlide } from "../creative-generation/types.ts";
import type { EditorialSlideRole, ManutdEditorCarouselDraft } from "../_shared/editorial-style/types.ts";

const invokeSecret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? "";
const webhookSecret = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const ownerUserId = Deno.env.get("TELEGRAM_OWNER_USER_ID") ?? "";
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const base = supabaseUrl.replace(/\/$/u, "");
const repository = createM6Repository({ supabaseUrl, serviceRoleKey: serviceKey });
const consoleRepository = createEditorialConsoleRepository({ supabaseUrl, serviceRoleKey: serviceKey });
const editorialJobQueue = createEditorialJobQueue({ supabaseUrl, serviceKey });
const manualDiscoveryPayload: ManualDiscoveryPayload = { mode: "GENERAL", search_profile: "MANUAL", max_queries: 8 };

function profileHeaders(profile: string): Record<string, string> { return { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, accept: "application/json", "accept-profile": profile, "content-profile": profile }; }
async function rest(path: string, init: RequestInit = {}, profile?: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(profile ? profileHeaders(profile) : { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, accept: "application/json" })) headers.set(key, value);
  const response = await fetch(`${base}${path}`, { ...init, headers });
  if (!response.ok) throw new Error("AGENT_REPOSITORY_FAILED");
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function loadAgentConfig(): Promise<AgentConfig> {
  try {
    const rows = await rest("/rest/v1/telegram_agent_configs?select=recent_message_limit,summary_trigger_count,model_config&is_active=eq.true&limit=1");
    const value = Array.isArray(rows) && isObject(rows[0]) ? rows[0] : {};
    return {
      recent_message_limit: typeof value.recent_message_limit === "number" && value.recent_message_limit > 0 ? Math.min(12, value.recent_message_limit) : 12,
      summary_trigger_count: typeof value.summary_trigger_count === "number" && value.summary_trigger_count > 0 ? value.summary_trigger_count : 20,
      model_config: isObject(value.model_config) ? value.model_config : {},
    };
  } catch {
    return defaultAgentConfig();
  }
}

async function listMessages(threadId: string, limit?: number): Promise<MemoryMessage[]> {
  const suffix = limit ? `&limit=${Math.max(1, Math.floor(limit))}` : "";
  const rows = await rest(`/rest/v1/telegram_messages?select=role,content,created_at&thread_id=eq.${encodeURIComponent(threadId)}&order=created_at.desc${suffix}`, {}, "app_private");
  return Array.isArray(rows) ? rows.map(message).filter((value): value is MemoryMessage => value !== null) : [];
}

async function rowById(path: string, profile?: string): Promise<Record<string, unknown> | null> {
  try {
    const rows = await rest(path, {}, profile);
    return Array.isArray(rows) && isObject(rows[0]) ? rows[0] : null;
  } catch {
    return null;
  }
}

async function loadCanonicalContext(state: RetrievalThreadState): Promise<CanonicalConversationContext> {
  const candidate = state.active_candidate_id ? await rowById(`/rest/v1/content_candidates?select=*&id=eq.${encodeURIComponent(state.active_candidate_id)}&limit=1`) : null;
  const sourceObservation = state.active_source_observation_id ? await rowById(`/rest/v1/source_observations?select=*&id=eq.${encodeURIComponent(state.active_source_observation_id)}&limit=1`, "app_private") : null;
  const brief = state.active_brief_id ? await rowById(`/rest/v1/creative_briefs?select=*&id=eq.${encodeURIComponent(state.active_brief_id)}&limit=1`) : null;
  const match = state.active_match_id ? await rowById(`/rest/v1/matches?select=*&id=eq.${encodeURIComponent(state.active_match_id)}&limit=1`) : null;
  return { candidate, source_observation: sourceObservation, brief, match };
}

async function loadReplyRanking(storyId: string, rankingDate: string | null, rankingVersion: string | null): Promise<Record<string, unknown> | null> {
  const filters = [
    `story_cluster_id=eq.${encodeURIComponent(storyId)}`,
    ...(rankingDate ? [`ranking_date=eq.${encodeURIComponent(rankingDate)}`] : []),
    ...(rankingVersion ? [`ranking_version=eq.${encodeURIComponent(rankingVersion)}`] : []),
  ];
  const order = rankingDate ? "&order=calculated_at.desc" : "&order=ranking_date.desc,calculated_at.desc";
  return await rowById(`/rest/v1/editorial_rankings?select=story_cluster_id,ranking_date,ranking_version,rank,editorial_score,information_gap_score,fact_grounding_score,discovery_audience_signal_score,match_context_score,freshness_score,grounding_status,news_eligible&${filters.join("&")}${order}&limit=1`, "app_private");
}

async function loadReplySourceObservation(observationId: string): Promise<Record<string, unknown> | null> {
  const observation = await rowById(`/rest/v1/source_observations?select=id,information_source_id,canonical_url,title,editorial_role&id=eq.${encodeURIComponent(observationId)}&limit=1`, "app_private");
  if (!observation) return null;
  const sourceId = typeof observation.information_source_id === "string" ? observation.information_source_id : null;
  const source = sourceId ? await rowById(`/rest/v1/information_sources?select=canonical_name&id=eq.${encodeURIComponent(sourceId)}&limit=1`) : null;
  return {
    ...observation,
    source_name: typeof source?.canonical_name === "string" ? source.canonical_name : typeof observation.title === "string" ? observation.title : null,
    canonical_url: typeof observation.canonical_url === "string" ? observation.canonical_url : null,
  };
}

async function loadReplyEvidence(storyId: string, evidenceIds: readonly string[]): Promise<{ evidence: readonly Record<string, unknown>[]; source_observation: Record<string, unknown> | null }> {
  const [claimsValue, claimEvidenceValue, observationsValue, sourcesValue] = await Promise.all([
    rest(`/rest/v1/story_claims?select=id,story_cluster_id,claim_text,grounding_status&story_cluster_id=eq.${encodeURIComponent(storyId)}&limit=100`, {}, "app_private").catch(() => []),
    rest("/rest/v1/claim_evidence?select=claim_id,source_observation_id,editorial_role,evidence_text,is_grounding&limit=5000", {}, "app_private").catch(() => []),
    rest("/rest/v1/source_observations?select=id,information_source_id,canonical_url,title,editorial_role&limit=5000", {}, "app_private").catch(() => []),
    rest("/rest/v1/information_sources?select=id,canonical_name&limit=500").catch(() => []),
  ]);
  const claims = Array.isArray(claimsValue) ? claimsValue.filter(isObject) : [];
  const claimIds = new Set(claims.flatMap((value) => typeof value.id === "string" ? [value.id] : []));
  const claimEvidence = Array.isArray(claimEvidenceValue) ? claimEvidenceValue.filter((value) => isObject(value) && typeof value.claim_id === "string" && claimIds.has(value.claim_id)) : [];
  const observations = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(observationsValue) ? observationsValue : []) if (isObject(value) && typeof value.id === "string") observations.set(value.id, value);
  const sourceNames = new Map<string, string>();
  for (const value of Array.isArray(sourcesValue) ? sourcesValue : []) if (isObject(value) && typeof value.id === "string" && typeof value.canonical_name === "string") sourceNames.set(value.id, value.canonical_name);
  const evidence = claimEvidence.flatMap((relation) => {
    const claim = claims.find((value) => value.id === relation.claim_id);
    const observation = typeof relation.source_observation_id === "string" ? observations.get(relation.source_observation_id) : null;
    if (!claim || !observation) return [];
    const sourceName = typeof observation.information_source_id === "string" ? sourceNames.get(observation.information_source_id) : null;
    return [{
      id: `claim:${claim.id}`,
      claim_id: claim.id,
      claim_text: claim.claim_text,
      grounding_status: claim.grounding_status,
      evidence_text: relation.evidence_text,
      is_grounding: relation.is_grounding === true,
      editorial_role: relation.editorial_role ?? observation.editorial_role ?? null,
      source_observation_id: observation.id,
      source_name: sourceName ?? observation.title ?? "M8 근거",
      canonical_url: observation.canonical_url ?? null,
    } satisfies Record<string, unknown>];
  }).filter((value) => evidenceIds.length === 0 || evidenceIds.includes(String(value.claim_id)) || evidenceIds.includes(String(value.id)));
  const representative = evidence.find((value) => value.is_grounding === true && (value.editorial_role === "FACT_PRIMARY" || value.editorial_role === "FACT_INDEPENDENT")) ?? evidence.find((value) => value.editorial_role === "FACT_PRIMARY" || value.editorial_role === "FACT_INDEPENDENT") ?? evidence[0] ?? null;
  const representativeObservation = representative && typeof representative.source_observation_id === "string" ? observations.get(representative.source_observation_id) ?? null : null;
  const sourceObservation = representativeObservation ? { ...representativeObservation, source_name: representative?.source_name ?? null, canonical_url: representative?.canonical_url ?? null } : representative ? { id: representative.source_observation_id, source_name: representative.source_name, canonical_url: representative.canonical_url } : null;
  return { evidence, source_observation: sourceObservation };
}

async function loadReplyContext(threadId: string, messageId: number): Promise<{ storyId: string; context: ReplyContext } | null> {
  const reference = await resolveReplyReference(threadId, messageId, async (id, telegramMessageId) =>
    await rowById(`/rest/v1/telegram_messages?select=role,metadata&thread_id=eq.${encodeURIComponent(id)}&telegram_message_id=eq.${telegramMessageId}&role=eq.ASSISTANT&order=created_at.desc&limit=1`, "app_private")
  );
  if (!reference) return null;
  return await resolveReplyContext(reference, {
    loadStory: async (storyId) => await rowById(`/rest/v1/story_clusters?select=*&id=eq.${encodeURIComponent(storyId)}&limit=1`),
    loadCandidate: async (candidateId) => await rowById(`/rest/v1/content_candidates?select=*&id=eq.${encodeURIComponent(candidateId)}&limit=1`),
    loadEditorialRanking: loadReplyRanking,
    loadSourceObservation: loadReplySourceObservation,
    loadEvidence: loadReplyEvidence,
  });
}

function historicalRecord(kind: HistoricalContext["kind"], value: Record<string, unknown>): HistoricalContext | null {
  if (typeof value.id !== "string") return null;
  const title = typeof value.canonical_title === "string" ? value.canonical_title : typeof value.headline === "string" ? value.headline : typeof value.content === "string" ? value.content : JSON.stringify(value);
  return { kind, id: value.id, text: title, ...value };
}

async function retrievalDependencies(thread: RetrievalThreadState) {
  return {
    findLastFinishedMatch: async () => {
      const value = await rowById("/rest/v1/matches?select=*&status=eq.FINISHED&order=kickoff_at.desc&limit=1");
      return value && typeof value.id === "string" ? { id: value.id, status: typeof value.status === "string" ? value.status : "FINISHED", ...value } : null;
    },
    findByMatch: async (match: { id: string }) => {
      const value = await rowById(`/rest/v1/matches?select=*&id=eq.${encodeURIComponent(match.id)}&limit=1`);
      const result = value ? historicalRecord("match", value) : null;
      return result ? [result] : [];
    },
    findByActive: async (active: RetrievalThreadState) => {
      const context = await loadCanonicalContext(active);
      return [
        context.candidate ? historicalRecord("candidate", context.candidate) : null,
        context.brief ? historicalRecord("brief", context.brief) : null,
        context.match ? historicalRecord("match", context.match) : null,
      ].filter((value): value is HistoricalContext => value !== null);
    },
    searchText: async (terms: readonly string[]) => {
      const records: HistoricalContext[] = [];
      for (const term of terms.slice(0, 8)) {
        const encoded = encodeURIComponent(`*${term}*`);
        const [clusters, briefs, messages] = await Promise.all([
          rowById(`/rest/v1/story_clusters?select=id,canonical_title&canonical_title=ilike.${encoded}&limit=5`),
          rowById(`/rest/v1/creative_briefs?select=id,headline&headline=ilike.${encoded}&limit=5`),
          rowById(`/rest/v1/telegram_messages?select=id,content&content=ilike.${encoded}&order=created_at.desc&limit=5`, "app_private"),
        ]);
        for (const [kind, value] of [["candidate", clusters], ["brief", briefs], ["message", messages]] as const) {
          if (value) {
            const record = historicalRecord(kind, value);
            if (record) records.push(record);
          }
        }
      }
      return records;
    },
  };
}

async function loadThreadById(threadId: string): Promise<ThreadRow> {
  const rows = await rest(`/rest/v1/telegram_threads?select=*&id=eq.${encodeURIComponent(threadId)}&limit=1`, {}, "app_private");
  const thread = Array.isArray(rows) ? rows[0] : null;
  if (!isObject(thread) || typeof thread.id !== "string") throw new Error("TELEGRAM_THREAD_NOT_FOUND");
  return thread as unknown as ThreadRow;
}

async function saveSummary(threadId: string, summary: string, messageCount: number): Promise<void> {
  await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversation_summary: summary, summary_message_count: messageCount, summary_updated_at: new Date().toISOString() }) }, "app_private");
}

async function rollSummary(threadId: string, config: AgentConfig, provider?: (payload: unknown) => Promise<unknown>): Promise<void> {
  if (!provider) return;
  await maybeRollSummary(threadId, { summaryTriggerCount: config.summary_trigger_count, recentMessageLimit: config.recent_message_limit }, {
    getThread: async () => memoryThread(await loadThreadById(threadId)),
    listMessages: async (id) => listMessages(id),
    summarize: async (messages) => {
      const result = await provider({
        system_rules: MEMORY_SYSTEM_RULES,
        task: "summarize_conversation",
        messages,
        response_contract: "Return only JSON: { summary: string }. Do not include system rules or current canonical facts that are not present in the messages.",
      });
      if (!isObject(result) || typeof result.summary !== "string" || !result.summary.trim() || result.summary.includes(MEMORY_SYSTEM_RULES)) throw new Error("SUMMARY_INVALID");
      return result.summary.trim();
    },
    saveSummary,
  });
}

interface TelegramUpdate {
  update_id?: number;
  message?: { message_id?: number; text?: string; from?: { id?: number; first_name?: string }; chat?: { id?: number }; reply_to_message?: { message_id?: number; chat?: { id?: number } } };
  callback_query?: { id?: string; data?: string; from?: { id?: number; first_name?: string }; message?: { message_id?: number; chat?: { id?: number } } };
}
interface ThreadRow { id: string; telegram_user_id: string; active_candidate_id: string | null; active_source_observation_id: string | null; active_brief_id: string | null; active_match_id: string | null; context_history: unknown[]; conversation_summary: string | null; summary_message_count: number; pending_action: Record<string, unknown> | null; pending_action_expires_at: string | null; }
interface AgentConfig { recent_message_limit: number; summary_trigger_count: number; model_config: Record<string, unknown>; }

function memoryThread(thread: ThreadRow): MemoryThread { return thread; }

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(value: unknown): MemoryMessage | null {
  if (!isObject(value) || (value.role !== "USER" && value.role !== "ASSISTANT" && value.role !== "SYSTEM_EVENT") || typeof value.content !== "string" || typeof value.created_at !== "string") return null;
  return { role: value.role, content: value.content, created_at: value.created_at };
}

function defaultAgentConfig(): AgentConfig {
  return { recent_message_limit: 12, summary_trigger_count: 20, model_config: {} };
}

function update(value: unknown): TelegramUpdate { return value as TelegramUpdate; }
function isCallbackUpdate(value: TelegramUpdate): boolean { return typeof value.callback_query?.id === "string"; }
function telegramChatId(value: TelegramUpdate): number | null { return value.message?.chat?.id ?? value.callback_query?.message?.chat?.id ?? null; }
function telegramUserId(value: TelegramUpdate): number | null { return value.message?.from?.id ?? value.callback_query?.from?.id ?? null; }
function callbackMessageId(value: TelegramUpdate): number | null { return value.callback_query?.message?.message_id ?? null; }
function callbackId(value: TelegramUpdate): string | null { return value.callback_query?.id ?? null; }
function content(value: TelegramUpdate): string { return value.message?.text?.trim() || value.callback_query?.data?.trim() || "[Telegram update]"; }

async function ensureThread(value: TelegramUpdate): Promise<ThreadRow> {
  const chatId = telegramChatId(value);
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
  const claimed = await rest("/rest/v1/telegram_messages?on_conflict=telegram_update_id", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation" }, body: JSON.stringify({ thread_id: thread.id, telegram_message_id: incoming.message?.message_id ?? null, telegram_update_id: incoming.update_id, role: "USER", message_type: isCallbackUpdate(incoming) ? "CONSOLE" : parseCommand(content(incoming)) ? "COMMAND" : "TEXT", content: content(incoming), metadata: isCallbackUpdate(incoming) ? { callback_query_id: callbackId(incoming) } : { reply_to_message_id: parseReplyMessageId(incoming) } }) }, "app_private");
  return Array.isArray(claimed) && claimed.length > 0;
}

async function sendAndPersist(thread: ThreadRow, value: TelegramUpdate, reply: string): Promise<void> {
  const client = createTelegramClient({ token: botToken });
  const sent = await client.sendText(value.message?.chat?.id ?? "", reply);
  await rest("/rest/v1/telegram_messages", { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ thread_id: thread.id, telegram_message_id: sent.message_id, telegram_update_id: null, role: "ASSISTANT", message_type: "TEXT", content: reply, metadata: { in_reply_to_update_id: value.update_id ?? null } }) }, "app_private");
}

function emptyConsoleState(messageId: number | null = null): ConsoleState {
  return { view: "HOME", mode: null, page: 1, story_id: null, story_fingerprint: null, brief_id: null, telegram_message_id: messageId, state_version: 1 };
}

function consoleStateFromRow(value: Record<string, unknown>): ConsoleState {
  const json = isObject(value.state_json) ? value.state_json : {};
  const viewName = value.view_name;
  const view = viewName === "DETAIL" ? "DETAIL" : viewName === "EVIDENCE" ? "EVIDENCE" : viewName === "REEL" ? "REEL" : viewName === "DRAFT" ? "DRAFT" : viewName === "ALL" || viewName === "TRENDING" || viewName === "RECOMMENDED" ? "LIST" : "HOME";
  const mode = viewName === "ALL" ? "all" : viewName === "TRENDING" ? "trending" : viewName === "RECOMMENDED" ? "recommended" : json.mode === "all" ? "all" : json.mode === "trending" ? "trending" : json.mode === "recommended" ? "recommended" : null;
  return {
    view,
    mode,
    page: typeof value.page === "number" && value.page > 0 ? value.page : 1,
    story_id: typeof value.story_cluster_id === "string" ? value.story_cluster_id : null,
    story_fingerprint: typeof json.story_fingerprint === "string" ? json.story_fingerprint : null,
    brief_id: typeof value.brief_id === "string" ? value.brief_id : null,
    telegram_message_id: typeof value.telegram_message_id === "number" ? value.telegram_message_id : null,
    state_version: typeof value.state_version === "number" && value.state_version > 0 ? value.state_version : 1,
  };
}

async function loadConsoleState(threadId: string): Promise<ConsoleState> {
  const rows = await rest(`/rest/v1/telegram_console_state?select=*&thread_id=eq.${encodeURIComponent(threadId)}&limit=1`, {}, "app_private");
  if (Array.isArray(rows) && isObject(rows[0])) return consoleStateFromRow(rows[0]);
  const created = await rest("/rest/v1/telegram_console_state", { method: "POST", headers: { "content-type": "application/json", prefer: "return=representation" }, body: JSON.stringify({ thread_id: threadId }) }, "app_private");
  return Array.isArray(created) && isObject(created[0]) ? consoleStateFromRow(created[0]) : emptyConsoleState();
}

async function latestPresentedStories(threadId: string): Promise<Array<{ story_id: string; title: string }>> {
  const rows = await rest(`/rest/v1/telegram_messages?select=metadata&thread_id=eq.${encodeURIComponent(threadId)}&role=eq.ASSISTANT&order=created_at.desc&limit=30`, {}, "app_private").catch(() => []);
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isObject(row) || !isObject(row.metadata) || !Array.isArray(row.metadata.story_positions)) continue;
    return row.metadata.story_positions.slice(0, 5).flatMap((value) => isObject(value) && typeof value.story_id === "string" && typeof value.title === "string" ? [{ story_id: value.story_id, title: value.title }] : []);
  }
  return [];
}

async function saveConsoleState(threadId: string, state: ConsoleState): Promise<void> {
  const viewName = state.view === "LIST" ? state.mode === "all" ? "ALL" : state.mode === "trending" ? "TRENDING" : "RECOMMENDED" : state.view;
  await rest(`/rest/v1/telegram_console_state?thread_id=eq.${encodeURIComponent(threadId)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ view_name: viewName, page: state.page, story_cluster_id: state.story_id, brief_id: state.brief_id, telegram_message_id: state.telegram_message_id, state_version: state.state_version, state_json: { mode: state.mode, story_fingerprint: state.story_fingerprint } }) }, "app_private");
}

async function skippedFingerprints(threadId: string, rankingDate: string): Promise<ReadonlySet<string>> {
  const rows = await rest(`/rest/v1/telegram_editorial_dispositions?select=story_fingerprint&thread_id=eq.${encodeURIComponent(threadId)}&ranking_date=eq.${encodeURIComponent(rankingDate)}&disposition=eq.SKIPPED`, {}, "app_private");
  return new Set(Array.isArray(rows) ? rows.flatMap((value) => isObject(value) && typeof value.story_fingerprint === "string" ? [value.story_fingerprint] : []) : []);
}

async function currentConsoleStories(thread: ThreadRow, mode: "recommended" | "all"): Promise<readonly CanonicalStory[]> {
  const date = businessDate(new Date(), "Asia/Seoul");
  const stories = await consoleRepository.listCanonicalStories(date);
  if (mode === "all") return stories;
  const skipped = await skippedFingerprints(thread.id, date);
  return stories.filter((story) => story.recommended && !skipped.has(story.story_fingerprint));
}

async function currentTrendingStories(): Promise<readonly CanonicalStory[]> {
  return await consoleRepository.listTrendingStories(businessDate(new Date(), "Asia/Seoul"));
}

async function invokeDiscovery(threadId: string): Promise<{ status: string; run_id?: string; new_story_count?: number; provider_failures?: number }> {
  try {
    return await enqueueManualDiscovery(editorialJobQueue, threadId, crypto.randomUUID(), new Date(), manualDiscoveryPayload);
  } catch {
    return { status: "FAILED", provider_failures: 1 };
  }
}

async function resolveConsoleStory(thread: ThreadRow, token: string): Promise<CanonicalStory | null> {
  const stories = await consoleRepository.listCanonicalStories(businessDate(new Date(), "Asia/Seoul"));
  return findCanonicalStoryByToken(stories, token);
}

async function recordConsoleEvent(threadId: string, incoming: TelegramUpdate, event: { action: string; status: string; metadata?: Record<string, unknown> }): Promise<void> {
  await rest("/rest/v1/telegram_console_events", { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ thread_id: threadId, action: event.action, status: event.status, telegram_update_id: incoming.update_id ?? null, metadata: event.metadata ?? {} }) }, "app_private").catch(() => undefined);
}

function storedBriefToManutdDraft(row: Record<string, unknown>, story: CanonicalStory): ManutdEditorCarouselDraft {
  const slidesJson = isObject(row.slides_json) ? row.slides_json : {};
  const rawSlides = Array.isArray(slidesJson.slides) ? slidesJson.slides.filter(isObject) : [];
  const slides = rawSlides.map((slide, index) => {
    const body = typeof slide.body === "string" ? slide.body : null;
    const claims = Array.isArray(slide.claims) ? slide.claims.filter(isObject) : [];
    const evidenceIds = claims.flatMap((claim) => Array.isArray(claim.evidence_ids) ? claim.evidence_ids.filter((value): value is string => typeof value === "string") : []);
    const role: EditorialSlideRole = slide.role === "HOOK" || slide.role === "CONTEXT" || slide.role === "KEY_FACT" || slide.role === "IMPLICATION" ? slide.role : index === 0 ? "HOOK" : index === 1 ? "CONTEXT" : index === 2 ? "KEY_FACT" : "IMPLICATION";
    const visual = isObject(slide.visual_direction) ? slide.visual_direction : null;
    return { index: typeof slide.index === "number" ? slide.index : index + 1, role, headline: typeof slide.headline === "string" && slide.headline.trim() ? slide.headline : story.title, highlight: typeof slide.highlight === "string" ? slide.highlight : null, body: role === "HOOK" ? null : body, closing_line: typeof slide.closing_line === "string" ? slide.closing_line : null, evidence_ids: [...new Set(evidenceIds)], ...(visual && typeof visual.subject === "string" && typeof visual.image_type === "string" && typeof visual.layout_intent === "string" ? { visual_direction: { subject: visual.subject, image_type: visual.image_type, layout_intent: visual.layout_intent, stat_emphasis: typeof visual.stat_emphasis === "string" ? visual.stat_emphasis : null } } : {}) };
  });
  const caption = typeof row.caption_draft === "string" ? row.caption_draft : "";
  const groundingJson = isObject(row.grounding_json) ? row.grounding_json : {};
  const storedGrounding = isObject(slidesJson.internal_grounding) ? slidesJson.internal_grounding : isObject(groundingJson.internal_grounding) ? groundingJson.internal_grounding : {};
  const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return {
    style_profile: typeof row.style_profile === "string" ? row.style_profile : "manutd_editor",
    style_version: typeof row.style_version === "string" ? row.style_version : "manutd-editor-v1",
    story_id: story.id,
    creative_brief_id: typeof row.id === "string" ? row.id : null,
    slides,
    caption: { body: caption, cta: typeof row.cta === "string" ? row.cta : null },
    editor_warning: typeof slidesJson.editor_warning === "string" ? slidesJson.editor_warning : typeof row.editor_warning === "string" ? row.editor_warning : slides.length < 3 ? "현재 근거로는 3장까지 구성하는 것이 적절합니다." : null,
    internal_grounding: { evidence_ids: stringList(storedGrounding.evidence_ids).length > 0 ? stringList(storedGrounding.evidence_ids) : story.evidence.map((evidence) => evidence.evidence_id), source_caveats: stringList(storedGrounding.source_caveats).length > 0 ? stringList(storedGrounding.source_caveats) : story.grounding_status === "VERIFIED" ? [] : [story.grounding_status], unsupported_claims: stringList(storedGrounding.unsupported_claims) },
  };
}

async function generateCanonicalCarousel(story: CanonicalStory, options: { trust_state?: "VERIFIED" | "REPORTED" | "DISCOVERY"; slide_count?: number } = {}): Promise<ManutdEditorCarouselDraft> {
  if (!story.candidate_id) throw new Error("CANDIDATE_NOT_FOUND");
  const secret = Deno.env.get("COLLECTOR_INVOKE_SECRET") ?? "";
  if (!secret) throw new Error("COLLECTOR_INVOKE_SECRET_MISSING");
  const brief = await invokeCanonicalCarousel(story.candidate_id, {
    invoke: async (input) => {
      const response = await fetch(`${base}/functions/v1/creative-generation`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(input) });
      const result = await response.json().catch(() => ({}));
      return response.ok ? result : { status: "FAILED_PROVIDER" };
    },
    loadBrief: async (id) => await rowById(`/rest/v1/creative_briefs?select=*&id=eq.${encodeURIComponent(id)}&limit=1`),
  }, story.id, options);
  return storedBriefToManutdDraft(brief, story);
}

async function skipCanonicalStory(thread: ThreadRow, story: CanonicalStory): Promise<void> {
  await rest(`/rest/v1/telegram_editorial_dispositions?on_conflict=thread_id,story_cluster_id,ranking_date,story_fingerprint`, { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ thread_id: thread.id, candidate_id: story.candidate_id, story_cluster_id: story.id, ranking_date: story.ranking_date, story_fingerprint: story.story_fingerprint, disposition: "SKIPPED" }) }, "app_private");
}

async function selectCanonicalDraft(thread: ThreadRow, token: string): Promise<void> {
  const state = await loadConsoleState(thread.id);
  const briefId = state.brief_id && (state.brief_id === token || shortCallbackToken(state.brief_id) === token) ? state.brief_id : token;
  await rest(`/rest/v1/creative_briefs?id=eq.${encodeURIComponent(briefId)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ status: "SELECTED", selected_at: new Date().toISOString() }) });
}

function consoleDependencies(thread: ThreadRow, replyContext: ReplyContext | null = null) {
  return {
    listStories: async (mode: "recommended" | "all", page: number) => paginateStories(await currentConsoleStories(thread, mode), page),
    listTrendingStories: async (page: number) => paginateStories(await currentTrendingStories(), page),
    discoverMore: async () => await invokeDiscovery(thread.id),
    refreshDiscovery: async () => await invokeDiscovery(thread.id),
    getStoryByToken: async (token: string) => {
      if (replyContext && replyContext.story_cluster?.id === token) return canonicalStoryFromReplyContext(replyContext);
      return await resolveConsoleStory(thread, token);
    },
    skipStory: async (story: CanonicalStory) => await skipCanonicalStory(thread, story),
    generateCarousel: async (story: CanonicalStory, options?: { trust_state: "VERIFIED" | "REPORTED" | "DISCOVERY"; slide_count?: number }) => await generateCanonicalCarousel(story, options),
    selectDraft: async (token: string) => await selectCanonicalDraft(thread, token),
  };
}

async function sendConsoleView(thread: ThreadRow, incoming: TelegramUpdate, state: ConsoleState, view: ConsoleView, metadata: Record<string, unknown> = {}): Promise<ConsoleState> {
  const client = createTelegramClient({ token: botToken });
  const chatId = telegramChatId(incoming) ?? "";
  const messageId = callbackMessageId(incoming);
  let sentMessageId: number | null = messageId;
  const markup = { inline_keyboard: view.inline_keyboard };
  if (messageId !== null) {
    try { await client.editMessageText(chatId, messageId, view.text, markup); } catch { const sent = await client.sendText(chatId, view.text, markup); sentMessageId = sent.message_id; }
  } else {
    const sent = await client.sendText(chatId, view.text, markup);
    sentMessageId = sent.message_id;
  }
  const next = { ...state, telegram_message_id: sentMessageId };
  await saveConsoleState(thread.id, next);
  await rest("/rest/v1/telegram_messages", { method: "POST", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ thread_id: thread.id, telegram_message_id: sentMessageId, telegram_update_id: null, role: "ASSISTANT", message_type: "CONSOLE", content: view.text, metadata: { in_reply_to_update_id: incoming.update_id ?? null, ...(Array.isArray(metadata.presented_stories) ? { story_positions: metadata.presented_stories } : {}) } }) }, "app_private");
  return next;
}

async function runConsoleAction(thread: ThreadRow, incoming: TelegramUpdate, action: ConsoleAction, repliedStoryId: string | null = null, replyContext: ReplyContext | null = null): Promise<{ status: string; reply: string }> {
  const client = createTelegramClient({ token: botToken });
  const queryId = callbackId(incoming);
  if (queryId) await client.answerCallbackQuery(queryId).catch(() => undefined);
  const state = await loadConsoleState(thread.id);
  const incomingMessageId = callbackMessageId(incoming);
  const staleCallback = incomingMessageId !== null && state.telegram_message_id !== null && incomingMessageId !== state.telegram_message_id;
  if (staleCallback && !canHandleStaleConsoleCallback(action)) {
    if (queryId) await client.answerCallbackQuery(queryId, "이전 화면입니다. 최신 목록을 열어 주세요.").catch(() => undefined);
    await recordConsoleEvent(thread.id, incoming, { action: "STALE_CALLBACK", status: "STALE" });
    return { status: "STALE", reply: "이전 화면입니다. 최신 목록을 열어 주세요." };
  }
  const targetState = action.type === "GENERATE_CAROUSEL" && repliedStoryId ? { ...state, story_id: repliedStoryId } : state;
  const result = await dispatchEditorialConsoleAction(action, { ...targetState, telegram_message_id: incomingMessageId ?? state.telegram_message_id }, consoleDependencies(thread, replyContext));
  if (action.type === "GENERATE_CAROUSEL" && repliedStoryId && result.event.status !== "COMPLETED") result.next_state = state;
  await recordConsoleEvent(thread.id, incoming, result.event);
  await sendConsoleView(thread, incoming, result.next_state, result.view, result.event.metadata ?? {});
  if (result.event.status === "COMPLETED" && action.type === "GENERATE_CAROUSEL" && result.next_state.story_id && result.next_state.brief_id) {
    const story = await consoleDependencies(thread, replyContext).getStoryByToken(result.next_state.story_id);
    if (story?.candidate_id) await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: story.candidate_id, active_source_observation_id: null, active_brief_id: result.next_state.brief_id }) }, "app_private");
  }
  if (result.event.status === "COMPLETED" && (action.type === "OPEN_STORY" || action.type === "OPEN_EVIDENCE") && result.next_state.story_id) {
    const story = await consoleDependencies(thread, replyContext).getStoryByToken(result.next_state.story_id);
    if (story?.candidate_id) await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: story.candidate_id, active_source_observation_id: null }) }, "app_private");
  }
  return { status: result.event.status, reply: result.view.text };
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
  await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_brief_id: storedId, active_candidate_id: revision.candidate_id, active_source_observation_id: null, pending_action: null, pending_action_expires_at: null }) }, "app_private");
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

const HELP = "/today · /current · /open <1..3|uuid|alert> · /brief · /hook <1..3> · /slide <1..7> <지시> · /caption <지시> · /select · /status · /back · /reset · /confirm · /cancel · /help";

function latestCurrentSnapshot(thread: ThreadRow): { items?: Array<Record<string, unknown>> } | null {
  for (const value of [...thread.context_history].reverse()) {
    if (!isObject(value) || value.type !== "CURRENT_CANDIDATES" || !isObject(value.snapshot)) continue;
    return value.snapshot as { items?: Array<Record<string, unknown>> };
  }
  return null;
}

async function saveCurrentSnapshot(thread: ThreadRow, snapshot: unknown): Promise<void> {
  const history = Array.isArray(thread.context_history) ? thread.context_history.filter((value) => !isObject(value) || value.type !== "CURRENT_CANDIDATES") : [];
  history.push({ type: "CURRENT_CANDIDATES", snapshot });
  await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ context_history: history.slice(-5) }) }, "app_private");
}

async function commandReply(command: ParsedCommand, thread: ThreadRow): Promise<string> {
  if (command.type === "HELP") return HELP;
  if (command.type === "RESET") {
    await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: null, active_source_observation_id: null, active_brief_id: null, active_match_id: null, context_history: [], pending_action: null, pending_action_expires_at: null }) }, "app_private");
    return "현재 작업 맥락을 초기화했습니다. 대화 기록과 요약은 보존됩니다.";
  }
  if (command.type === "TODAY") {
    const rows = await rest(`/rest/v1/telegram_briefings?select=rendered_message,briefing_date&thread_id=eq.${encodeURIComponent(thread.id)}&order=briefing_date.desc&limit=1`, {}, "app_private");
    return Array.isArray(rows) && rows[0] && typeof rows[0].rendered_message === "string" ? rows[0].rendered_message : "저장된 오늘 브리핑이 없습니다.";
  }
  if (command.type === "CURRENT") {
    const briefingDate = businessDate(new Date(), "Asia/Seoul");
    const state = await repository.getIntelligenceReadiness(briefingDate);
    const rows = await repository.listBriefingCandidates(briefingDate, state?.started_at);
    const readiness = classifyReadiness(state, briefingDate, countReadinessCandidates(rows));
    const visibleRows = selectBriefingCandidates(rows);
    const snapshot = snapshotCurrentCandidates(briefingDate, visibleRows);
    await saveCurrentSnapshot(thread, snapshot);
    return formatCurrentReply({ briefingDate, readiness, candidateCount: visibleRows.length, items: snapshot.items.map((item) => ({ position: item.position, candidateId: item.candidate_id, priorityScore: item.priority_score, username: item.reference_username, title: item.title, sourceName: item.source_name })) });
  }
  if (command.type === "STATUS") return thread.active_candidate_id ? `현재 후보 ${thread.active_candidate_id}의 최신 상태를 확인하세요.` : thread.active_source_observation_id ? `현재 사실 소스 ${thread.active_source_observation_id}를 확인하세요.` : "활성 후보가 없습니다. /today 또는 /open으로 시작하세요.";
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
      await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: typeof alert.candidate_id === "string" ? alert.candidate_id : null, active_source_observation_id: null, active_match_id: typeof alert.match_id === "string" ? alert.match_id : null }) }, "app_private");
      return `최근 alert를 열었습니다.${typeof alert.payload?.permalink === "string" ? `\n🔗 원문: ${alert.payload.permalink}` : ""}`;
    }
    const rows = await rest(`/rest/v1/telegram_briefings?select=candidate_snapshot&thread_id=eq.${encodeURIComponent(thread.id)}&order=briefing_date.desc&limit=1`, {}, "app_private");
    const snapshot = latestCurrentSnapshot(thread) ?? (Array.isArray(rows) && rows[0] && typeof rows[0].candidate_snapshot === "object" ? rows[0].candidate_snapshot as { items?: Array<Record<string, unknown>> } : {});
    const item = snapshot.items?.find((candidate) => command.target === String(candidate.position) || command.target === String(candidate.candidate_id));
    if (!item || typeof item.candidate_id !== "string") return "현재 브리핑에서 해당 후보를 찾지 못했습니다.";
    const sourceObservationId = item.candidate_id.startsWith("source:") ? item.candidate_id.slice("source:".length) : null;
    await rest(`/rest/v1/telegram_threads?id=eq.${encodeURIComponent(thread.id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal" }, body: JSON.stringify({ active_candidate_id: sourceObservationId ? null : item.candidate_id, active_source_observation_id: sourceObservationId, active_brief_id: null, pending_action: null, pending_action_expires_at: null }) }, "app_private");
    const link = typeof item.source_url === "string" ? `\n🔗 원문: ${item.source_url}` : typeof item.reference_permalink === "string" ? `\n🔗 원문: ${item.reference_permalink}` : "";
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
  if (isCallbackUpdate(incoming)) {
    const action = parseConsoleCallback(incoming.callback_query?.data ?? "");
    if (!action) {
      const queryId = callbackId(incoming);
      if (queryId) await createTelegramClient({ token: botToken }).answerCallbackQuery(queryId, "지원하지 않는 버튼입니다.").catch(() => undefined);
      return { status: "INVALID_CALLBACK", reply: "지원하지 않는 버튼입니다." };
    }
    return await runConsoleAction(thread, incoming, action);
  }
  const text = content(incoming);
  const repliedMessageId = parseReplyMessageId(incoming);
  const replied = repliedMessageId === null ? null : await loadReplyContext(thread.id, repliedMessageId);
  const consoleIntent = replyConsoleIntent(text, thread.active_candidate_id, replied?.storyId ?? null);
  if (repliedMessageId !== null && consoleIntent?.type === "GENERATE_CAROUSEL" && !replied?.storyId) {
    const reply = "답장한 메시지의 canonical 소재를 찾지 못했습니다. 소재 알림에 답장해 다시 요청해 주세요.";
    await sendAndPersist(thread, incoming, reply);
    return { status: "REPLY_STORY_NOT_FOUND", reply };
  }
  if (consoleIntent) return await runConsoleAction(thread, incoming, consoleIntent, replied?.storyId ?? null, replied?.context ?? null);
  const command = parseCommand(text);
  const config = await loadAgentConfig();
  const provider = Deno.env.get("OPENAI_API_KEY") ? createOpenAIGenerator({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "", model: typeof config.model_config.conversation_model === "string" ? config.model_config.conversation_model : undefined }) : undefined;
  if (!command && provider) {
    const consoleState = await loadConsoleState(thread.id);
    const presented = await latestPresentedStories(thread.id);
    const intent = await parseEditorialIntent(text, { generate: provider, presented_titles: presented.map((item) => item.title), has_active_story: Boolean(replied?.storyId || consoleState.story_id), has_active_draft: Boolean(thread.active_brief_id || consoleState.brief_id) });
    let action: ConsoleAction | null = null;
    if (intent.intent === "OPEN_RECOMMENDED") action = { type: "OPEN_RECOMMENDED", page: 1 };
    if (intent.intent === "OPEN_TRENDING") action = { type: "OPEN_TRENDING", page: 1 };
    if (intent.intent === "DISCOVER_MORE") action = { type: "DISCOVER_MORE" };
    if (intent.intent === "OPEN_STORY" || intent.intent === "GENERATE_CAROUSEL" || intent.intent === "SHOW_SOURCES") {
      const selected = intent.story_position ? resolvePresentedStoryPosition(presented, intent.story_position) : null;
      const activeStory = replied?.storyId ?? consoleState.story_id;
      if (intent.story_position && !selected) {
        const reply = "최근에 보여드린 목록에서 그 번호를 찾지 못했습니다. 최신 목록을 다시 열어 주세요.";
        await sendAndPersist(thread, incoming, reply);
        return { status: "STORY_POSITION_NOT_FOUND", reply };
      }
      const token = selected?.story_id ?? activeStory ?? null;
      if (!token) {
        const reply = "먼저 소재 목록을 보여드릴까요? '오늘 뭐 있어?'라고 말씀해 주세요.";
        await sendAndPersist(thread, incoming, reply);
        return { status: "ACTIVE_STORY_REQUIRED", reply };
      }
      action = intent.intent === "OPEN_STORY" ? { type: "OPEN_STORY", token }
        : intent.intent === "SHOW_SOURCES" ? { type: "OPEN_EVIDENCE", token }
        : { type: "GENERATE_CAROUSEL", token, ...(intent.slide_count ? { slide_count: intent.slide_count } : {}) };
    }
    if (intent.intent === "EDIT_DRAFT" && intent.edit_target && intent.instruction) {
      const revisionCommand: ParsedCommand = intent.edit_target === "caption" ? { type: "CAPTION", instruction: intent.instruction } : { type: "SLIDE", slide: Number(intent.edit_target.slice("slide_".length)), instruction: intent.instruction };
      const revised = await revisionForCommand(revisionCommand, thread);
      await sendAndPersist(thread, incoming, revised.reply);
      return { status: revised.revision ? "REVISION_SAVED" : "REVISION_NOT_SAVED", reply: revised.reply };
    }
    if (action) return await runConsoleAction(thread, incoming, action, replied?.storyId ?? null, replied?.context ?? null);
  }
  const reply = command ? await commandReply(command, thread) : await answerNaturalLanguage(thread.id, text, {
    getThread: async () => memoryThread(thread),
    listMessages: async (threadId) => listMessages(threadId, config.recent_message_limit),
    loadCanonicalContext: async (currentThread) => loadCanonicalContext(currentThread),
    generate: provider ?? (async () => { throw new Error("OPENAI_NOT_CONFIGURED"); }),
    retrieveHistory: async (messageText, currentThread) => retrieveHistoricalContext(messageText, currentThread, await retrievalDependencies(currentThread)),
    recentMessageLimit: config.recent_message_limit,
    replyContext: replied?.context,
  });
  await sendAndPersist(thread, incoming, reply);
  if (!command) await rollSummary(thread.id, config, provider).catch(() => undefined);
  return { status: "SENT", reply };
}

Deno.serve(createTelegramAgentHandler({ invokeSecret, webhookSecret, ownerUserId, claimUpdate, run: runAgent }));
