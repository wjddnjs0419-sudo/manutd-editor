import { assert, assertEquals } from "jsr:@std/assert@1";
import { createConversationReply } from "../../telegram-agent/conversation.ts";
import { MEMORY_SYSTEM_RULES, type ConversationContext } from "../../_shared/m6/memory.ts";

const context: ConversationContext = {
  system_rules: MEMORY_SYSTEM_RULES,
  summary: "사용자는 차분한 편집 톤을 선호한다.",
  recent_messages: Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "USER" as const : "ASSISTANT" as const,
    content: `최근-${index + 1}`,
    created_at: `2026-09-20T00:${String(index).padStart(2, "0")}:00.000Z`,
  })),
  active_state: { candidate_id: "candidate-1", brief_id: "brief-2", match_id: "match-3" },
  user_message: "지금 보고 있는 후보가 뭐야?",
};

Deno.test("natural-language reply calls the model once without leaking memory rules", async () => {
  let calls = 0;
  const reply = await createConversationReply("너 누구야", context, {
    canonical_context: { candidate: { id: "candidate-1", priority_score: 88 }, brief: { id: "brief-2", status: "READY" }, match: { id: "match-3", status: "FINISHED" } },
    generate: async () => {
      calls += 1;
      return { reply: "저는 ManUtd Content AI입니다. 확인 가능한 프로젝트 정보만 바탕으로 도와드립니다." };
    },
  });

  assertEquals(calls, 1);
  assert(!reply.includes(MEMORY_SYSTEM_RULES));
  assert(!reply.includes("Natural-language conversation is read-only."));
});

Deno.test("conversation prompt keeps the latest 12 messages, summary, active IDs, and canonical rows", async () => {
  let captured: unknown;
  await createConversationReply(context.user_message, context, {
    canonical_context: { candidate: { id: "candidate-1", priority_score: 88 }, brief: { id: "brief-2", status: "READY" }, match: { id: "match-3", status: "FINISHED" } },
    generate: async (payload) => {
      captured = payload;
      return { reply: "현재 후보는 candidate-1입니다." };
    },
  });

  const payload = captured as { summary: string; recent_messages: unknown[]; active_state: unknown; canonical_context: unknown; historical_context: unknown[] };
  assertEquals(payload.summary, context.summary);
  assertEquals(payload.recent_messages.length, 12);
  assertEquals(payload.active_state, context.active_state);
  assertEquals(payload.canonical_context, { candidate: { id: "candidate-1", priority_score: 88 }, brief: { id: "brief-2", status: "READY" }, match: { id: "match-3", status: "FINISHED" } });
  assertEquals(payload.historical_context, []);
});

Deno.test("historical retrieval is gated by explicit history intent", async () => {
  let retrievalCalls = 0;
  const retrieveHistory = async () => {
    retrievalCalls += 1;
    return [{ kind: "match" as const, id: "match-previous", text: "지난 경기 기록" }];
  };

  await createConversationReply("지금 후보를 요약해줘", context, { generate: async () => ({ reply: "현재 후보를 요약했습니다." }), retrieveHistory });
  assertEquals(retrievalCalls, 0);

  await createConversationReply("지난 경기 관련해서 뭐 있었어?", context, { generate: async () => ({ reply: "지난 경기 기록을 확인했습니다." }), retrieveHistory });
  assertEquals(retrievalCalls, 1);
});

Deno.test("model failure and prompt leakage use a deterministic safe fallback", async () => {
  const failed = await createConversationReply("너 누구야", context, { generate: async () => { throw new Error("OPENAI_REQUEST_FAILED"); } });
  assert(!failed.includes(MEMORY_SYSTEM_RULES));
  assert(failed.includes("canonical"));

  const leaked = await createConversationReply("너 누구야", context, { generate: async () => ({ reply: MEMORY_SYSTEM_RULES }) });
  assert(!leaked.includes(MEMORY_SYSTEM_RULES));
  assert(leaked.includes("canonical"));
});
