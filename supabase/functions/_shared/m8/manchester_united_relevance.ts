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
  readonly title?: unknown;
  readonly body?: unknown;
  readonly entities?: unknown;
  readonly topic?: unknown;
}

export type ManchesterUnitedRelevanceClass = "UNITED_PRIMARY" | "OPPONENT_MATCH_CONTEXT" | "INCIDENTAL_MENTION" | "OTHER_SPORT" | "TRANSFER_ROUNDUP" | "UNRELATED";
export interface ManchesterUnitedRelevanceResult {
  readonly classification: ManchesterUnitedRelevanceClass;
  readonly autoEligible: boolean;
  readonly reasonCodes: readonly string[];
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

const OTHER_CLUB_TERMS = [
  "arsenal",
  "아스날",
  "아스널",
  "liverpool",
  "리버풀",
  "chelsea",
  "첼시",
  "tottenham",
  "토트넘",
  "fulham",
  "풀럼",
  "brighton",
  "everton",
  "newcastle",
  "west ham",
  "wolves",
  "brentford",
  "bournemouth",
  "nottingham forest",
  "leicester",
  "southampton",
  "crystal palace",
  "aston villa",
  "브라이튼",
  "barcelona",
  "바르셀로나",
  "psg",
  "paris saint germain",
  "man city",
  "spurs",
  "atletico",
  "atletico madrid",
  "real madrid",
  "bayern",
  "inter milan",
  "ac milan",
  "napoli",
  "유벤투스",
  "juventus",
  ...MANCHESTER_CITY_ONLY_TERMS,
];

const OTHER_SPORT_TERMS = ["nfl", "nba", "wnba", "nhl", "mlb", "ncaaf", "ncaab", "super bowl", "jaguars", "jacksonville jaguars", "chiefs", "lakers", "celtics", "yankees", "padres", "테니스", "야구", "농구", "미식축구", "하키"];

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

function firstTermPosition(haystack: string, terms: readonly string[]): number {
  const positions = terms.map((term) => haystack.indexOf(normalize(term))).filter((position) => position >= 0);
  return positions.length > 0 ? Math.min(...positions) : -1;
}

function termOccurrences(haystack: string, term: string): number {
  const needle = normalize(term);
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const position = haystack.indexOf(needle, offset);
    if (position < 0) break;
    count += 1;
    offset = position + needle.length;
  }
  return count;
}

function hasSecondaryUnitedMention(haystack: string): boolean {
  const unitedPosition = firstTermPosition(haystack, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]);
  if (unitedPosition < 0) return false;
  const competitorPosition = firstTermPosition(haystack, OTHER_CLUB_TERMS);
  if (competitorPosition < 0) return false;
  const competitorOccurrences = OTHER_CLUB_TERMS.reduce((total, term) => total + termOccurrences(haystack, term), 0);

  // Broad sources often put a generic league/listicle setup first and mention
  // United only in a ranking or as the next opponent. Keep match-like copy
  // with United in the opening subject, but reject those secondary mentions.
  if (unitedPosition >= 80) return true;
  return competitorPosition < unitedPosition && competitorOccurrences >= 2;
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

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function entityText(value: unknown): string {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join(" ");
  return signatureText(value);
}

function hasDirectFixtureSignal(value: string): boolean {
  return /\b(vs?\.?|against|clash|fixture|match|meet|face|opposition|preview)\b|상대|맞대결|경기|프리뷰|대결/u.test(value);
}

function otherSport(title: string, topic: string): boolean {
  const titleTopic = `${title} ${topic}`;
  return termsPresent(titleTopic, OTHER_SPORT_TERMS) || (/\b(nfl|nba|wnba|nhl|mlb|ncaaf|ncaab)\b/u.test(titleTopic));
}

function isRoundup(title: string, body: string, topic: string, allSignals: string): boolean {
  const roundupLanguage = /\b(round ?up|all clubs|multiple clubs|transfer news(?:\s+live)?|transfer rumou?rs?|transfer links?|paper talk|rumou?rs?|linked with|destinations?)\b|루머 모음|이적설 모음|여러 구단|이적 후보/u.test(`${title} ${topic}`);
  const clubCount = new Set(OTHER_CLUB_TERMS.filter((term) => termsPresent(allSignals, [term])).map(normalize)).size;
  return roundupLanguage && clubCount >= 2 && termsPresent(allSignals, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]);
}

