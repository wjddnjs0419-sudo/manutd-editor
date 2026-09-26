import {
  INTELLIGENCE_DICTIONARY_VERSION,
  type IntelligenceDictionary,
  type MultimodalFeatureInput,
  type StoryFeatures,
} from "./types.ts";

const PARTICLES = [
  "으로부터",
  "으로",
  "에서",
  "에게",
  "까지",
  "부터",
  "처럼",
  "보다",
  "한테",
  "이랑",
  "랑",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "와",
  "과",
  "로",
  "도",
  "만",
].sort((a, b) => b.length - a.length);

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export const DEFAULT_INTELLIGENCE_DICTIONARY: IntelligenceDictionary = {
  version: INTELLIGENCE_DICTIONARY_VERSION,
  entities: {
    "manchester united": "manchester_united",
    "맨체스터 유나이티드": "manchester_united",
    "bruno fernandes": "bruno_fernandes",
    "브루노 페르난데스": "bruno_fernandes",
    브루노: "bruno_fernandes",
    bruno: "bruno_fernandes",
  },
  events: {
    "injury update": "injury",
    "부상 소식": "injury",
    injury: "injury",
    injured: "injury",
    부상: "injury",
  },
  sources: {
    "fabrizio romano": "fabrizio_romano",
    "파브리치오 로마노": "fabrizio_romano",
    fabrizio: "fabrizio_romano",
  },
};

