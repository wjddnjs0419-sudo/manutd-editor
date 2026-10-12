import type { ContentMode, GenerationIntent, MatchPhase } from "./types.ts";
import { DEFAULT_EXPLORATION_CONFIG } from "./exploration.ts";
import { MANUTD_EDITOR_STYLE_INSTRUCTIONS } from "../_shared/editorial-style/manutd_editor.ts";

const modePrompts: Record<ContentMode, string> = {
  NEWS_UPDATE: "Write a concise Korean fan-media brief using only verified, claim-linked publisher evidence. Keep what the outlet reported separate from whether the reported event is true. Preserve every claim modality: rumors and predictions stay uncertain, denials stay denials, and opinion stays attributed. Never turn a report or rumor into a confirmed transfer. In at least one slide and in the Instagram caption, name the publisher and include the exact canonical publisher article URL. Every source item must include its evidence_id, publisher label, and URL.",
  ANALYSIS_CONTEXT: "Write an explanatory Korean fan-media brief. Label FACT and INFERENCE claims distinctly; every inference must remain grounded in supplied evidence.",
  MATCH_CONTENT: "Write an immediately consumable Korean match carousel. Respect the supplied match phase and only describe confirmed match evidence; never invent a lineup, event, score, or statistic.",
};

export function classifierPrompt(text: string): string {
  return [
    "Classify this caption using only the supplied text.",
    "Return the requested JSON object only. Do not add facts.",
    `Caption:\n${text}`,
  ].join("\n\n");
}

export function generationPrompt(mode: ContentMode, phase: MatchPhase | null, evidence: unknown, intent: GenerationIntent = "STANDARD"): string {
  const modeInstruction = intent === "EXPLORATION"
    ? mode === "NEWS_UPDATE"
      ? "Write a concise Korean publisher-report brief. The article's report is not independently verified fact."
      : mode === "ANALYSIS_CONTEXT"
      ? "Write grounded Korean context around what the publisher reports. Keep reported facts separate from any clearly labeled analysis."
      : "Write Korean match-related content only from match details explicitly present in the extracted article, with publisher attribution and uncertainty preserved."
    : modePrompts[mode];
  const evidenceInstructions = intent === "EXPLORATION"
    ? `This is an internal-review DRAFT. Use only the extracted publisher article text in exploration_articles. These sources are unverified reports, never VERIFIED facts. Attribute every claim to its publisher, preserve report/rumor/prediction/denial/opinion modality in every slide and caption, and never state an unverified event as confirmed. Use the article's actual published_at time; never present an older article as new, current, or breaking. Use 3–5 concise Korean slides, an Instagram caption, no more than ${DEFAULT_EXPLORATION_CONFIG.maxHashtags} hashtags, and a review note. Include the real publisher name and exact article URL in sources and in both slide copy and caption. Do not add facts or infer beyond the supplied article text.`
    : "For NEWS_UPDATE, use only sources marked verified with a claim_id, fact role, SUPPORTS relation, and canonical publisher URL. Treat PUBLISHER_REPORT as proof only that the named outlet reported that exact sentence, never as proof of the underlying event. Keep claim scope and claim modality in every public factual sentence, caption, and source citation.";
  return [
    "You are a grounded Creative Director, not a reporter.",
    MANUTD_EDITOR_STYLE_INSTRUCTIONS,
    modeInstruction,
    `Content mode: ${mode}`,
    `Match phase: ${phase ?? "none"}`,
    ...(intent === "EXPLORATION" ? [`Generation intent: ${intent}`] : []),
    "Use only this frozen internal evidence. Every claim must cite an evidence_id from it. Do not import facts from examples or general football knowledge.",
    evidenceInstructions,
    `Frozen evidence:\n${JSON.stringify(evidence)}`,
  ].join("\n\n");
}

export function repairPrompt(
  mode: ContentMode,
  phase: MatchPhase | null,
  evidence: unknown,
  output: unknown,
  errors: readonly string[],
  intent: GenerationIntent = "STANDARD",
): string {
  return [
    generationPrompt(mode, phase, evidence, intent),
    "Repair the original output only for the listed deterministic validation errors.",
    "Do not add facts, sources, or evidence IDs. Preserve all valid content.",
    ...(intent === "EXPLORATION"
      ? ["Retain the exact publisher name and canonical URL in a slide and caption, preserve report attribution and uncertainty/denial/opinion modality, and never upgrade a report into a confirmed event."]
      : ["For NEWS_UPDATE, retain the exact publisher name and canonical URL in a slide and caption, preserve report attribution and the source claim's uncertainty/denial/opinion modality, and never upgrade a report into a confirmed event."]),
    `Validation errors: ${JSON.stringify(errors)}`,
    `Original output:\n${JSON.stringify(output)}`,
  ].join("\n\n");
}
