import { clusterObservations } from "../trend-discovery/clustering.ts";
import { isTrendRelevant } from "../trend-discovery/relevance.ts";
import type { PromotionObservation, PromotionStory, DiscoveryPromotionRepository, PromotionSummary } from "./types.ts";

interface PromoteDiscoveryOptions {
  readonly asOf?: Date | string;
  readonly repository: DiscoveryPromotionRepository;
  readonly limit?: number;
  readonly rankingDate?: string;
  readonly promotionJobId?: string;
  readonly refreshExistingGrounding?: boolean;
}

function asOfDate(value: Date | string | undefined): Date {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? new Date());
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_PROMOTION_AS_OF");
  return date;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim()) : [];
}

function topicOf(observation: PromotionObservation): string {
  const metadata = record(observation.metadata);
  if (typeof metadata.topic_family === "string" && metadata.topic_family.trim() !== "") return metadata.topic_family.trim().toUpperCase().slice(0, 80);
  const title = observation.title.toLocaleLowerCase("en-US");
  if (title.includes("injur") || title.includes("out")) return "INJURY";
  if (title.includes("transfer") || title.includes("signing")) return "TRANSFER";
  if (title.includes("contract") || title.includes("extend")) return "CONTRACT";
  return "DISCOVERY";
}

function entitiesOf(observation: PromotionObservation): string[] {
  const metadata = record(observation.metadata);
  return [...new Set([
    ...strings(metadata.entities),
    ...strings(metadata.detected_entities),
    ...(typeof metadata.entity_name === "string" ? [metadata.entity_name.trim()] : []),
  ])].slice(0, 24);
}

function eventTime(observation: PromotionObservation): number {
  const published = observation.publishedAt ? Date.parse(observation.publishedAt) : Number.NaN;
  const observed = Date.parse(observation.firstObservedAt || observation.observedAt);
  return Number.isFinite(published) ? published : observed;
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function slug(value: string): string {
  return value.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^a-z0-9가-힣]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 80) || "story";
}

function promotionKey(topic: string, observations: readonly PromotionObservation[]): string {
  const entity = entitiesOf(observations[0]!).sort((left, right) => left.localeCompare(right))[0];
  return `promotion:${slug(topic)}:${slug(entity ?? observations[0]!.title)}`;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? []);
}

function safeStoryMatch(story: PromotionStory, key: string, observations: readonly PromotionObservation[]): boolean {
  if (story.promotionKey === key) return true;
  const fingerprints = strings(story.signature.content_fingerprints);
  if (observations.some((item) => fingerprints.includes(item.contentFingerprint))) return true;
  const left = tokenSet(story.canonicalTitle);
  const right = tokenSet(observations[0]!.title);
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap >= 2 && overlap / Math.max(1, Math.min(left.size, right.size)) >= 0.6;
}

function signatureFor(
  existing: PromotionStory | undefined,
  topic: string,
  observations: readonly PromotionObservation[],
): Readonly<Record<string, unknown>> {
  const previous = record(existing?.signature);
  const fingerprints = [...new Set([
    ...strings(previous.content_fingerprints),
    ...observations.map((item) => item.contentFingerprint),
  ])].slice(-64);
  const entities = [...new Set([
    ...strings(previous.detected_entities),
    ...observations.flatMap(entitiesOf),
  ])].slice(0, 24);
  const provenance = [...new Set([
    ...observations.map((item) => `${item.providerId}:${item.externalId}`),
    ...strings(previous.discovery_provenance),
  ])].slice(-64);
  return {
    ...previous,
    version: "m8-6-v1",
    topic_family: topic,
    detected_entities: entities,
    content_fingerprints: fingerprints,
    discovery_provenance: provenance,
  };
}

