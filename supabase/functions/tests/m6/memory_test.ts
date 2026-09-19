import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildConversationContext, maybeRollSummary, type MemoryMessage, type MemoryThread } from "../../_shared/m6/memory.ts";

function messages(count: number): MemoryMessage[] {
  return Array.from({ length: count }, (_, index) => ({ role: index % 2 ? "ASSISTANT" as const : "USER" as const, content: `message-${index + 1}`, created_at: new Date(2026, 8, 19, 0, index).toISOString() }));
}

Deno.test("conversation context includes latest 12 raw messages only", async () => {
  const raw = messages(13);
  const thread: MemoryThread = { id: "thread-1", conversation_summary: "기존 요약", summary_message_count: 0, context_history: [], active_candidate_id: "candidate-1", active_brief_id: null, active_match_id: null };
  const context = await buildConversationContext("thread-1", "오늘 뭐가 중요해?", { getThread: async () => thread, listMessages: async () => raw });
  assertEquals(context.recent_messages.length, 12);
  assert(!context.recent_messages.some((message) => message.content === "message-1"));
  assertEquals(context.active_state.candidate_id, "candidate-1");
});

Deno.test("summary folds older messages at threshold but raw history remains intact", async () => {
  const raw = messages(20);
  const thread: MemoryThread = { id: "thread-1", conversation_summary: null, summary_message_count: 0, context_history: [], active_candidate_id: null, active_brief_id: null, active_match_id: null };
  let saved = "";
  let savedCount = 0;
  await maybeRollSummary("thread-1", { summaryTriggerCount: 20, recentMessageLimit: 12 }, {
    getThread: async () => thread,
    listMessages: async () => raw,
    summarize: async (input) => `요약: ${input.map((message) => message.content).join(",")}`,
    saveSummary: async (_id, summary, count) => { saved = summary; savedCount = count; },
  });
  assert(saved.includes("message-1"));
  assertEquals(savedCount, 20);
  assertEquals(raw.length, 20);
});
