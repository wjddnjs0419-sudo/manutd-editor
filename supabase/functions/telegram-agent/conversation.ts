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

export interface CanonicalConversationContext {
  candidate: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  match: Record<string, unknown> | null;
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
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    canonical_context: await dependencies.loadCanonicalContext(thread),
    generate: dependencies.generate,
    retrieveHistory: dependencies.retrieveHistory ? () => dependencies.retrieveHistory?.(message, thread) ?? Promise.resolve([]) : undefined,
  });
}