export async function promoteDiscovery(options: PromoteDiscoveryOptions): Promise<PromotionSummary> {
  const asOf = asOfDate(options.asOf);
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("INVALID_PROMOTION_LIMIT");
  const listedObservations = [...await options.repository.listFreshUnassigned(asOf, limit, options.promotionJobId)];
  if (listedObservations.length > limit) throw new Error("PROMOTION_LIMIT_EXCEEDED");
  const observations = listedObservations.filter((item) => item.providerId !== "google-news" || isTrendRelevant({
    title: item.title,
    excerpt: item.excerpt,
    entities: strings(record(item.metadata).entities),
  }));
  if (observations.length === 0 && !options.refreshExistingGrounding) return { status: "COMPLETED", observationsProcessed: 0, storiesCreated: 0, storiesUpdated: 0, claimsCreated: 0, editorialCandidatesEnsured: 0, affectedStoryIds: [] };
  const stories = [...await options.repository.listStories(asOf)];
  const clusters = clusterObservations(observations);
  let storiesCreated = 0;
  let storiesUpdated = 0;
  let claimsCreated = 0;
  let editorialCandidatesEnsured = 0;
  const affectedStoryIds = new Set<string>();
  for (const cluster of clusters) {
    const items = cluster.observations as readonly PromotionObservation[];
    const topic = topicOf(items[0]!);
    const key = promotionKey(topic, items);
    const existing = stories.find((story) => safeStoryMatch(story, key, items));
    const times = items.map(eventTime).filter(Number.isFinite);
    const firstSeenAt = iso(Math.min(...times));
    const lastSeenAt = iso(Math.max(...times));
    const assignedStoryIds = new Set(items.map((item) => item.storyClusterId).filter((id): id is string => Boolean(id)));
    let story: { id: string; created: boolean };
    if (options.promotionJobId && assignedStoryIds.size > 0) {
      const assignedStoryId = assignedStoryIds.values().next().value as string;
      const assignedStory = stories.find((candidate) => candidate.id === assignedStoryId);
      if (assignedStoryIds.size !== 1 || !assignedStory || !safeStoryMatch(assignedStory, key, items)) {
        throw new Error("PROMOTION_JOB_STORY_MISMATCH");
      }
      // A one-row repair job may attach source evidence to its existing story,
      // but must not refresh status, title, timestamps or signatures.
      story = { id: assignedStory.id, created: false };
    } else {
      story = await options.repository.upsertStory({
        canonicalTitle: cluster.representativeTitle,
        summary: items[0]!.excerpt,
        topic,
        firstSeenAt: existing ? new Date(Math.min(Date.parse(existing.firstSeenAt), Date.parse(firstSeenAt))).toISOString() : firstSeenAt,
        lastSeenAt: existing ? new Date(Math.max(Date.parse(existing.lastSeenAt), Date.parse(lastSeenAt))).toISOString() : lastSeenAt,
        promotionKey: existing?.promotionKey ?? key,
        signature: signatureFor(existing, topic, items),
      });
    }
    if (story.created) storiesCreated += 1;
    else storiesUpdated += 1;
    affectedStoryIds.add(story.id);
    for (const item of items) {
      const sourceObservationId = await options.repository.ensureSourceObservation(item);
      const publisherSourceObservationId = await options.repository.ensureReviewedPublisherObservation(item);
      if (publisherSourceObservationId) await options.repository.ensurePublisherReportClaims({ observation: item, storyClusterId: story.id, publisherSourceObservationId });
      await options.repository.assignObservation(item.id, story.id, sourceObservationId, options.promotionJobId);
      await options.repository.ensureDiscoveryClaim({ observationId: item.id, storyClusterId: story.id, sourceObservationId, status: "DISCOVERY_ONLY" });
      claimsCreated += 1;
    }
  }
  if (options.refreshExistingGrounding && affectedStoryIds.size < 100) {
    // Trusted fact evidence can arrive for an already-known story without any
    // new discovery observation. Recheck only recent canonical stories, with a
    // strict cap; never fall back to a historical global grounding scan.
    const since = asOf.getTime() - 48 * 60 * 60 * 1000;
    const remaining = Math.min(25, limit, 100 - affectedStoryIds.size);
    const recent = stories.filter((story) => {
      const seen = Date.parse(story.lastSeenAt);
      return Number.isFinite(seen) && seen >= since && seen <= asOf.getTime();
    }).sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))
      .slice(0, remaining);
    for (const story of recent) affectedStoryIds.add(story.id);
  }
  return { status: "COMPLETED", observationsProcessed: observations.length, storiesCreated, storiesUpdated, claimsCreated, editorialCandidatesEnsured, affectedStoryIds: [...affectedStoryIds] };
}
