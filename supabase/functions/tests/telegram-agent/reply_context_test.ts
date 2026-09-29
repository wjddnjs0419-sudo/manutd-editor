import { assertEquals } from "jsr:@std/assert@1";
import { answerNaturalLanguage, parseReplyMessageId, replyConsoleIntent, resolveReplyReference } from "../../telegram-agent/conversation.ts";

const thread = { id: "thread-1", conversation_summary: null, summary_message_count: 0, context_history: [], active_candidate_id: "candidate-active", active_brief_id: null, active_match_id: null };

Deno.test("reply ID accepts only a positive safe Telegram message integer", () => {
  assertEquals(parseReplyMessageId({ message: { reply_to_message: { message_id: 42 } } }), 42);
  for (const message_id of [0, -1, 1.5, "42", Number.MAX_SAFE_INTEGER + 1]) {
    assertEquals(parseReplyMessageId({ message: { reply_to_message: { message_id } } }), null);
  }
  assertEquals(parseReplyMessageId({ message: {} }), null);
});

Deno.test("reply lookup uses the same thread and resolves canonical metadata", async () => {
  let queried: unknown;
  const reference = await resolveReplyReference("thread-1", 42, async (threadId, messageId) => {
    queried = [threadId, messageId];
    return { role: "ASSISTANT", metadata: { story_cluster_id: "story-1", candidate_id: "candidate-replied", evidence_ids: ["claim:1", "claim:2"] } };
  });
  assertEquals(queried, ["thread-1", 42]);
  assertEquals(reference, { story_cluster_id: "story-1", candidate_id: "candidate-replied", evidence_ids: ["claim:1", "claim:2"] });
});

Deno.test("reply lookup ignores missing and malformed message metadata", async () => {
  assertEquals(await resolveReplyReference("thread-1", 42, async () => null), null);
  assertEquals(await resolveReplyReference("thread-1", 42, async () => ({ role: "USER", metadata: { story_cluster_id: "story-1" } })), null);
  assertEquals(await resolveReplyReference("thread-1", 42, async () => ({ role: "ASSISTANT", metadata: { candidate_id: "", evidence_ids: [1] } })), null);
});

Deno.test("read-only reply supplies temporary canonical story context without changing active state", async () => {
  let payload: Record<string, unknown> = {};
  const reply = await answerNaturalLanguage("thread-1", "이 소식 근거는?", {
    getThread: async () => thread,
    listMessages: async () => [],
    loadCanonicalContext: async () => ({ candidate: { id: "candidate-active" }, brief: { id: "brief-active" }, match: { id: "match-active" } }),
    replyContext: { story_cluster: { id: "story-1", canonical_title: "Replied story" }, candidate: { id: "candidate-replied" }, editorial_ranking: { story_cluster_id: "story-1", rank: 5, grounding_status: "VERIFIED", news_eligible: true }, source_observation: { id: "observation-1", source_name: "Yahoo Sports", canonical_url: "https://sports.yahoo.com/story" }, evidence: [{ id: "claim-1", claim_text: "Confirmed", is_grounding: true }] },
    generate: async (value) => { payload = value as Record<string, unknown>; return { reply: "근거를 확인했습니다." }; },
  });
  assertEquals(reply, "근거를 확인했습니다.");
  assertEquals(payload.active_state, { candidate_id: "candidate-active", brief_id: null, match_id: null });
  assertEquals(payload.canonical_context, { candidate: { id: "candidate-replied" }, brief: null, match: null, source_observation: { id: "observation-1", source_name: "Yahoo Sports", canonical_url: "https://sports.yahoo.com/story" }, story_cluster: { id: "story-1", canonical_title: "Replied story" }, editorial_ranking: { story_cluster_id: "story-1", rank: 5, grounding_status: "VERIFIED", news_eligible: true }, evidence: [{ id: "claim-1", claim_text: "Confirmed", is_grounding: true }] });
  assertEquals(thread.active_candidate_id, "candidate-active");
});

Deno.test("explicit generation on a reply targets its story", () => {
  assertEquals(replyConsoleIntent("카드뉴스 생성", "candidate-active", "story-1"), { type: "GENERATE_CAROUSEL", token: "story-1" });
  assertEquals(replyConsoleIntent("이거 카드뉴스로 만들어줘", "candidate-active", "story-1"), { type: "GENERATE_CAROUSEL", token: "story-1" });
});

Deno.test("non-reply generation and conversation keep active context", async () => {
  assertEquals(replyConsoleIntent("카드뉴스 생성", "candidate-active", null), { type: "GENERATE_CAROUSEL", token: "candidate-active" });
  let payload: Record<string, unknown> = {};
  await answerNaturalLanguage("thread-1", "지금 후보는?", {
    getThread: async () => thread,
    listMessages: async () => [],
    loadCanonicalContext: async () => ({ candidate: { id: "candidate-active" }, brief: null, match: null }),
    generate: async (value) => { payload = value as Record<string, unknown>; return { reply: "현재 후보입니다." }; },
  });
  assertEquals(payload.canonical_context, { candidate: { id: "candidate-active" }, brief: null, match: null });
});