export function classifyManchesterUnitedRelevance(input: ManchesterUnitedRelevanceInput): ManchesterUnitedRelevanceResult {
  const title = normalize(text(input.title ?? input.canonicalTitle));
  const body = normalize(text(input.body ?? input.summary));
  const entities = normalize(entityText(input.entities ?? input.signature));
  const topic = normalize(text(input.topic));
  const allSignals = `${title} ${body} ${entities} ${topic}`;
  const directTitle = termsPresent(title, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]);
  const directBody = termsPresent(body, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]);
  const unitedEntity = termsPresent(entities, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]);
  const unitedAny = directTitle || directBody || unitedEntity;
  const focusedSource = (input.sourceUsernames ?? []).some((username) => FOCUSED_SOURCE_USERNAMES.has(normalize(username.replace(/^@/u, ""))));
  if (otherSport(title, topic)) return { classification: "OTHER_SPORT", autoEligible: false, reasonCodes: ["OTHER_SPORT_CONTEXT"] };
  if (termsPresent(allSignals, MANCHESTER_CITY_ONLY_TERMS) && !termsPresent(title, EXPLICIT_MANCHESTER_UNITED_TERMS)) return { classification: unitedAny ? "INCIDENTAL_MENTION" : "UNRELATED", autoEligible: false, reasonCodes: ["MANCHESTER_CITY_ONLY_OR_COMPARISON"] };
  if (isRoundup(title, body, topic, allSignals)) return { classification: "TRANSFER_ROUNDUP", autoEligible: false, reasonCodes: ["MULTI_CLUB_TRANSFER_ROUNDUP"] };

  const unitedTitlePosition = firstTermPosition(title, EXPLICIT_MANCHESTER_UNITED_TERMS);
  const opponentTitlePosition = firstTermPosition(title, OTHER_CLUB_TERMS);
  const opponentContext = (directBody || unitedEntity) && opponentTitlePosition >= 0 && (unitedTitlePosition < 0 || opponentTitlePosition < unitedTitlePosition) && hasDirectFixtureSignal(`${title} ${body} ${topic}`) && /(match|fixture|preview|opponent|matchday|경기|프리뷰|상대|맞대결)/u.test(topic + " " + title + " " + body);
  if (opponentContext) return { classification: "OPPONENT_MATCH_CONTEXT", autoEligible: true, reasonCodes: ["UNITED_FIXTURE_CONTEXT"] };

  const titleTopicContradiction = termsPresent(title, OTHER_CLUB_TERMS) && !directTitle && !/(match|fixture|preview|opponent|matchday|경기|프리뷰|상대|맞대결)/u.test(topic + " " + title);
  if (titleTopicContradiction) return { classification: unitedAny ? "INCIDENTAL_MENTION" : "UNRELATED", autoEligible: false, reasonCodes: ["UNITED_NOT_PRIMARY_TOPIC"] };
  if (directTitle && (directBody || unitedEntity || focusedSource) && !hasSecondaryUnitedMention(`${title} ${body}`)) return { classification: "UNITED_PRIMARY", autoEligible: true, reasonCodes: [focusedSource ? "FOCUSED_SOURCE_AND_TITLE" : "TITLE_BODY_ENTITY_ALIGNMENT"] };
  if (focusedSource && !unitedAny) return { classification: "UNITED_PRIMARY", autoEligible: true, reasonCodes: ["ALLOWLISTED_FOCUSED_SOURCE"] };
  if (unitedAny) return { classification: "INCIDENTAL_MENTION", autoEligible: false, reasonCodes: ["UNITED_SIGNAL_NOT_CENTRAL"] };
  return { classification: "UNRELATED", autoEligible: false, reasonCodes: ["NO_UNITED_SIGNAL"] };
}

export function isManchesterUnitedRelevant(input: ManchesterUnitedRelevanceInput): boolean {
  const result = classifyManchesterUnitedRelevance(input);
  if (result.autoEligible) return true;
  // Preserve historical callers until they pass structured source evidence;
  // the ranking repository uses the conservative classifier directly.
  const haystack = normalize(`${text(input.canonicalTitle)} ${text(input.summary)} ${signatureText(input.signature)}`);
  return !otherSport(normalize(text(input.canonicalTitle)), "") &&
    !termsPresent(haystack, MANCHESTER_CITY_ONLY_TERMS) && !hasSecondaryUnitedMention(haystack) &&
    (termsPresent(haystack, [...EXPLICIT_MANCHESTER_UNITED_TERMS, ...MANCHESTER_UNITED_RELATED_TERMS]) || (input.sourceUsernames ?? []).some((username) => isManchesterUnitedFocusedSource(username.replace(/^@/u, ""))));
}