function normalizeUnicode(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function stripParticle(token: string): string {
  for (const particle of PARTICLES) {
    if (token.length > particle.length + 1 && token.endsWith(particle)) {
      return token.slice(0, -particle.length);
    }
  }
  return token;
}

function normalizeCaption(caption: string): string {
  const normalized = normalizeUnicode(caption)
    .replace(/[“”‘’]/g, " ")
    .replace(/[^\p{L}\p{N}#.,:/%+\-\s]/gu, " ");
  const rawTokens = normalized.match(
    /(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d[\d,]*(?:\.\d+)?(?:[km])?|[\p{L}]+(?:-[\p{L}\p{N}]+)?)/gu,
  ) ?? [];
  return rawTokens.map(stripParticle).filter(Boolean).join(" ");
}

function phrasePattern(phrase: string): RegExp {
  return new RegExp(
    `(?:^| )${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$| )`,
    "u",
  );
}

function lookupAliases(
  normalizedCaption: string,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const found: string[] = [];
  const orderedAliases = Object.entries(aliases).sort((a, b) => {
    const length = b[0].length - a[0].length;
    return length === 0 ? a[0].localeCompare(b[0]) : length;
  });

  for (const [alias, canonical] of orderedAliases) {
    const normalizedAlias = normalizeCaption(alias);
    if (
      normalizedAlias.length > 0 &&
      phrasePattern(normalizedAlias).test(normalizedCaption) &&
      !found.includes(canonical)
    ) {
      found.push(canonical);
    }
  }
  return found;
}

function normalizedDates(
  value: string,
): { dates: string[]; withoutDates: string } {
  const dates: string[] = [];
  let withoutDates = value;
  const addDate = (year: string, month: string, day: string, raw: string) => {
    const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    if (!dates.includes(iso)) dates.push(iso);
    withoutDates = withoutDates.replace(raw, " ");
  };

  const isoPattern = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu;
  for (const match of value.matchAll(isoPattern)) {
    addDate(match[1], match[2], match[3], match[0]);
  }

  const koreanPattern = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일?/gu;
  for (const match of value.matchAll(koreanPattern)) {
    addDate(match[1], match[2], match[3], match[0]);
  }

  const englishPattern =
    /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/gu;
  for (const match of value.matchAll(englishPattern)) {
    addDate(match[3], String(MONTHS[match[2]]), match[1], match[0]);
  }

  return { dates, withoutDates };
}

function normalizedNumbers(value: string): string[] {
  const found: string[] = [];
  const numberPattern =
    /(?<![\p{L}\p{N}])\d[\d,]*(?:\.\d+)?(?:[km])?(?![\p{L}\p{N}])/giu;
  for (const match of value.matchAll(numberPattern)) {
    const number = match[0].replaceAll(",", "");
    if (!found.includes(number)) found.push(number);
  }
  return found;
}

function parsePublishedAt(publishedAt: string): string {
  const parsed = new Date(publishedAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Invalid published timestamp");
  }
  return parsed.toISOString();
}

function canonicalTerm(value: string): string | null {
  const normalized = normalizeCaption(value);
  if (normalized === "") return null;
  return normalized.replaceAll(" ", "_").slice(0, 160);
}

function multimodalTerms(
  terms: readonly string[],
  normalizedText: string,
  aliases: Readonly<Record<string, string>>,
): string[] {
  const found = lookupAliases(normalizedText, aliases);
  for (const term of terms) {
    const canonical = canonicalTerm(term);
    if (canonical !== null && !found.includes(canonical)) found.push(canonical);
  }
  return found;
}

function mergeUnique(left: readonly string[], right: readonly string[]): string[] {
  const values = [...left];
  for (const value of right) if (!values.includes(value)) values.push(value);
  return values;
}

function multimodalContext(input: MultimodalFeatureInput): string[] {
  const values = [input.visualSummary, input.combinedSummary, ...input.topics, ...input.claims.map((claim) => claim.text)]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.slice(0, 500));
  return values.slice(0, 16);
}

export function extractStoryFeatures(
  caption: string,
  publishedAt: string,
  dictionary: IntelligenceDictionary = DEFAULT_INTELLIGENCE_DICTIONARY,
  multimodal?: MultimodalFeatureInput,
): StoryFeatures {
  const normalized = normalizeCaption(caption);
  const dateResult = normalizedDates(normalized);
  if (!multimodal) {
    return {
      entities: lookupAliases(normalized, dictionary.entities),
      events: lookupAliases(normalized, dictionary.events),
      sources: lookupAliases(normalized, dictionary.sources),
      numbers: normalizedNumbers(dateResult.withoutDates),
      dates: dateResult.dates,
      normalizedCaption: normalized,
      tokens: normalized.split(" ").filter(Boolean),
      publishedAt: parsePublishedAt(publishedAt),
      dictionaryVersion: dictionary.version,
    };
  }

  const semanticText = [
    multimodal.visualSummary,
    multimodal.combinedSummary,
    ...multimodal.topics,
    ...multimodal.sourceNames,
    ...multimodal.importantNumbers,
    ...multimodal.claims.map((claim) => claim.text),
  ].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const normalizedSemantic = normalizeCaption(semanticText.join(" "));
  const semanticDateResult = normalizedDates(normalizedSemantic);
  const semanticTokens = normalizedSemantic.split(" ").filter(Boolean);
  const semanticEntities = multimodalTerms(multimodal.entities, normalizedSemantic, dictionary.entities);
  const semanticTopics = multimodalTerms(multimodal.topics, normalizedSemantic, dictionary.events);
  const semanticSources = multimodalTerms(multimodal.sourceNames, normalizedSemantic, dictionary.sources);
  const semanticNumbers = normalizedNumbers(
    [...multimodal.importantNumbers, normalizedSemantic].join(" "),
  );

  return {
    entities: mergeUnique(lookupAliases(normalized, dictionary.entities), semanticEntities),
    events: mergeUnique(lookupAliases(normalized, dictionary.events), semanticTopics),
    sources: mergeUnique(lookupAliases(normalized, dictionary.sources), semanticSources),
    numbers: mergeUnique(normalizedNumbers(dateResult.withoutDates), semanticNumbers),
    dates: mergeUnique(dateResult.dates, semanticDateResult.dates),
    normalizedCaption: normalized,
    tokens: mergeUnique(normalized.split(" ").filter(Boolean), semanticTokens),
    publishedAt: parsePublishedAt(publishedAt),
    dictionaryVersion: dictionary.version,
    multimodalContext: multimodalContext(multimodal),
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableSerialize(record[key])}`
    ).join(",")
  }}`;
}

export function stableCanonicalJson(input: unknown): string {
  return stableSerialize(input);
}

export async function canonicalInputHash(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableCanonicalJson(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
