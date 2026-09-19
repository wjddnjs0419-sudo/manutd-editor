import type { MorningBriefingSnapshot, FrozenBriefingItem } from "./briefing.ts";

export interface PhrasedCandidateNote {
  position: number;
  note: string;
}

export interface PhrasedBriefing {
  intro: string;
  candidate_notes: PhrasedCandidateNote[];
  issue_note: string | null;
  render_mode?: "OPENAI" | "FALLBACK_TEMPLATE";
}

export interface PhraseConfig {
  maxNoteChars?: number;
  generate?: (payload: unknown) => Promise<unknown>;
}

export function createOpenAIGenerator(options: { apiKey: string; model?: string; fetch?: typeof fetch }): (payload: unknown) => Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch;
  return async (payload) => {
    if (!options.apiKey.trim()) throw new Error("OPENAI_NOT_CONFIGURED");
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model ?? "gpt-5.6-luna", input: JSON.stringify(payload), text: { format: { type: "json_object" } } }),
    });
    if (!response.ok) throw new Error("OPENAI_REQUEST_FAILED");
    const body = await response.json() as { output_text?: unknown };
    if (typeof body.output_text !== "string") throw new Error("OPENAI_INVALID_RESPONSE");
    return JSON.parse(body.output_text);
  };
}

export interface TelegramMessagePlan {
  kind: "text" | "photo";
  text: string;
  photo_url?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsafeNote(note: string, maxNoteChars: number): boolean {
  return note.length > maxNoteChars || /https?:\/\//iu.test(note) || /\d/u.test(note) ||
    /\b(?:Priority|FIRST_MOVER|MUST_COVER)\b/u.test(note);
}

export function validatePhrasedBriefing(
  snapshot: MorningBriefingSnapshot,
  value: unknown,
  maxNoteChars = 140,
): PhrasedBriefing {
  if (!isObject(value) || typeof value.intro !== "string" ||
    !Array.isArray(value.candidate_notes) ||
    !(value.issue_note === null || typeof value.issue_note === "string")) throw new Error("INVALID_SHAPE");
  const seen = new Set<number>();
  const notes: PhrasedCandidateNote[] = [];
  for (const candidate of value.candidate_notes) {
    if (!isObject(candidate) || typeof candidate.position !== "number" ||
      !Number.isInteger(candidate.position) || typeof candidate.note !== "string") throw new Error("INVALID_SHAPE");
    if (!snapshot.items.some((entry) => entry.position === candidate.position)) throw new Error("UNKNOWN_POSITION");
    if (seen.has(candidate.position)) throw new Error("DUPLICATE_POSITION");
    if (unsafeNote(candidate.note, maxNoteChars)) throw new Error("UNSAFE_NOTE");
    seen.add(candidate.position);
    notes.push({ position: candidate.position, note: candidate.note });
  }
  if (notes.length !== snapshot.items.length) throw new Error("MISSING_POSITION");
  return { intro: value.intro.slice(0, 240), candidate_notes: notes, issue_note: value.issue_note === null ? null : value.issue_note.slice(0, 240) };
}

function fallback(snapshot: MorningBriefingSnapshot): PhrasedBriefing {
  return {
    intro: "좋은 아침입니다. 오늘 확인할 콘텐츠를 정리했습니다.",
    candidate_notes: snapshot.items.map((item) => ({ position: item.position, note: "핵심 소식과 원문을 확인해 주세요." })),
    issue_note: snapshot.blocked_failed.length > 0 ? "일부 항목은 차단 또는 실패 상태라 확인이 필요합니다." : null,
    render_mode: "FALLBACK_TEMPLATE",
  };
}

function phrasingPayload(snapshot: MorningBriefingSnapshot): unknown {
  return {
    instruction: "Write concise Korean editorial notes. Return only the requested JSON shape. Do not invent scores, flags, statuses, links, ids, or positions.",
    briefing: {
      briefing_date: snapshot.briefing_date,
      match_day_mode: snapshot.match_day_mode,
      overnight_counts: snapshot.overnight_counts,
      candidates: snapshot.items.map((item) => ({ position: item.position, creative_status: item.creative_status, has_reference: Boolean(item.reference_permalink) })),
      has_issues: snapshot.blocked_failed.length > 0,
    },
    output_schema: { intro: "string", candidate_notes: [{ position: "number", note: "string" }], issue_note: "string|null" },
  };
}

export async function phraseMorningBrief(snapshot: MorningBriefingSnapshot, config: PhraseConfig = {}): Promise<PhrasedBriefing> {
  if (!config.generate) return fallback(snapshot);
  try {
    const result = validatePhrasedBriefing(snapshot, await config.generate(phrasingPayload(snapshot)), config.maxNoteChars ?? 140);
    return { ...result, render_mode: "OPENAI" };
  } catch {
    return fallback(snapshot);
  }
}

function flags(item: FrozenBriefingItem): string {
  return [item.first_mover_flag ? "FIRST_MOVER" : "", item.must_cover_flag ? "MUST_COVER" : ""].filter(Boolean).join(" · ");
}

function canonicalCandidateText(item: FrozenBriefingItem, note: string): string {
  const score = item.priority_score === null ? "Priority —" : `Priority ${item.priority_score}`;
  const flagText = flags(item);
  const title = item.title?.trim() || "콘텐츠 후보";
  const lines = [`${item.position}️⃣ ${title}`, [score, flagText].filter(Boolean).join(" · "), `Creative Brief: ${item.creative_status}`, "", note];
  if (item.reference_username) lines.push(`Reference: @${item.reference_username}`);
  if (item.reference_permalink) lines.push(`🔗 원문: ${item.reference_permalink}`);
  lines.push(`/open ${item.position}`);
  return lines.join("\n");
}

export function renderMorningBrief(snapshot: MorningBriefingSnapshot, phrasing: PhrasedBriefing): TelegramMessagePlan[] {
  const notes = new Map(phrasing.candidate_notes.map((note) => [note.position, note.note]));
  const plans: TelegramMessagePlan[] = [{ kind: "text", text: phrasing.intro }];
  for (const item of snapshot.items) {
    const text = canonicalCandidateText(item, notes.get(item.position) ?? "핵심 소식과 원문을 확인해 주세요.");
    if (item.reference_media_url) plans.push({ kind: "photo", text, photo_url: item.reference_media_url });
    else plans.push({ kind: "text", text });
  }
  const issue = phrasing.issue_note ? `\n⚠️ ${phrasing.issue_note}` : "";
  plans.push({ kind: "text", text: `오늘의 후보 ${snapshot.items.length}건을 확인했습니다.${issue}` });
  return plans;
}
