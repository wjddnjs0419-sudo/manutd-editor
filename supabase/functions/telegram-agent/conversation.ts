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
import type { CanonicalStory, EditorialEvidence } from "../_shared/m6/editorial_console.ts";

export interface CanonicalConversationContext {
  candidate: Record<string, unknown> | null;
  source_observation?: Record<string, unknown> | null;
  brief: Record<string, unknown> | null;
  match: Record<string, unknown> | null;
  story_cluster?: Record<string, unknown> | null;
  editorial_ranking?: Record<string, unknown> | null;
  evidence?: readonly Record<string, unknown>[];
}

export interface ReplyContext {
  story_cluster: Record<string, unknown> | null;
  candidate: Record<string, unknown> | null;
  editorial_ranking: Record<string, unknown> | null;
  source_observation: Record<string, unknown> | null;
  evidence: readonly Record<string, unknown>[];
}

export interface ReplyReference {
  story_cluster_id: string | null;
  candidate_id: string | null;
  primary_source_observation_id: string | null;
  ranking_date: string | null;
  ranking_version: string | null;
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
  replyContext?: ReplyContext;
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
  const primarySourceObservationId = id(metadata.primary_source_observation_id);
  const rankingDate = id(metadata.ranking_date);
  const rankingVersion = id(metadata.ranking_version);
  const evidenceIds = Array.isArray(metadata.evidence_ids) ? [...new Set(metadata.evidence_ids.flatMap((value) => id(value) ? [id(value)!] : []))] : [];
  return {
    story_cluster_id: storyId,
    candidate_id: candidateId,
    primary_source_observation_id: primarySourceObservationId,
    ranking_date: rankingDate,
    ranking_version: rankingVersion,
    evidence_ids: evidenceIds,
  };
}

export interface ReplyEvidenceContext {
  evidence: readonly Record<string, unknown>[];
  source_observation: Record<string, unknown> | null;
}

export interface ReplyContextDependencies {
  loadStory: (storyId: string) => Promise<Record<string, unknown> | null>;
  loadCandidate: (candidateId: string) => Promise<Record<string, unknown> | null>;
  loadEditorialRanking: (storyId: string, rankingDate: string | null, rankingVersion: string | null) => Promise<Record<string, unknown> | null>;
  loadSourceObservation: (observationId: string) => Promise<Record<string, unknown> | null>;
  loadEvidence: (storyId: string, evidenceIds: readonly string[]) => Promise<ReplyEvidenceContext>;
}

export async function resolveReplyContext(reference: ReplyReference, dependencies: ReplyContextDependencies): Promise<{ storyId: string; context: ReplyContext } | null> {
  const candidate = reference.candidate_id ? await dependencies.loadCandidate(reference.candidate_id) : null;
  const storyId = reference.story_cluster_id ?? (typeof candidate?.story_cluster_id === "string" ? candidate.story_cluster_id : null);
  if (!storyId) return null;
  const [story, editorialRanking, sourceObservation, evidenceContext] = await Promise.all([
    dependencies.loadStory(storyId),
    dependencies.loadEditorialRanking(storyId, reference.ranking_date, reference.ranking_version),
    reference.primary_source_observation_id ? dependencies.loadSourceObservation(reference.primary_source_observation_id) : Promise.resolve(null),
    dependencies.loadEvidence(storyId, reference.evidence_ids),
  ]);
  if (!story) return null;
  return {
    storyId,
    context: {
      story_cluster: story,
      candidate: candidate ?? (reference.candidate_id ? { id: reference.candidate_id, story_cluster_id: storyId } : null),
      editorial_ranking: editorialRanking,
      source_observation: sourceObservation ?? evidenceContext.source_observation,
      evidence: evidenceContext.evidence,
    },
  };
}

