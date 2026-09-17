import {
  type EnvReader,
  INTELLIGENCE_DICTIONARY_VERSION,
  type IntelligenceConfig,
} from "./types.ts";

const DEFAULT_AI_MODEL = "gpt-5-mini";
const DEFAULT_PROMPT_VERSION = "cluster-v1";
const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_HEARTBEAT_SECONDS = 30;

function invalid(name: string): never {
  throw new Error(`Invalid intelligence configuration: ${name}`);
}

function nonEmptyConfigString(
  readEnv: EnvReader,
  name: string,
  defaultValue: string,
): string {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (
    value.length === 0 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
  ) {
    invalid(name);
  }
  return value;
}

function booleanConfig(
  readEnv: EnvReader,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  invalid(name);
}

function integerConfig(
  readEnv: EnvReader,
  name: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    invalid(name);
  }
  return parsed;
}

export function resolveIntelligenceConfig(
  readEnv: EnvReader,
): IntelligenceConfig {
  const leaseSeconds = integerConfig(
    readEnv,
    "STORY_INTELLIGENCE_LEASE_SECONDS",
    60,
    1800,
    DEFAULT_LEASE_SECONDS,
  );
  const heartbeatSeconds = integerConfig(
    readEnv,
    "STORY_INTELLIGENCE_HEARTBEAT_SECONDS",
    10,
    899,
    DEFAULT_HEARTBEAT_SECONDS,
  );

  if (heartbeatSeconds >= leaseSeconds / 2) {
    invalid("STORY_INTELLIGENCE_HEARTBEAT_SECONDS");
  }

  return {
    aiEnabled: booleanConfig(readEnv, "STORY_CLUSTER_AI_ENABLED", false),
    aiModel: nonEmptyConfigString(
      readEnv,
      "STORY_CLUSTER_AI_MODEL",
      DEFAULT_AI_MODEL,
    ),
    aiPromptVersion: nonEmptyConfigString(
      readEnv,
      "STORY_CLUSTER_AI_PROMPT_VERSION",
      DEFAULT_PROMPT_VERSION,
    ),
    dictionaryVersion: nonEmptyConfigString(
      readEnv,
      "STORY_CLUSTER_DICTIONARY_VERSION",
      INTELLIGENCE_DICTIONARY_VERSION,
    ),
    leaseSeconds,
    heartbeatSeconds,
  };
}
