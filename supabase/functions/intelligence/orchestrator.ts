import {
  candidatePrefilter,
  decideDeterministicMatch,
  deterministicSimilarity,
  mergeSignature,
  type DeterministicDecisionValue,
} from "./clustering.ts";
import {
  extractStoryFeatures,
  DEFAULT_INTELLIGENCE_DICTIONARY,
} from "./features.ts";
import { canonicalInputHash } from "./features.ts";
import type {
  ClassifierResult,
  StoryClusterEvaluation,
  StoryClassifier,
} from "./ai_classifier.ts";
import type {
  ClusterSignature,
  IntelligenceConfig,
  IntelligenceDictionary,
  IntelligenceRunSummary,
  StoryFeatures,
} from "./types.ts";
import {
  type EligibleAccountSnapshot,
  type IntelligenceRepository,
  type InformationSourceRecord,
  type RecentRawPost,
  type StoryClusterContext,
} from "./repository.ts";

export type LifecycleStatus = "OPEN" | "ACTIVE" | "STALE" | "ARCHIVED";

export interface LifecycleInput {
  readonly currentStatus: LifecycleStatus;
  readonly lastSeenAt: string;
  readonly memberCount: number;
  readonly runAt: string;
  readonly manualArchived?: boolean;
}

export interface RunIntelligenceOptions {
  readonly repository: IntelligenceRepository;
  readonly config: IntelligenceConfig;
  readonly runAt?: Date | string;
  readonly dictionary?: IntelligenceDictionary;
  readonly classifier?: StoryClassifier;
  readonly classify?: (
    input: Parameters<StoryClassifier["classifyAmbiguousPair"]>[0],
  ) => Promise<ClassifierResult>;
  readonly onEligibleAccounts?: (snapshot: EligibleAccountSnapshot) => void;
  readonly now?: () => Date;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
}

function date(value: Date | string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid intelligence run timestamp");
  return parsed;
}

function iso(value: Date | string): string {
  return date(value).toISOString();
}

export function deriveLifecycleStatus(input: LifecycleInput): LifecycleStatus {
  if (input.manualArchived || input.currentStatus === "ARCHIVED") return "ARCHIVED";
  const lastSeen = date(input.lastSeenAt).getTime();
  const runAt = date(input.runAt).getTime();
  if (lastSeen < runAt - 7 * 24 * 60 * 60 * 1000) return "ARCHIVED";
  if (lastSeen < runAt - 6 * 60 * 60 * 1000) return "STALE";
  if (lastSeen <= runAt && input.memberCount >= 2) return "ACTIVE";
  return "OPEN";
}

function emptySignature(features: StoryFeatures): ClusterSignature {
  return {
    entities: [...features.entities],
    events: [...features.events],
    sources: [...features.sources],
    numbers: [...features.numbers],
    firstPublishedAt: features.publishedAt,
    lastPublishedAt: features.publishedAt,
    representativePostIds: [],
    dictionaryVersion: features.dictionaryVersion,
  };
}

function signature(value: Record<string, unknown>, fallback: StoryFeatures): ClusterSignature {
  const values = (key: string, fallbackValue: readonly string[]): string[] => {
    const valueAtKey = value[key];
    return Array.isArray(valueAtKey)
      ? valueAtKey.filter((item): item is string => typeof item === "string")
      : [...fallbackValue];
  };
  const representativePostIds = values(
    "representativePostIds",
    values("representative_post_ids", []),
  );
  const normalizedCaptions = values("normalizedCaptions", values("normalized_captions", []));
  return {
    entities: values("entities", fallback.entities),
    events: values("events", fallback.events),
    sources: values("sources", fallback.sources),
    numbers: values("numbers", fallback.numbers),
    firstPublishedAt: typeof value.firstPublishedAt === "string"
      ? value.firstPublishedAt
      : typeof value.first_published_at === "string"
      ? value.first_published_at
      : fallback.publishedAt,
    lastPublishedAt: typeof value.lastPublishedAt === "string"
      ? value.lastPublishedAt
      : typeof value.last_published_at === "string"
      ? value.last_published_at
      : fallback.publishedAt,
    representativePostIds,
    dictionaryVersion: typeof value.dictionaryVersion === "string"
      ? value.dictionaryVersion
      : typeof value.dictionary_version === "string"
      ? value.dictionary_version
      : fallback.dictionaryVersion,
    ...(normalizedCaptions.length > 0 ? { normalizedCaptions } : {}),
  };
}