export function canonicalStoryFromReplyContext(context: ReplyContext): CanonicalStory | null {
  const cluster = context.story_cluster;
  const storyId = typeof cluster?.id === "string" ? cluster.id : null;
  const candidateId = typeof context.candidate?.id === "string" ? context.candidate.id : null;
  if (!cluster || !storyId || !candidateId) return null;
  const ranking = context.editorial_ranking ?? {};
  const stringValue = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;
  const numberValue = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
  const evidence: EditorialEvidence[] = context.evidence.flatMap((item) => {
    const evidenceId = stringValue(item.evidence_id) ?? stringValue(item.id);
    const claimText = stringValue(item.claim_text);
    if (!evidenceId || !claimText) return [];
    const status = item.grounding_status === "CONTRADICTED" ? "CONTRADICTED" : item.grounding_status === "VERIFIED" ? "SUPPORTED" : "REPORTED";
    return [{
      evidence_id: evidenceId,
      source_name: stringValue(item.source_name) ?? "M8 근거",
      claim_text: claimText,
      status,
      canonical_url: stringValue(item.canonical_url),
      editorial_role: stringValue(item.editorial_role),
    }];
  });
  const rankingDate = stringValue(ranking.ranking_date) ?? "";
  const rankingVersion = stringValue(ranking.ranking_version) ?? "";
  const rank = numberValue(ranking.rank);
  const informationGapScore = numberValue(ranking.information_gap_score) ?? 0;
  const sources = [...new Set(evidence.map((item) => item.source_name))];
  const title = stringValue(cluster.canonical_title) ?? stringValue(cluster.title) ?? storyId;
  const summary = stringValue(cluster.summary);
  return {
    id: storyId,
    candidate_id: candidateId,
    title,
    summary,
    ranking_date: rankingDate,
    ranking_version: rankingVersion,
    rank,
    editorial_score: numberValue(ranking.editorial_score) ?? 0,
    information_gap_score: informationGapScore,
    hook_strength: informationGapScore,
    shareability: numberValue(ranking.discovery_audience_signal_score) ?? 0,
    source_confidence: numberValue(ranking.fact_grounding_score) ?? 0,
    grounding_status: stringValue(ranking.grounding_status) ?? "INSUFFICIENT",
    news_eligible: ranking.news_eligible === true,
    sources,
    source_count: sources.length,
    evidence,
    story_fingerprint: `story:${storyId}:${rankingDate || "unknown"}:${rankingVersion || "unknown"}`,
    latest_brief_id: null,
    recommended: rank !== null && rank <= 5,
    trend_score: numberValue(cluster.trend_score),
    trend_state: stringValue(cluster.trend_state),
    trend_source_count: numberValue(cluster.trend_source_count) ?? sources.length,
    trend_platform_count: numberValue(cluster.trend_platform_count) ?? 0,
    opportunity_labels: Array.isArray(cluster.opportunity_labels) ? cluster.opportunity_labels.filter((value): value is string => typeof value === "string") : [],
  };
}

export function replyConsoleIntent(text: string, activeCandidateId: string | null, repliedStoryId: string | null): ConsoleAction | null {
  const intent = parseConsoleIntent(text, activeCandidateId);
  return intent?.type === "GENERATE_CAROUSEL" && repliedStoryId ? { ...intent, token: repliedStoryId } : intent;
}

export interface EditorialIntentResult {
  intent: "OPEN_RECOMMENDED" | "OPEN_TRENDING" | "DISCOVER_MORE" | "OPEN_STORY" | "GENERATE_CAROUSEL" | "SHOW_SOURCES" | "EDIT_DRAFT" | "UNKNOWN";
  story_position: number | null;
  slide_count: 3 | 4 | null;
  edit_target: "slide_1" | "slide_2" | "slide_3" | "slide_4" | "caption" | null;
  instruction: string | null;
}

type EditorialIntentDiagnostic =
  | { outcome: "PROVIDER_ERROR" | "INVALID_RESPONSE" | "UNEXPECTED_KEYS" | "INVALID_INTENT" | "INVALID_FIELDS" | "INVALID_ACTION" }
  | { outcome: "ACCEPTED"; intent: EditorialIntentResult["intent"] };

export function resolvePresentedStoryPosition<T>(stories: readonly T[], position: number): T | null {
  return Number.isInteger(position) && position >= 1 && position <= 5 ? stories[position - 1] ?? null : null;
}

