import type { ContentMode, JsonObject, JsonValue, MatchPhase } from "./types.ts";

export interface ClassifierConfig {
  readonly version: string;
  readonly model: string;
  readonly reasoning: string;
  readonly confidence_threshold: number;
  readonly keywords: Record<"match" | "news" | "analysis", readonly string[]>;
  readonly phase_keywords: Record<MatchPhase, readonly string[]>;
}

export interface GenerationConfig {
  readonly id: string;
  readonly version: string;
  readonly classifier_config: ClassifierConfig;
  readonly generation_config: JsonObject;
  readonly mode_configs: Record<ContentMode, JsonObject>;
  readonly quality_gate_config: JsonObject;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} must be nonblank`);
  return value;
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new Error(`${name} must be a string array`);
  }
  return value;
}

function classifier(value: unknown): ClassifierConfig {
  const config = object(value, "classifier_config");
  const keywords = object(config.keywords, "classifier_config.keywords");
  const phases = object(config.phase_keywords, "classifier_config.phase_keywords");
  const threshold = number(config.confidence_threshold, "classifier_config.confidence_threshold");
  if (threshold < 0 || threshold > 1) throw new Error("classifier confidence threshold must be between 0 and 1");
  return {
    version: string(config.version, "classifier_config.version"),
    model: string(config.model, "classifier_config.model"),
    reasoning: string(config.reasoning, "classifier_config.reasoning"),
    confidence_threshold: threshold,
    keywords: {
      match: stringArray(keywords.match, "classifier_config.keywords.match"),
      news: stringArray(keywords.news, "classifier_config.keywords.news"),
      analysis: stringArray(keywords.analysis, "classifier_config.keywords.analysis"),
    },
    phase_keywords: {
      PRE_MATCH: stringArray(phases.PRE_MATCH, "classifier_config.phase_keywords.PRE_MATCH"),
      LIVE: stringArray(phases.LIVE, "classifier_config.phase_keywords.LIVE"),
      POST_MATCH: stringArray(phases.POST_MATCH, "classifier_config.phase_keywords.POST_MATCH"),
    },
  };
}

function jsonObject(value: unknown, name: string): JsonObject {
  return object(value, name) as JsonObject;
}

export function validateGenerationConfig(value: unknown): GenerationConfig {
  const config = object(value, "generation config");
  const generation = jsonObject(config.generation_config, "generation_config");
  const generationModel = string(generation.model, "generation_config.model");
  const modes = object(config.mode_configs, "mode_configs");
  const modeConfigs = {} as Record<ContentMode, JsonObject>;
  for (const mode of ["NEWS_UPDATE", "ANALYSIS_CONTEXT", "MATCH_CONTENT"] as const) {
    modeConfigs[mode] = jsonObject(modes[mode], `mode_configs.${mode}`);
    const policy = modeConfigs[mode].evidence_policy;
    if (policy !== "STRICT" && policy !== "PARTIAL_ALLOWED") throw new Error(`mode_configs.${mode}.evidence_policy is invalid`);
  }
  if (generationModel === string(config.classifier_config && object(config.classifier_config, "classifier_config").model, "classifier_config.model")) {
    throw new Error("classifier and generator models must be separate");
  }
  return {
    id: string(config.id, "id"),
    version: string(config.version, "version"),
    classifier_config: classifier(config.classifier_config),
    generation_config: generation,
    mode_configs: modeConfigs,
    quality_gate_config: jsonObject(config.quality_gate_config, "quality_gate_config"),
  };
}

export function asJsonObject(value: unknown): JsonObject {
  return value as JsonObject;
}
