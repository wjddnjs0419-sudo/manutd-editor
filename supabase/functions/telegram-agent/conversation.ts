import {
  ASSISTANT_IDENTITY,
  MEMORY_SYSTEM_RULES,
  buildConversationContext,
  type MemoryMessage,
  type MemoryThread,
  type ConversationContext,
} from "../_shared/m6/memory.ts";
import {
  shouldRetrieveHistory,
  type HistoricalContext,
} from "../_shared/m6/retrieval.ts";
import { parseConsoleIntent, type ConsoleAction } from "../_shared/m6/editorial_console_actions.ts";

export interface CanonicalConversationContext {
  candidate: Record<string, unknown> | null;
  source_observation?: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  match: Record<string, unknown> | null;
  story_cluster?: Record<string, unknown> | null;
  editorial_ranking?: Record<string, unknown> | null;
  evidence?: readonly Record<string, unknown>[];
}

export interface ReplyReference {
  story_cluster_id: string | null;
  candidate_id: string | null;
  evidence_ids: readonly string[];
}

export interface ConversationReplyDependencies {
  generate: (payload: unknown) => Promise<unknown>;
  canonical_context?: CanonicalConversationContext;
  retrieveHistory?: () => Promise<readonly HistoricalContext[]>;
}

export interface NaturalLanguageReplyDependencies {
  getThread: (threadId: string) => Promise<MemoryThread>;
  listMessages: (threadId: string) => Promise<readonly MemoryMessage[]>;
  loadCanonicalContext: (thread: MemoryThread) => Promise<CanonicalConversationContext>;
  generate: (payload: unknown) => Promise<unknown>;
  retrieveHistory?: (message: string, thread: MemoryThread) => Promise<readonly HistoricalContext[]>;
  recentMessageLimit?: number;
  replyContext?: { story_cluster: Record<string, unknown> | null; candidate: Record<string, unknown> | null; editorial_ranking?: Record<string, unknown> | null; source_observation?: Record<string, unknown> | null; evidence: readonly Record<string, unknown>[] };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReplyMessageId(update: unknown): number | null {
  if (!object(update) || !object(update.message) || !object(update.message.reply_to_message)) return null;
  const id = update.message.reply_to_message.message_id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function resolveReplyReference(
  threadId: string,
  messageId: number,
  lookup: (threadId: string, messageId: number) => Promise<unknown>,
): Promise<ReplyReference | null> {
  const row = await lookup(threadId, messageId);
  if (!object(row) || row.role !== "ASSISTANT" || !object(row.metadata)) return null;
  const metadata = row.metadata;
  const id = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
  const storyId = id(metadata.story_cluster_id);
  const candidateId = id(metadata.candidate_id);
  if (!storyId && !candidateId) return null;
  const evidenceIds = Array.isArray(metadata.evidence_ids) ? [...new Set(metadata.evidence_ids.flatMap((value) => id(value) ? [id(value)!] : []))] : [];
  return { story_cluster_id: storyId, candidate_id: candidateId, evidence_ids: evidenceIds };
}

export function replyConsoleIntent(text: string, activeCandidateId: string | null, repliedStoryId: string | null): ConsoleAction | null {
  const intent = parseConsoleIntent(text, activeCandidateId);
  return intent?.type === "GENERATE_CAROUSEL" && repliedStoryId ? { ...intent, token: repliedStoryId } : intent;
}

const LEAKED_RULES = [
  MEMORY_SYSTEM_RULES,
  "Natural-language conversation is read-only.",
  "Never claim that a mutation occurred.",
  "Never use external web search.",
  "Project facts must come from supplied canonical context.",
  "If evidence is insufficient, say so.",
];

export function validateConversationReply(value: unknown): string {
  const reply = object(value) && typeof value.reply === "string" ? value.reply.trim() : "";
  if (!reply || LEAKED_RULES.some((rule) => reply.includes(rule))) throw new Error("CONVERSATION_REPLY_INVALID");
  return reply;
}

function fallback(): string {
  return "현재 확인 가능한 canonical context를 바탕으로 답변할 수 없습니다. 관련 후보를 /open으로 열거나, 확인할 내용을 조금 더 구체적으로 말씀해 주세요.";
}

export async function createConversationReply(
  message: string,
  context: ConversationContext,
  dependencies: ConversationReplyDependencies,
): Promise<string> {
  let historicalContext: readonly HistoricalContext[] = [];
  if (shouldRetrieveHistory(message) && dependencies.retrieveHistory) {
    try {
      historicalContext = await dependencies.retrieveHistory();
    } catch {
      historicalContext = [];
    }
  }

  const payload = {
    assistant_identity: ASSISTANT_IDENTITY,
    system_rules: context.system_rules,
    summary: context.summary,
    recent_messages: context.recent_messages,
    active_state: context.active_state,
    canonical_context: dependencies.canonical_context ?? null,
    historical_context: historicalContext,
    user_message: message,
    response_contract: "Return only JSON: { reply: string }. Use assistant_identity for identity or role questions. Use supplied canonical_context for project facts and say when project evidence is insufficient.",
  };

  try {
    return validateConversationReply(await dependencies.generate(payload));
  } catch {
    return fallback();
  }
}

export async function answerNaturalLanguage(
  threadId: string,
  message: string,
  dependencies: NaturalLanguageReplyDependencies,
): Promise<string> {
  const thread = await dependencies.getThread(threadId);
  const context = await buildConversationContext(threadId, message, {
    getThread: async () => thread,
    listMessages: dependencies.listMessages,
  }, dependencies.recentMessageLimit ?? 12);
  return createConversationReply(message, context, {
    canonical_context: dependencies.replyContext
      ? { ...await dependencies.loadCanonicalContext(thread), brief: null, match: null, source_observation: null, ...dependencies.replyContext }
      : await dependencies.loadCanonicalContext(thread),
    generate: dependencies.generate,
    retrieveHistory: dependencies.retrieveHistory ? () => dependencies.retrieveHistory?.(message, thread) ?? Promise.resolve([]) : undefined,
  });
}
