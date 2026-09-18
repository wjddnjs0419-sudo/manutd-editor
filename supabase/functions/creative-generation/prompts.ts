import type { ContentMode, MatchPhase } from "./types.ts";

const modePrompts: Record<ContentMode, string> = {
  NEWS_UPDATE: "Write the most factual, concise Korean fan-media brief. Separate confirmed from reported information, avoid hype, and do not fill missing facts.",
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

export function generationPrompt(mode: ContentMode, phase: MatchPhase | null, evidence: unknown): string {
  return [
    "You are a grounded Creative Director, not a reporter.",
    modePrompts[mode],
    `Content mode: ${mode}`,
    `Match phase: ${phase ?? "none"}`,
    "Use only this frozen internal evidence. Every claim must cite an evidence_id from it.",
    `Frozen evidence:\n${JSON.stringify(evidence)}`,
  ].join("\n\n");
}

export function repairPrompt(
  mode: ContentMode,
  phase: MatchPhase | null,
  evidence: unknown,
  output: unknown,
  errors: readonly string[],
): string {
  return [
    generationPrompt(mode, phase, evidence),
    "Repair the original output only for the listed deterministic validation errors.",
    "Do not add facts, sources, or evidence IDs. Preserve all valid content.",
    `Validation errors: ${JSON.stringify(errors)}`,
    `Original output:\n${JSON.stringify(output)}`,
  ].join("\n\n");
}
