export type MemoryRole = "USER" | "ASSISTANT" | "SYSTEM_EVENT";

export interface MemoryMessage {
  role: MemoryRole;
  content: string;
  created_at: string;
}

export interface MemoryThread {
  id: string;
  conversation_summary: string | null;
  summary_message_count: number;
  context_history: readonly unknown[];
  active_candidate_id: string | null;
  active_brief_id: string | null;
  active_match_id: string | null;
}

export interface MemoryDependencies {
  getThread: (threadId: string) => Promise<MemoryThread>;
  listMessages: (threadId: string) => Promise<readonly MemoryMessage[]>;
  saveSummary?: (threadId: string, summary: string, messageCount: number) => Promise<void>;
  summarize?: (messages: readonly MemoryMessage[]) => Promise<string>;
}

export interface ConversationContext {
  system_rules: string;
  summary: string | null;
  recent_messages: readonly MemoryMessage[];
  active_state: { candidate_id: string | null; brief_id: string | null; match_id: string | null };
  user_message: string;
}

export const ASSISTANT_IDENTITY = "ManUtd Content AI는 Manchester United 콘텐츠 편집을 돕는 Telegram editorial assistant입니다.";

export const MEMORY_SYSTEM_RULES = [
  "Natural-language conversation is read-only.",
  "Never claim that a mutation occurred.",
  "Never use external web search.",
  "Project facts must come from supplied canonical context.",
  "If evidence is insufficient, say so.",
].join(" ");

function latest(messages: readonly MemoryMessage[], limit: number): MemoryMessage[] {
  return [...messages].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)).slice(-limit);
}

export async function buildConversationContext(threadId: string, message: string, dependencies: MemoryDependencies, recentMessageLimit = 12): Promise<ConversationContext> {
  const [thread, raw] = await Promise.all([dependencies.getThread(threadId), dependencies.listMessages(threadId)]);
  return {
    system_rules: MEMORY_SYSTEM_RULES,
    summary: thread.conversation_summary,
    recent_messages: latest(raw, recentMessageLimit),
    active_state: { candidate_id: thread.active_candidate_id, brief_id: thread.active_brief_id, match_id: thread.active_match_id },
    user_message: message,
  };
}

export async function maybeRollSummary(
  threadId: string,
  config: { summaryTriggerCount: number; recentMessageLimit: number },
  dependencies: Required<Pick<MemoryDependencies, "getThread" | "listMessages" | "summarize" | "saveSummary">>,
): Promise<void> {
  const thread = await dependencies.getThread(threadId);
  const raw = await dependencies.listMessages(threadId);
  if (raw.length - thread.summary_message_count < config.summaryTriggerCount) return;
  const ordered = [...raw].sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  const older = ordered.slice(0, Math.max(0, ordered.length - config.recentMessageLimit));
  if (older.length === 0) return;
  const summary = (await dependencies.summarize(older)).trim();
  if (!summary) return;
  await dependencies.saveSummary(threadId, summary, raw.length);
}
