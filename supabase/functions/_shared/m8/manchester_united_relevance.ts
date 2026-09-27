/**
 * Deterministic Manchester United relevance gate shared by ingestion-adjacent
 * ranking and Telegram presentation paths.
 *
 * This is intentionally conservative. It is a routing guard, not an editorial
 * quality score: a story that does not pass it should not become a ManUtd
 * Editor candidate, while a passing story still needs normal grounding and
 * human approval.
 */

export interface ManchesterUnitedRelevanceInput {
  readonly canonicalTitle?: unknown;
  readonly summary?: unknown;
  readonly signature?: unknown;
  readonly sourceUsernames?: readonly string[];
}

const FOCUSED_SOURCE_USERNAMES = new Set([
  "all.man.united",
  "manchesterunited_central",
  "manunitedzone",
  "manutd_daily",
  "mufc_gossip_",
  "mufc_news.20",
  "utddistrict",
  "utdreport",
]);

const EXPLICIT_MANCHESTER_UNITED_TERMS = [
  "manchester united",
  "man utd",
  "man united",
  "mufc",
  "맨체스터 유나이티드",
  "맨유",
  "red devils",
  "old trafford",
  "carrington",
  "올드 트래퍼드",
  "캐링턴",
];

// Player/manager signals are deliberately limited to high-confidence names
// already used by the M8 fixtures or the seeded editorial workflow. This lets
// broad discovery sources surface a United story without treating all football
// posts as United stories.
const MANCHESTER_UNITED_RELATED_TERMS = [
  "bruno fernandes",
  "bruno_fernandes",
  "브루노 페르난데스",
  "브루노",
  "jadon sancho",
  "jadon_sancho",
  "sancho",
  "산초",
  "alejandro garnacho",
  "alejandro_garnacho",
  "garnacho",
  "가르나초",
  "marcus rashford",
  "marcus_rashford",
  "rashford",
  "래시포드",
  "kobbie mainoo",
  "kobbie_mainoo",
  "mainoo",
  "마이누",
  "ruben amorim",
  "ruben_amorim",
  "amorim",
  "아모림",
  "erik ten hag",
  "erik_ten_hag",
  "ten hag",
  "텐 하흐",
];

const MANCHESTER_CITY_ONLY_TERMS = [
  "manchester city",
  "manchester_city",
  "맨체스터 시티",
  "맨시티",
];

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function termsPresent(haystack: string, terms: readonly string[]): boolean {
  return terms.some((term) => haystack.includes(normalize(term)));
}

function signatureText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  const keys = [
    "entities",
    "events",
    "sources",
    "multimodal_context",
    "multimodalContext",
    "normalized_captions",
    "normalizedCaptions",
  ];
  return keys.flatMap((key) => {
    const item = record[key];
    return Array.isArray(item) ? item.filter((entry): entry is string => typeof entry === "string") : [];
  }).join(" ");
}

export function isManchesterUnitedFocusedSource(username: string): boolean {
  return FOCUSED_SOURCE_USERNAMES.has(normalize(username));
}

export function isManchesterUnitedRelevant(input: ManchesterUnitedRelevanceInput): boolean {
  const sourceUsernames = (input.sourceUsernames ?? []).map(normalize);
  if (sourceUsernames.some((username) => FOCUSED_SOURCE_USERNAMES.has(username))) return true;

  const haystack = normalize([
    typeof input.canonicalTitle === "string" ? input.canonicalTitle : "",
    typeof input.summary === "string" ? input.summary : "",
    signatureText(input.signature),
  ].join(" "));
  const explicitUnitedSignal = termsPresent(haystack, EXPLICIT_MANCHESTER_UNITED_TERMS);
  if (explicitUnitedSignal) return true;

  // Do not let a generic story about Manchester City pass merely because a
  // comparison or league context mentions United elsewhere.
  if (termsPresent(haystack, MANCHESTER_CITY_ONLY_TERMS)) return false;
  return termsPresent(haystack, MANCHESTER_UNITED_RELATED_TERMS);
}
