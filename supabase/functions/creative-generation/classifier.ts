import type { ClassifierConfig } from "./config.ts";
import type { ContentMode, MatchPhase } from "./types.ts";

export type ClassificationSource = "DETERMINISTIC" | "AI_FALLBACK" | "UNCERTAIN";

export interface Classification {
  readonly status: "DETERMINISTIC" | "AMBIGUOUS";
  readonly source?: "DETERMINISTIC";
  readonly content_mode?: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly confidence: number;
  readonly reason_code: string;
}

export interface AiClassification {
  readonly content_mode: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly confidence: number;
  readonly reason_code: string;
}

export interface ClassifierProvider {
  classify(text: string, config: ClassifierConfig): Promise<AiClassification>;
}

export interface ClassificationResult {
  readonly source: ClassificationSource;
  readonly content_mode?: ContentMode;
  readonly match_phase: MatchPhase | null;
  readonly confidence: number;
  readonly reason_code: string;
}

function normalize(text: string): string {
  return text.toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

function matches(text: string, keywords: readonly string[]): string[] {
  return keywords.filter((keyword) => text.includes(normalize(keyword)));
}

export function classifyDeterministically(text: string, config: ClassifierConfig): Classification {
  const normalized = normalize(text);
  const matchSignals = matches(normalized, config.keywords.match);
  const newsSignals = matches(normalized, config.keywords.news);
  const analysisSignals = matches(normalized, config.keywords.analysis);
  const phaseMatches = (Object.entries(config.phase_keywords) as [MatchPhase, readonly string[]][])
    .filter(([, keywords]) => matches(normalized, keywords).length > 0)
    .map(([phase]) => phase);

  if (matchSignals.length > 0) {
    if (phaseMatches.length !== 1) {
      return { status: "AMBIGUOUS", match_phase: null, confidence: 0.2, reason_code: phaseMatches.length === 0 ? "MATCH_PHASE_REQUIRED" : "MULTIPLE_MATCH_PHASES" };
    }
    return { status: "DETERMINISTIC", source: "DETERMINISTIC", content_mode: "MATCH_CONTENT", match_phase: phaseMatches[0]!, confidence: 0.98, reason_code: `MATCH_${phaseMatches[0]}` };
  }

  if (newsSignals.length > 0 && analysisSignals.length > 0) {
    return { status: "AMBIGUOUS", match_phase: null, confidence: 0.35, reason_code: "CONFLICTING_NON_MATCH_SIGNALS" };
  }
  if (newsSignals.length > 0) {
    return { status: "DETERMINISTIC", source: "DETERMINISTIC", content_mode: "NEWS_UPDATE", match_phase: null, confidence: 0.96, reason_code: "NEWS_SIGNAL" };
  }
  if (analysisSignals.length > 0) {
    return { status: "DETERMINISTIC", source: "DETERMINISTIC", content_mode: "ANALYSIS_CONTEXT", match_phase: null, confidence: 0.94, reason_code: "ANALYSIS_SIGNAL" };
  }
  return { status: "AMBIGUOUS", match_phase: null, confidence: 0, reason_code: "NO_DETERMINISTIC_SIGNAL" };
}

function validAiClassification(result: AiClassification, threshold: number): boolean {
  if (!Number.isFinite(result.confidence) || result.confidence < threshold) return false;
  if (!["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"].includes(result.content_mode)) return false;
  if (result.content_mode === "MATCH_CONTENT" && !["PRE_MATCH", "LIVE", "POST_MATCH"].includes(result.match_phase ?? "")) return false;
  if (result.content_mode !== "MATCH_CONTENT" && result.match_phase !== null) return false;
  return true;
}

export async function classifyWithFallback(
  text: string,
  config: ClassifierConfig,
  provider: ClassifierProvider,
): Promise<ClassificationResult> {
  const deterministic = classifyDeterministically(text, config);
  if (deterministic.status === "DETERMINISTIC") {
    return {
      source: "DETERMINISTIC",
      content_mode: deterministic.content_mode,
      match_phase: deterministic.match_phase,
      confidence: deterministic.confidence,
      reason_code: deterministic.reason_code,
    };
  }
  try {
    const result = await provider.classify(text, config);
    if (!validAiClassification(result, config.confidence_threshold)) {
      return { source: "UNCERTAIN", match_phase: null, confidence: result.confidence, reason_code: "CLASSIFICATION_UNCERTAIN" };
    }
    return { source: "AI_FALLBACK", ...result };
  } catch {
    return { source: "UNCERTAIN", match_phase: null, confidence: 0, reason_code: "CLASSIFICATION_UNCERTAIN" };
  }
}