export async function parseEditorialIntent(
  message: string,
  dependencies: { generate: (payload: unknown) => Promise<unknown>; presented_titles?: readonly string[]; has_active_story?: boolean; has_active_draft?: boolean; onDiagnostic?: (diagnostic: EditorialIntentDiagnostic) => void },
): Promise<EditorialIntentResult> {
  const empty: EditorialIntentResult = { intent: "UNKNOWN", story_position: null, slide_count: null, edit_target: null, instruction: null };
  const reject = (outcome: Exclude<EditorialIntentDiagnostic, { outcome: "ACCEPTED" }>["outcome"]): EditorialIntentResult => {
    dependencies.onDiagnostic?.({ outcome });
    return empty;
  };
  try {
    const value = await dependencies.generate({
      task: "classify_telegram_editorial_intent",
      user_message: message,
      context: { presented_story_titles: (dependencies.presented_titles ?? []).slice(0, 5), has_active_story: dependencies.has_active_story === true, has_active_draft: dependencies.has_active_draft === true },
      rules: ["Classify only; never perform actions or invent story identifiers.", "Return exactly JSON keys intent, story_position, slide_count, edit_target, instruction.", "OPEN_RECOMMENDED means today's candidates; OPEN_TRENDING means current hot stories; DISCOVER_MORE means run a fresh search.", "OPEN_STORY means explain/open the explicit numbered item; GENERATE_CAROUSEL means create a draft from the active or explicit numbered story; SHOW_SOURCES means show its evidence and original URLs; EDIT_DRAFT means revise only the active draft.", "Korean examples: '2번 가자. 3페이지로' => GENERATE_CAROUSEL position 2 slide_count 3; '2번 자세히' => OPEN_STORY position 2; '첫 장 좀 세게' => EDIT_DRAFT slide_1; '2페이지 줄여' => EDIT_DRAFT slide_2; '캡션 좀 더 짧게' => EDIT_DRAFT caption; '출처 보여줘' => SHOW_SOURCES; '다른 기사 더 찾아봐' => DISCOVER_MORE.", "story_position must be 1..5 and only when explicitly referenced.", "slide_count may only be 3 or 4.", "edit_target may only be slide_1..slide_4 or caption.", "For ambiguous/unknown requests use UNKNOWN and null fields."],
      schema: { intent: ["OPEN_RECOMMENDED", "OPEN_TRENDING", "DISCOVER_MORE", "OPEN_STORY", "GENERATE_CAROUSEL", "SHOW_SOURCES", "EDIT_DRAFT", "UNKNOWN"], story_position: "integer 1..5 or null", slide_count: "3, 4, or null", edit_target: "slide_1..slide_4, caption, or null", instruction: "short Korean edit instruction or null" },
    });
    if (!object(value)) return reject("INVALID_RESPONSE");
    const keys = ["intent", "story_position", "slide_count", "edit_target", "instruction"];
    if (Object.keys(value).some((key) => !keys.includes(key))) return reject("UNEXPECTED_KEYS");
    const intents = ["OPEN_RECOMMENDED", "OPEN_TRENDING", "DISCOVER_MORE", "OPEN_STORY", "GENERATE_CAROUSEL", "SHOW_SOURCES", "EDIT_DRAFT", "UNKNOWN"];
    if (!intents.includes(String(value.intent))) return reject("INVALID_INTENT");
    const positionValue = value.story_position ?? null;
    const slideCountValue = value.slide_count ?? null;
    const targetValue = value.edit_target ?? null;
    const instructionValue = value.instruction ?? null;
    const position = positionValue === null ? null : Number.isInteger(positionValue) && Number(positionValue) >= 1 && Number(positionValue) <= 5 ? Number(positionValue) : -1;
    const slideCount = slideCountValue === null ? null : slideCountValue === 3 || slideCountValue === 4 ? slideCountValue : -1;
    const target = targetValue === null ? null : ["slide_1", "slide_2", "slide_3", "slide_4", "caption"].includes(String(targetValue)) ? targetValue as EditorialIntentResult["edit_target"] : "invalid";
    const instruction = instructionValue === null ? null : typeof instructionValue === "string" && instructionValue.trim().length <= 200 ? instructionValue.trim() : "invalid";
    if (position === -1 || slideCount === -1 || target === "invalid" || instruction === "invalid") return reject("INVALID_FIELDS");
    const intent = value.intent as EditorialIntentResult["intent"];
    if (intent === "OPEN_STORY" && position === null) return reject("INVALID_ACTION");
    if (intent === "EDIT_DRAFT" && (!target || !instruction || !dependencies.has_active_draft)) return reject("INVALID_ACTION");
    if (intent === "GENERATE_CAROUSEL" && position === null && !dependencies.has_active_story) return reject("INVALID_ACTION");
    dependencies.onDiagnostic?.({ outcome: "ACCEPTED", intent });
    return { intent, story_position: position, slide_count: slideCount, edit_target: target, instruction };
  } catch {
    return reject("PROVIDER_ERROR");
  }
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
      ? { ...await dependencies.loadCanonicalContext(thread), brief: null, match: null, ...dependencies.replyContext }
      : await dependencies.loadCanonicalContext(thread),
    generate: dependencies.generate,
    retrieveHistory: dependencies.retrieveHistory ? () => dependencies.retrieveHistory?.(message, thread) ?? Promise.resolve([]) : undefined,
  });
}
