import { assertEquals } from "jsr:@std/assert@1";
import { answerNaturalLanguage, canonicalStoryFromReplyContext, parseReplyMessageId, replyConsoleIntent, resolveReplyContext, resolveReplyReference, type ReplyReference } from "../../telegram-agent/conversation.ts";

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
    return {
      role: "ASSISTANT",
      metadata: {
        story_cluster_id: "story-1",
        candidate_id: "candidate-replied",
        primary_source_observation_id: "observation-1",
        ranking_date: "2026-09-27",
        ranking_version: "m8-v1",
        evidence_ids: ["claim:1", "claim:2"],
      },
    };
  });
  assertEquals(queried, ["thread-1", 42]);
  assertEquals(reference, { story_cluster_id: "story-1", candidate_id: "candidate-replied", primary_source_observation_id: "observation-1", ranking_date: "2026-09-27", ranking_version: "m8-v1", evidence_ids: ["claim:1", "claim:2"] });
});

Deno.test("reply lookup ignores missing and malformed message metadata", async () => {
  assertEquals(await resolveReplyReference("thread-1", 42, async () => null), null);
  assertEquals(await resolveReplyReference("thread-1", 42, async () => ({ role: "USER", metadata: { story_cluster_id: "story-1" } })), null);
  assertEquals(await resolveReplyReference("thread-1", 42, async () => ({ role: "ASSISTANT", metadata: { candidate_id: "", evidence_ids: [1] } })), null);
});

Deno.test("reply context keeps stored story data when its historical ranking is unavailable", async () => {
  const reference: ReplyReference = {
    story_cluster_id: "story-1",
    candidate_id: "candidate-replied",
    primary_source_observation_id: "observation-1",
    ranking_date: "2026-09-27",
    ranking_version: "m8-v1",
    evidence_ids: ["claim:1"],
  };
  let rankingLookup: unknown;
  const resolved = await resolveReplyContext(reference, {
    loadStory: async (storyId) => ({ id: storyId, canonical_title: "Historical story" }),
    loadCandidate: async (candidateId) => ({ id: candidateId, story_cluster_id: "story-1" }),
    loadEditorialRanking: async (storyId, rankingDate, rankingVersion) => { rankingLookup = [storyId, rankingDate, rankingVersion]; return null; },
    loadSourceObservation: async (observationId) => ({ id: observationId, source_name: "Yahoo Sports" }),
    loadEvidence: async () => ({ evidence: [{ id: "claim:1", claim_text: "Confirmed" }], source_observation: null }),
  });
  assertEquals(rankingLookup, ["story-1", "2026-09-27", "m8-v1"]);
  assertEquals(resolved, {
    storyId: "story-1",
    context: {
      story_cluster: { id: "story-1", canonical_title: "Historical story" },
      candidate: { id: "candidate-replied", story_cluster_id: "story-1" },
      editorial_ranking: null,
      source_observation: { id: "observation-1", source_name: "Yahoo Sports" },
      evidence: [{ id: "claim:1", claim_text: "Confirmed" }],
    },
  });
});

Deno.test("reply context requests the latest ranking when stored ranking date is absent", async () => {
  let rankingLookup: unknown;
  await resolveReplyContext({ story_cluster_id: "story-1", candidate_id: null, primary_source_observation_id: null, ranking_date: null, ranking_version: null, evidence_ids: [] }, {
    loadStory: async () => ({ id: "story-1" }),
    loadCandidate: async () => null,
    loadEditorialRanking: async (storyId, rankingDate, rankingVersion) => { rankingLookup = [storyId, rankingDate, rankingVersion]; return null; },
    loadSourceObservation: async () => null,
    loadEvidence: async () => ({ evidence: [], source_observation: null }),
  });
  assertEquals(rankingLookup, ["story-1", null, null]);
});

Deno.test("historical reply context reconstructs the existing canonical generation shape", () => {
  const story = canonicalStoryFromReplyContext({
    story_cluster: { id: "story-1", canonical_title: "Historical story", summary: "Summary" },
    candidate: { id: "candidate-replied", story_cluster_id: "story-1" },
    editorial_ranking: { ranking_date: "2026-09-27", ranking_version: "m8-v1", rank: 2, editorial_score: 91, information_gap_score: 84, fact_grounding_score: 88, grounding_status: "VERIFIED", news_eligible: true },
    source_observation: null,
    evidence: [{ id: "claim:1", claim_text: "Confirmed", source_name: "Yahoo Sports", canonical_url: "https://sports.yahoo.com/story", editorial_role: "FACT_PRIMARY", grounding_status: "VERIFIED" }],
  });
  assertEquals(story?.id, "story-1");
  assertEquals(story?.candidate_id, "candidate-replied");
  assertEquals(story?.news_eligible, true);
  assertEquals(story?.evidence.length, 1);
  assertEquals(story?.ranking_date, "2026-09-27");
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
