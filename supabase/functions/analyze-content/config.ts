type EnvReader = (name: string) => string | undefined;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stringEnv(readEnv: EnvReader, name: string, defaultValue: string): string {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (!nonEmpty(value) || value.length > 160) {
    throw new Error(`Invalid configuration: ${name}`);
  }
  return value.trim();
}

function integerEnv(
  readEnv: EnvReader,
  name: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid configuration: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid configuration: ${name}`);
  }
  return parsed;
}

export interface ContentUnderstandingConfig {
  readonly analysisVersion: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxSlides: number;
  readonly batchSize: number;
  readonly concurrency: number;
}

export function resolveContentUnderstandingConfig(
  readEnv: EnvReader,
): ContentUnderstandingConfig {
  return {
    analysisVersion: stringEnv(readEnv, "CONTENT_UNDERSTANDING_ANALYSIS_VERSION", "m8-a-v1"),
    model: stringEnv(readEnv, "CONTENT_UNDERSTANDING_MODEL", "gpt-5.6-terra"),
    promptVersion: stringEnv(readEnv, "CONTENT_UNDERSTANDING_PROMPT_VERSION", "prompt-v1"),
    timeoutMs: integerEnv(readEnv, "CONTENT_UNDERSTANDING_TIMEOUT_MS", 1_000, 120_000, 30_000),
    maxBytes: integerEnv(readEnv, "CONTENT_UNDERSTANDING_MAX_BYTES", 1, 20 * 1024 * 1024, 20 * 1024 * 1024),
    maxSlides: integerEnv(readEnv, "CONTENT_UNDERSTANDING_MAX_SLIDES", 1, 10, 6),
    batchSize: integerEnv(readEnv, "CONTENT_UNDERSTANDING_BATCH_SIZE", 1, 100, 20),
    concurrency: integerEnv(readEnv, "CONTENT_UNDERSTANDING_CONCURRENCY", 1, 2, 2),
  };
}
