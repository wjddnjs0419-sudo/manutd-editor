import type { ClusterSignature, StoryFeatures } from "./types.ts";

const AUTO_MERGE_THRESHOLD = 0.85;
const SEPARATE_THRESHOLD = 0.4;
const TIME_SIGNAL_HOURS = 24;

export interface SimilaritySignals {
  readonly entityOverlap: number;
  readonly eventOverlap: number;
  readonly sourceOverlap: number;
  readonly numberOverlap: number;
  readonly timeProximity: number;
  readonly captionSimilarity: number;
}

export interface SimilarityResult {
  readonly score: number;
  readonly primaryEntityOverlap: boolean;
  readonly contradiction: boolean;
  readonly signals: SimilaritySignals;
  readonly reasonCode: string;
}

export type DeterministicDecisionValue =
  | "AUTO_MERGE"
  | "SEPARATE"
  | "AMBIGUOUS";

export interface DeterministicDecision {
  readonly decision: DeterministicDecisionValue;
  readonly reasonCode: string;
}

export interface RepresentativeMember {
  readonly postId: string;
  readonly reliability: number;
  readonly publishedAt: string;
}

interface SignatureContext extends ClusterSignature {
  readonly normalizedCaptions?: readonly string[];
}

const WEIGHTS = {
  entity: 0.35,
  event: 0.20,
  source: 0.15,
  number: 0.10,
  time: 0.10,
  caption: 0.10,
} as const;

function hasOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function tokenSet(value: string): Set<string> {
  return new Set(
    value.toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function captionSimilarity(
  post: StoryFeatures,
  signature: SignatureContext,
): number {
  const postTokens = new Set(
    post.tokens.length > 0
      ? post.tokens
      : [...tokenSet(post.normalizedCaption)],
  );
  const captions = signature.normalizedCaptions ?? [];
  let best = 0;

  for (const caption of captions) {
    best = Math.max(best, jaccard(postTokens, tokenSet(caption)));
  }

  return best;
}

function timeProximity(
  post: StoryFeatures,
  signature: ClusterSignature,
): number {
  const postTime = new Date(post.publishedAt).getTime();
  const firstTime = new Date(signature.firstPublishedAt).getTime();
  const lastTime = new Date(signature.lastPublishedAt).getTime();
  if (![postTime, firstTime, lastTime].every(Number.isFinite)) return 0;

  const distance = postTime < firstTime
    ? firstTime - postTime
    : postTime > lastTime
    ? postTime - lastTime
    : 0;
  const hours = distance / (60 * 60 * 1000);
  return Math.max(0, 1 - hours / TIME_SIGNAL_HOURS);
}

function signatureCaptions(signature: ClusterSignature): SignatureContext {
  return signature as SignatureContext;
}

export function deterministicSimilarity(
  post: StoryFeatures,
  signature: ClusterSignature,
): SimilarityResult {
  const context = signatureCaptions(signature);
  const primaryEntityOverlap = hasOverlap(post.entities, signature.entities);
  const eventOverlap = hasOverlap(post.events, signature.events);
  const contradiction = primaryEntityOverlap && post.events.length > 0 &&
    signature.events.length > 0 &&
    !eventOverlap;
  const signals: SimilaritySignals = {
    entityOverlap: primaryEntityOverlap ? 1 : 0,
    eventOverlap: eventOverlap ? 1 : 0,
    sourceOverlap: hasOverlap(post.sources, signature.sources) ? 1 : 0,
    numberOverlap: hasOverlap(post.numbers, signature.numbers) ? 1 : 0,
    timeProximity: timeProximity(post, signature),
    captionSimilarity: captionSimilarity(post, context),
  };
  const score = WEIGHTS.entity * signals.entityOverlap +
    WEIGHTS.event * signals.eventOverlap +
    WEIGHTS.source * signals.sourceOverlap +
    WEIGHTS.number * signals.numberOverlap +
    WEIGHTS.time * signals.timeProximity +
    WEIGHTS.caption * signals.captionSimilarity;

  return {
    score: Number(score.toFixed(10)),
    primaryEntityOverlap,
    contradiction,
    signals,
    reasonCode: contradiction ? "CONTRADICTORY_ANCHOR" : "SIGNALS_EVALUATED",
  };
}

export function candidatePrefilter(
  post: StoryFeatures,
  signature: ClusterSignature,
): boolean {
  const context = signatureCaptions(signature);
  const entityOverlap = hasOverlap(post.entities, signature.entities);
  const eventAndTeamOrOpponentOverlap = post.events.length > 0 &&
    signature.events.length > 0 && entityOverlap &&
    hasOverlap(post.events, signature.events);
  const sourceOverlap = hasOverlap(post.sources, signature.sources);
  const numberOverlap = hasOverlap(post.numbers, signature.numbers);
  const captionOverlap = captionSimilarity(post, context) >= 0.25;

  return entityOverlap || eventAndTeamOrOpponentOverlap || sourceOverlap ||
    numberOverlap || captionOverlap;
}

export function decideDeterministicMatch(
  result: SimilarityResult,
): DeterministicDecision {
  if (result.contradiction) {
    return { decision: "SEPARATE", reasonCode: "CONTRADICTORY_ANCHOR" };
  }
  if (result.score <= SEPARATE_THRESHOLD) {
    return { decision: "SEPARATE", reasonCode: "LOW_SCORE" };
  }
  if (result.score >= AUTO_MERGE_THRESHOLD) {
    if (!result.primaryEntityOverlap) {
      return { decision: "SEPARATE", reasonCode: "NO_PRIMARY_ENTITY" };
    }
    return { decision: "AUTO_MERGE", reasonCode: "HIGH_SCORE_PRIMARY_ENTITY" };
  }
  return { decision: "AMBIGUOUS", reasonCode: "AMBIGUOUS_SCORE" };
}

function unionInInputOrder(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const values = [...left];
  for (const value of right) {
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function earliest(left: string, right: string): string {
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
}

function latest(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

export function mergeSignature(
  signature: ClusterSignature,
  post: StoryFeatures,
  postId: string,
): ClusterSignature {
  if (signature.dictionaryVersion !== post.dictionaryVersion) {
    throw new Error("Dictionary version mismatch");
  }

  const current = signatureCaptions(signature);
  const representativePostIds = [...signature.representativePostIds];
  if (!representativePostIds.includes(postId)) {
    representativePostIds.push(postId);
  }

  const merged: SignatureContext = {
    entities: unionInInputOrder(signature.entities, post.entities),
    events: unionInInputOrder(signature.events, post.events),
    sources: unionInInputOrder(signature.sources, post.sources),
    numbers: unionInInputOrder(signature.numbers, post.numbers),
    firstPublishedAt: earliest(signature.firstPublishedAt, post.publishedAt),
    lastPublishedAt: latest(signature.lastPublishedAt, post.publishedAt),
    representativePostIds,
    dictionaryVersion: signature.dictionaryVersion,
    normalizedCaptions: unionInInputOrder(
      current.normalizedCaptions ?? [],
      [post.normalizedCaption],
    ),
  };

  return merged;
}

export function selectRepresentativeMembers(
  members: readonly RepresentativeMember[],
  limit = 3,
): string[] {
  if (limit <= 0) return [];

  return members
    .map((member, index) => ({ member, index }))
    .sort((left, right) => {
      const reliability = right.member.reliability - left.member.reliability;
      if (reliability !== 0) return reliability;
      const freshness = new Date(right.member.publishedAt).getTime() -
        new Date(left.member.publishedAt).getTime();
      return freshness !== 0 ? freshness : left.index - right.index;
    })
    .slice(0, limit)
    .map(({ member }) => member.postId);
}