function signatureJson(value: ClusterSignature): Record<string, unknown> {
  const context = value as ClusterSignature & { normalizedCaptions?: readonly string[] };
  return {
    entities: [...value.entities],
    events: [...value.events],
    sources: [...value.sources],
    numbers: [...value.numbers],
    first_published_at: value.firstPublishedAt,
    last_published_at: value.lastPublishedAt,
    representative_post_ids: [...value.representativePostIds],
    dictionary_version: value.dictionaryVersion,
    ...(context.normalizedCaptions ? { normalized_captions: [...context.normalizedCaptions] } : {}),
  };
}

function title(features: StoryFeatures): string {
  const anchor = [...features.entities, ...features.events].join(" ").trim();
  return (anchor || features.normalizedCaption || "Untitled story").slice(0, 240);
}

function withinWindow(post: RecentRawPost, context: StoryClusterContext): boolean {
  const postAt = date(post.publishedAt).getTime();
  const first = date(context.firstSeenAt).getTime();
  const last = date(context.lastSeenAt).getTime();
  return Math.abs(postAt - first) <= 24 * 60 * 60 * 1000 ||
    Math.abs(postAt - last) <= 24 * 60 * 60 * 1000;
}

function deterministicClassifierResult(
  input: Parameters<StoryClassifier["classifyAmbiguousPair"]>[0],
  decision: DeterministicDecisionValue,
): ClassifierResult {
  const sameStory = decision === "AUTO_MERGE";
  const classifierDecision = sameStory ? "SAME_STORY" : "DIFFERENT_STORY";
  return {
    decision: classifierDecision,
    sameStory,
    confidence: 1,
    reason: sameStory ? "DETERMINISTIC_HIGH" : "DETERMINISTIC_LOW",
    model: "deterministic",
    promptVersion: "none",
    dictionaryVersion: input.rawPost.dictionaryVersion,
    classifierVersion: "deterministic",
    inputHash: "",
    inputSnapshot: {
      raw_post: input.rawPost,
      aggregate_signature: input.aggregateSignature,
    },
    result: { same_story: sameStory, confidence: 1, reason: sameStory ? "DETERMINISTIC_HIGH" : "DETERMINISTIC_LOW" },
  };
}

function evaluationFromResult(
  input: Parameters<StoryClassifier["classifyAmbiguousPair"]>[0],
  result: ClassifierResult,
): StoryClusterEvaluation {
  return {
    rawPostId: input.rawPostId,
    candidateClusterId: input.candidateClusterId,
    deterministicScore: input.deterministicScore,
    decision: result.decision,
    sameStory: result.sameStory,
    confidence: result.confidence,
    reason: result.reason,
    model: result.model,
    promptVersion: result.promptVersion,
    dictionaryVersion: result.dictionaryVersion,
    classifierVersion: result.classifierVersion,
    inputHash: result.inputHash,
    inputSnapshot: result.inputSnapshot,
    result: result.result,
  };
}

function sourceMatches(source: InformationSourceRecord, canonical: string): boolean {
  const normalize = (value: string): string => value.toLocaleLowerCase("en-US").replace(/[\s_\-]+/gu, "");
  const target = normalize(canonical);
  return [source.canonicalName, source.instagramUsername ?? "", ...source.aliases]
    .some((candidate) => normalize(candidate) === target);
}

