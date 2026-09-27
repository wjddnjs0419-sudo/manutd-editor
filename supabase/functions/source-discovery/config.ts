import type { EditorialSourceRole, InformationSourceEntityType, SourceFeed } from "./types.ts";

type EnvReader = (name: string) => string | undefined;

const ROLES = new Set<EditorialSourceRole>([
  "FACT_PRIMARY",
  "FACT_INDEPENDENT",
  "DISCOVERY_COMPETITOR",
  "DISCOVERY_COMMUNITY",
  "DISCOVERY_VIDEO",
  "MATCH_CONTEXT",
  "OWN_PERFORMANCE",
]);
const ENTITY_TYPES = new Set<InformationSourceEntityType>([
  "CLUB",
  "REPORTER",
  "MEDIA_OUTLET",
  "GOVERNING_BODY",
  "OTHER",
]);
const FORMATS = new Set<NonNullable<SourceFeed["format"]>>(["RSS", "ATOM", "HTML"]);

export interface SourceDiscoveryConfig {
  readonly feeds: readonly SourceFeed[];
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly maxExcerptChars: number;
}

function integerEnv(readEnv: EnvReader, name: string, min: number, max: number, fallback: number): number {
  const value = readEnv(name);
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`Invalid configuration: ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid configuration: ${name}`);
  return parsed;
}

function feedsEnv(readEnv: EnvReader): readonly SourceFeed[] {
  const value = readEnv("SOURCE_DISCOVERY_FEEDS_JSON");
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
  }
  if (!Array.isArray(parsed) || parsed.length > 32) throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
    const value = item as Record<string, unknown>;
    if (typeof value.canonical_name !== "string" || value.canonical_name.trim() === "" || value.canonical_name.length > 160) throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
    if (typeof value.url !== "string" || value.url.trim() === "") throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
    if (typeof value.editorial_role !== "string" || !ROLES.has(value.editorial_role as EditorialSourceRole)) throw new Error("Invalid configuration: SOURCE_DISCOVERY_FEEDS_JSON");
    const entityType = typeof value.entity_type === "string" && ENTITY_TYPES.has(value.entity_type as InformationSourceEntityType)
      ? value.entity_type as InformationSourceEntityType
      : "OTHER";
    const format = typeof value.format === "string" && FORMATS.has(value.format as NonNullable<SourceFeed["format"]>)
      ? value.format as NonNullable<SourceFeed["format"]>
      : "RSS";
    return {
      canonicalName: value.canonical_name.trim(),
      editorialRole: value.editorial_role as EditorialSourceRole,
      entityType,
      url: value.url.trim(),
      format,
    } satisfies SourceFeed;
  });
}

export function resolveSourceDiscoveryConfig(readEnv: EnvReader): SourceDiscoveryConfig {
  return {
    feeds: feedsEnv(readEnv),
    timeoutMs: integerEnv(readEnv, "SOURCE_DISCOVERY_TIMEOUT_MS", 500, 30_000, 8_000),
    maxBytes: integerEnv(readEnv, "SOURCE_DISCOVERY_MAX_BYTES", 1_024, 1_000_000, 200_000),
    maxItems: integerEnv(readEnv, "SOURCE_DISCOVERY_MAX_ITEMS", 1, 100, 20),
    maxExcerptChars: integerEnv(readEnv, "SOURCE_DISCOVERY_MAX_EXCERPT_CHARS", 80, 2_000, 600),
  };
}
