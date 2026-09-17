type EnvReader = (name: string) => string | undefined;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function requiredEnv(readEnv: EnvReader, name: string): string {
  const value = readEnv(name);
  if (!nonEmptyString(value)) {
    throw new Error(`Missing required configuration: ${name}`);
  }
  return value;
}

export function integerEnv(
  readEnv: EnvReader,
  name: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  const value = readEnv(name);
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Invalid integer configuration: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid integer configuration: ${name}`);
  }
  return parsed;
}

export function resolveSupabaseSecretKey(readEnv: EnvReader): string {
  const keySet = readEnv("SUPABASE_SECRET_KEYS");
  if (nonEmptyString(keySet)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keySet);
    } catch {
      throw new Error("Invalid configuration: SUPABASE_SECRET_KEYS");
    }

    if (
      typeof parsed !== "object" || parsed === null ||
      !nonEmptyString((parsed as Record<string, unknown>).default)
    ) {
      throw new Error(
        "Invalid configuration: SUPABASE_SECRET_KEYS.default",
      );
    }
    return (parsed as Record<string, string>).default;
  }

  return requiredEnv(readEnv, "SUPABASE_SECRET_KEY");
}