export async function runIntelligence(
  options: RunIntelligenceOptions,
): Promise<IntelligenceRunSummary> {
  const runAt = date(options.runAt ?? options.now?.() ?? new Date());
  const runId = crypto.randomUUID();
  const leaseUntil = new Date(runAt.getTime() + options.config.leaseSeconds * 1000);
  const acquired = await options.repository.tryAcquireRun(runId, runAt, leaseUntil);
  if (!acquired) {
    return {
      runId,
      status: "already_running",
      clustersProcessed: 0,
      candidatesUpserted: 0,
    };
  }

  const setIntervalImpl = options.setIntervalFn ?? setInterval;
  const clearIntervalImpl = options.clearIntervalFn ?? clearInterval;
  const renew = async (): Promise<void> => {
    try {
      await options.repository.renewRun(
        runId,
        new Date(runAt.getTime() + options.config.leaseSeconds * 1000),
      );
    } catch {
      // A later run can recover after lease expiry; upstream failure text is not exposed.
    }
  };
  const heartbeat = setIntervalImpl(() => {
    void renew();
  }, options.config.heartbeatSeconds * 1000);

  try {
    const accountSnapshot = await options.repository.loadEligibleAccounts(runAt);
    options.onEligibleAccounts?.(accountSnapshot);
    const posts = await options.repository.listRecentPosts(runAt);
    const contexts = await options.repository.listClusterContexts();
    const sources = await options.repository.listInformationSources();
    const dictionary = options.dictionary ?? DEFAULT_INTELLIGENCE_DICTIONARY;
    const clusters = new Map(contexts.map((context) => [context.id, { ...context }]));
    const processedPostIds = new Set(
      contexts.flatMap((context) => context.members.map((member) => member.rawPostId)),
    );
    const touched = new Set<string>();
    const pendingSources = new Map<string, {
      clusterId: string;
      informationSourceId: string;
      firstCitedPostId: string;
      citationCount: number;
      extractionConfidence: number;
      evidenceText: string;
    }>();

    for (const post of posts) {
      if (processedPostIds.has(post.id)) continue;
      const features = extractStoryFeatures(post.caption, post.publishedAt, dictionary);
      const candidates: Array<{
        context: StoryClusterContext;
        features: StoryFeatures;
        score: ReturnType<typeof deterministicSimilarity>;
        decision: ReturnType<typeof decideDeterministicMatch>;
      }> = [];

      for (const context of clusters.values()) {
        if (context.status === "ARCHIVED" || context.members.some((member) => member.rawPostId === post.id)) continue;
        if (!withinWindow(post, context)) continue;
        const contextSignature = signature(context.signature, features);
        if (!candidatePrefilter(features, contextSignature)) continue;
        const score = deterministicSimilarity(features, contextSignature);
        const decision = decideDeterministicMatch(score);
        candidates.push({ context, features, score, decision });
      }

      candidates.sort((left, right) => right.score.score - left.score.score || left.context.id.localeCompare(right.context.id));
      const best = candidates[0];
      let clusterId: string | undefined;
      let matchMethod: "SEED" | "DETERMINISTIC" | "AI" | "MANUAL" = "SEED";
      let matchConfidence = 1;
      let mergedSignature: ClusterSignature;

      if (!best) {
        mergedSignature = emptySignature(features);
        clusterId = await options.repository.createCluster({
          canonicalTitle: title(features),
          firstSeenAt: features.publishedAt,
          lastSeenAt: features.publishedAt,
          signature: signatureJson(mergedSignature),
        });
      } else {
        const contextSignature = signature(best.context.signature, features);
        const input = {
          rawPostId: post.id,
          candidateClusterId: best.context.id,
          deterministicScore: best.score.score,
          deterministicDecision: best.decision.decision,
          rawPost: features,
          aggregateSignature: contextSignature,
        } as Parameters<StoryClassifier["classifyAmbiguousPair"]>[0];
        let classifierResult: ClassifierResult;
        if (best.decision.decision === "AMBIGUOUS") {
          if (options.classifier) classifierResult = await options.classifier.classifyAmbiguousPair(input);
          else if (options.classify) classifierResult = await options.classify(input);
          else {
            classifierResult = {
              ...deterministicClassifierResult(input, "SEPARATE"),
              decision: "MANUAL_REVIEW",
              sameStory: null,
              confidence: null,
              reason: "AI_NOT_CONFIGURED",
              result: { same_story: null, confidence: null, reason: "AI_NOT_CONFIGURED" },
            };
            classifierResult = {
              ...classifierResult,
              inputHash: await canonicalInputHash({
                raw_post_id: input.rawPostId,
                candidate_cluster_id: input.candidateClusterId,
                deterministic_score: input.deterministicScore,
                raw_post: input.rawPost,
                aggregate_signature: input.aggregateSignature,
              }),
            };
          }
          const acceptedClassifierDecision =
            (classifierResult.decision === "SAME_STORY" || classifierResult.decision === "DIFFERENT_STORY") &&
            classifierResult.confidence !== null && classifierResult.confidence >= 0.90;
          if (!acceptedClassifierDecision) {
            const reviewResult: ClassifierResult = classifierResult.decision === "MANUAL_REVIEW" || classifierResult.decision === "ERROR"
              ? classifierResult
              : {
                ...classifierResult,
                decision: "MANUAL_REVIEW",
                reason: "LOW_CONFIDENCE",
                result: {
                  same_story: classifierResult.sameStory,
                  confidence: classifierResult.confidence,
                  reason: "LOW_CONFIDENCE",
                },
              };
            await options.repository.saveEvaluation(evaluationFromResult(input, reviewResult));
            continue;
          }
          clusterId = classifierResult.decision === "SAME_STORY" ? best.context.id : undefined;
          matchMethod = classifierResult.decision === "SAME_STORY" ? "AI" : "SEED";
          matchConfidence = classifierResult.confidence ?? 0;
        } else {
          clusterId = best.decision.decision === "AUTO_MERGE" ? best.context.id : undefined;
          matchMethod = best.decision.decision === "AUTO_MERGE" ? "DETERMINISTIC" : "SEED";
          matchConfidence = best.decision.decision === "AUTO_MERGE" ? 0.95 : 1;
        }
        if (clusterId) {
          mergedSignature = mergeSignature(contextSignature, features, post.id);
        } else {
          mergedSignature = emptySignature(features);
          clusterId = await options.repository.createCluster({
            canonicalTitle: title(features),
            firstSeenAt: features.publishedAt,
            lastSeenAt: features.publishedAt,
            signature: signatureJson(mergedSignature),
          });
        }
      }

      await options.repository.upsertMembership({
        rawPostId: post.id,
        clusterId,
        matchMethod,
        matchConfidence,
        signature: signatureJson(mergedSignature),
      });
      for (const canonical of features.sources) {
        for (const source of sources.filter((candidate) => sourceMatches(candidate, canonical))) {
          const key = `${clusterId}\u0000${source.id}`;
          const existing = pendingSources.get(key);
          pendingSources.set(key, existing
            ? { ...existing, citationCount: existing.citationCount + 1 }
            : {
              clusterId,
              informationSourceId: source.id,
              firstCitedPostId: post.id,
              citationCount: 1,
              extractionConfidence: 1,
              evidenceText: canonical,
            });
        }
      }
      const previous = clusters.get(clusterId);
      clusters.set(clusterId, {
        id: clusterId,
        canonicalTitle: previous?.canonicalTitle ?? title(features),
        status: previous?.status ?? "OPEN",
        firstSeenAt: previous && new Date(previous.firstSeenAt) < new Date(features.publishedAt) ? previous.firstSeenAt : features.publishedAt,
        lastSeenAt: previous && new Date(previous.lastSeenAt) > new Date(features.publishedAt) ? previous.lastSeenAt : features.publishedAt,
        signature: signatureJson(mergedSignature),
        members: [...(previous?.members ?? []), {
          rawPostId: post.id,
          createdAt: post.createdAt,
          matchMethod,
          matchConfidence,
        }],
      });
      touched.add(clusterId);
      processedPostIds.add(post.id);
    }

    await options.repository.upsertClusterSources([...pendingSources.values()]);
    const candidatesUpserted = await options.repository.calculateCandidates(runAt);
    return {
      runId,
      status: "completed",
      clustersProcessed: touched.size,
      candidatesUpserted,
    };
  } finally {
    clearIntervalImpl(heartbeat);
    try {
      await options.repository.releaseRun(runId);
    } catch {
      // Release is best effort; the lease expires and a later run can take over.
    }
  }
}

export async function loadEligibleAccounts(
  repository: IntelligenceRepository,
  runAt: Date | string,
): Promise<EligibleAccountSnapshot> {
  return repository.loadEligibleAccounts(runAt);
}

export async function upsertMembership(
  repository: IntelligenceRepository,
  input: Parameters<IntelligenceRepository["upsertMembership"]>[0],
): Promise<void> {
  await repository.upsertMembership(input);
}

export async function calculateCandidates(
  repository: IntelligenceRepository,
  runAt: Date | string,
): Promise<number> {
  return repository.calculateCandidates(runAt);
}

export function runAtIso(runAt: Date | string): string {
  return iso(runAt);
}
