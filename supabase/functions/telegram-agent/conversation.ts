import {
  MEMORY_SYSTEM_RULES,
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
    system_rules: context.system_rules,
    summary: context.summary,
    recent_messages: context.recent_messages,
    active_state: context.active_state,
    canonical_context: dependencies.canonical_context ?? null,
    historical_context: historicalContext,
    user_message: message,
    response_contract: "Return only JSON: { reply: string }. Use only supplied canonical context and say when evidence is insufficient.",
  };

  try {
    return validateConversationReply(await dependencies.generate(payload));
  } catch {
    return fallback();
  }
}
