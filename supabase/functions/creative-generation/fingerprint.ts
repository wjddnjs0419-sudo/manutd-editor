import type { FingerprintInput, JsonValue } from "./types.ts";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashGenerationInput(input: FingerprintInput): Promise<string> {
  const semanticInput: Record<string, JsonValue> = {
    candidate_id: input.candidate_id,
    evidence_snapshot: input.evidence_snapshot as JsonValue,
    content_mode: input.content_mode,
    match_phase: input.match_phase,
    generation_config_version: input.generation_config_version,
    classifier_config_version: input.classifier_config_version,
    generator_model_config: input.generator_model_config,
  };
  return await sha256(canonicalJson(semanticInput));
}
