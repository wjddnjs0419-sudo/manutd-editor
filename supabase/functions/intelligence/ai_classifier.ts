import { canonicalInputHash } from "./features.ts";
import type { ClusterSignature, StoryFeatures } from "./types.ts";

export type ClassifierDecision =
  | "SAME_STORY"
  | "DIFFERENT_STORY"
  | "MANUAL_REVIEW"
  | "ERROR";

export type DeterministicDecision =
  | "AUTO_MERGE"
  | "SEPARATE"
  | "AMBIGUOUS";

export interface ClassifierInput {
  readonly rawPostId: string;
  readonly candidateClusterId: string;
  readonly deterministicScore: number;
  readonly deterministicDecision:
    | DeterministicDecision
    | { readonly decision: DeterministicDecision };
  readonly rawPost: StoryFeatures;
  readonly aggregateSignature: ClusterSignature;
}

export interface NormalizedClassifierSnapshot {
  readonly raw_post: StoryFeatures;
  readonly aggregate_signature: ClusterSignature;
}

export interface ClassifierResult {
  readonly decision: ClassifierDecision;
  readonly sameStory: boolean | null;
  readonly confidence: number | null;
  readonly reason: string;
  readonly model: string;
  readonly promptVersion: string;
  readonly dictionaryVersion: string;
  readonly classifierVersion: string;
  readonly inputHash: string;
  readonly inputSnapshot: NormalizedClassifierSnapshot;
  readonly result: {
    readonly same_story: boolean | null;
    readonly confidence: number | null;
    readonly reason: string;
  };
}

export interface StoryClusterEvaluation {
  readonly rawPostId: string;
  readonly candidateClusterId: string;
  readonly deterministicScore: number | null;
  readonly decision: ClassifierDecision;
  readonly sameStory: boolean | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly model: string;
  readonly promptVersion: string;
  readonly dictionaryVersion: string;
  readonly classifierVersion: string;
  readonly inputHash: string;
  readonly inputSnapshot: NormalizedClassifierSnapshot;
  readonly result: {
    readonly same_story: boolean | null;
    readonly confidence: number | null;
    readonly reason: string | null;
  } | null;
  readonly evaluatedAt?: string;
}

export interface StoryClassifierDeps {
  readonly aiEnabled?: boolean;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly dictionaryVersion?: string;
  readonly apiKey?: string;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly config?: {
    readonly aiEnabled: boolean;
    readonly aiModel: string;
    readonly aiPromptVersion: string;
    readonly dictionaryVersion: string;
  };
  readonly saveEvaluation?: (
    evaluation: StoryClusterEvaluation,
  ) => Promise<void>;
}

export interface StoryClassifier {
  classifyAmbiguousPair(input: ClassifierInput): Promise<ClassifierResult>;
}

const DEFAULT_MODEL = "gpt-5-mini";
const DEFAULT_PROMPT_VERSION = "cluster-v1";
const DEFAULT_DICTIONARY_VERSION = "entity-v1";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REASON_LENGTH = 1_000;

function invalidInput(): never {
  throw new Error("invalid classifier input");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deterministicDecision(
  value: ClassifierInput["deterministicDecision"],
): DeterministicDecision {
  return typeof value === "string" ? value : value.decision;
}

function validateInput(input: ClassifierInput): void {
  if (
    !object(input) ||
    !nonEmpty(input.rawPostId) ||
    !nonEmpty(input.candidateClusterId) ||
    !Number.isFinite(input.deterministicScore) ||
    !["AUTO_MERGE", "SEPARATE", "AMBIGUOUS"].includes(
      deterministicDecision(input.deterministicDecision),
    ) ||
    !object(input.rawPost) ||
    !object(input.aggregateSignature)
  ) {
    invalidInput();
  }
}

function classifierSnapshot(
  input: ClassifierInput,
): NormalizedClassifierSnapshot {
  const rawPost = input.rawPost;
  const signature = input.aggregateSignature;

  return {
    raw_post: {
      entities: [...rawPost.entities],
      events: [...rawPost.events],
      sources: [...rawPost.sources],
      numbers: [...rawPost.numbers],
      dates: [...rawPost.dates],
      normalizedCaption: rawPost.normalizedCaption,
      tokens: [...rawPost.tokens],
      publishedAt: rawPost.publishedAt,
      dictionaryVersion: rawPost.dictionaryVersion,
    },
    aggregate_signature: {
      entities: [...signature.entities],
      events: [...signature.events],
      sources: [...signature.sources],
      numbers: [...signature.numbers],
      firstPublishedAt: signature.firstPublishedAt,
      lastPublishedAt: signature.lastPublishedAt,
      representativePostIds: [...signature.representativePostIds],
      dictionaryVersion: signature.dictionaryVersion,
    },
  };
}

function version(
  model: string,
  promptVersion: string,
  dictionaryVersion: string,
): string {
  return `${model}:${promptVersion}:${dictionaryVersion}`;
}

export function classifierVersion(
  model: string,
  promptVersion: string,
  dictionaryVersion: string,
): string {
  if (![model, promptVersion, dictionaryVersion].every(nonEmpty)) {
    throw new Error("invalid classifier version");
  }
  return version(model, promptVersion, dictionaryVersion);
}

function makeResult(
  metadata: ClassifierMetadata,
  snapshot: NormalizedClassifierSnapshot,
  inputHash: string,
  decision: ClassifierDecision,
  sameStory: boolean | null,
  confidence: number | null,
  reason: string,
): ClassifierResult {
  return {
    decision,
    sameStory,
    confidence,
    reason,
    model: metadata.model,
    promptVersion: metadata.promptVersion,
    dictionaryVersion: metadata.dictionaryVersion,
    classifierVersion: metadata.classifierVersion,
    inputHash,
    inputSnapshot: snapshot,
    result: { same_story: sameStory, confidence, reason },
  };
}

interface ClassifierMetadata {
  readonly aiEnabled: boolean;
  readonly model: string;
  readonly promptVersion: string;
  readonly dictionaryVersion: string;
  readonly classifierVersion: string;
}

function metadata(deps: StoryClassifierDeps): ClassifierMetadata {
  const config = deps.config;
  const model = deps.model ?? config?.aiModel ?? DEFAULT_MODEL;
  const promptVersion = deps.promptVersion ?? config?.aiPromptVersion ??
    DEFAULT_PROMPT_VERSION;
  const dictionaryVersion = deps.dictionaryVersion ??
    config?.dictionaryVersion ??
    DEFAULT_DICTIONARY_VERSION;
  return {
    aiEnabled: deps.aiEnabled ?? config?.aiEnabled ?? false,
    model,
    promptVersion,
    dictionaryVersion,
    classifierVersion: classifierVersion(
      model,
      promptVersion,
      dictionaryVersion,
    ),
  };
}

function evaluationFromResult(
  input: ClassifierInput,
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

async function persist(
  deps: StoryClassifierDeps,
  input: ClassifierInput,
  result: ClassifierResult,
): Promise<ClassifierResult> {
  if (!deps.saveEvaluation) return result;
  try {
    await deps.saveEvaluation(evaluationFromResult(input, result));
    return result;
  } catch {
    return {
      ...result,
      decision: "ERROR",
      sameStory: null,
      confidence: null,
      reason: "AUDIT_PERSISTENCE_FAILED",
      result: {
        same_story: null,
        confidence: null,
        reason: "AUDIT_PERSISTENCE_FAILED",
      },
    };
  }
}

function upstreamResult(
  metadataValue: ClassifierMetadata,
  snapshot: NormalizedClassifierSnapshot,
  inputHash: string,
  reason: string,
): ClassifierResult {
  return makeResult(
    metadataValue,
    snapshot,
    inputHash,
    "MANUAL_REVIEW",
    null,
    null,
    reason,
  );
}

function responseContent(value: unknown): unknown {
  if (!object(value)) return null;
  const choices = value.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !object(choices[0])) {
    return value;
  }
  const message = choices[0].message;
  if (!object(message)) return null;
  const content = message.content;
  if (typeof content === "string") {
    try {
      return JSON.parse(content);
    } catch {
      return null;
    }
  }
  return content;
}

function parseClassifierResponse(value: unknown): {
  sameStory: boolean;
  confidence: number;
  reason: string;
} | null {
  const candidate = responseContent(value);
  if (
    !object(candidate) ||
    typeof candidate.same_story !== "boolean" ||
    typeof candidate.confidence !== "number" ||
    !Number.isFinite(candidate.confidence) ||
    candidate.confidence < 0 ||
    candidate.confidence > 1 ||
    typeof candidate.reason !== "string" ||
    candidate.reason.trim().length === 0 ||
    candidate.reason.length > MAX_REASON_LENGTH
  ) {
    return null;
  }
  return {
    sameStory: candidate.same_story,
    confidence: candidate.confidence,
    reason: candidate.reason,
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function requestBody(
  metadataValue: ClassifierMetadata,
  snapshot: NormalizedClassifierSnapshot,
): Record<string, unknown> {
  return {
    model: metadataValue.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Classify whether the normalized post and aggregate cluster describe the same story. Return only same_story, confidence, and reason as JSON.",
      },
      {
        role: "user",
        content: JSON.stringify({
          raw_post: snapshot.raw_post,
          aggregate_cluster_signature: snapshot.aggregate_signature,
        }),
      },
    ],
  };
}

export function createStoryClassifier(
  deps: StoryClassifierDeps,
): StoryClassifier {
  const metadataValue = metadata(deps);
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function classifyAmbiguousPair(
    input: ClassifierInput,
  ): Promise<ClassifierResult> {
    validateInput(input);
    const snapshot = classifierSnapshot(input);
    const inputHash = await canonicalInputHash({
      raw_post_id: input.rawPostId,
      candidate_cluster_id: input.candidateClusterId,
      deterministic_score: input.deterministicScore,
      raw_post: snapshot.raw_post,
      aggregate_signature: snapshot.aggregate_signature,
    });
    const deterministic = deterministicDecision(input.deterministicDecision);

    if (deterministic === "AUTO_MERGE") {
      return persist(
        deps,
        input,
        makeResult(
          metadataValue,
          snapshot,
          inputHash,
          "SAME_STORY",
          true,
          1,
          "DETERMINISTIC_HIGH",
        ),
      );
    }
    if (deterministic === "SEPARATE") {
      return persist(
        deps,
        input,
        makeResult(
          metadataValue,
          snapshot,
          inputHash,
          "DIFFERENT_STORY",
          false,
          1,
          "DETERMINISTIC_LOW",
        ),
      );
    }
    if (!metadataValue.aiEnabled) {
      return persist(
        deps,
        input,
        upstreamResult(
          metadataValue,
          snapshot,
          inputHash,
          "AI_DISABLED",
        ),
      );
    }

    const apiKey = deps.apiKey;
    if (!nonEmpty(apiKey)) {
      return persist(
        deps,
        input,
        upstreamResult(
          metadataValue,
          snapshot,
          inputHash,
          "AI_NOT_CONFIGURED",
        ),
      );
    }

    const controller = new AbortController();
    let timeoutId: number | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("classifier timeout")),
        timeoutMs,
      );
    });
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(deps.endpoint ?? DEFAULT_ENDPOINT, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody(metadataValue, snapshot)),
          signal: controller.signal,
        }),
        timeout,
      ]);
    } catch (error) {
      const reason =
        error instanceof Error && error.message === "classifier timeout"
          ? "UPSTREAM_TIMEOUT"
          : "UPSTREAM_UNAVAILABLE";
      controller.abort();
      return persist(
        deps,
        input,
        upstreamResult(metadataValue, snapshot, inputHash, reason),
      );
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }

    if (!response.ok || response.status === 429 || response.status >= 500) {
      return persist(
        deps,
        input,
        upstreamResult(
          metadataValue,
          snapshot,
          inputHash,
          "UPSTREAM_UNAVAILABLE",
        ),
      );
    }

    const parsed = parseClassifierResponse(await readJson(response));
    if (!parsed) {
      return persist(
        deps,
        input,
        upstreamResult(
          metadataValue,
          snapshot,
          inputHash,
          "INVALID_RESPONSE",
        ),
      );
    }

    const accepted = parsed.confidence >= 0.90;
    return persist(
      deps,
      input,
      makeResult(
        metadataValue,
        snapshot,
        inputHash,
        accepted
          ? parsed.sameStory ? "SAME_STORY" : "DIFFERENT_STORY"
          : "MANUAL_REVIEW",
        parsed.sameStory,
        parsed.confidence,
        accepted ? parsed.reason : "LOW_CONFIDENCE",
      ),
    );
  }

  return { classifyAmbiguousPair };
}

export function classifyAmbiguousPair(
  input: ClassifierInput,
  deps: StoryClassifierDeps,
): Promise<ClassifierResult> {
  return createStoryClassifier(deps).classifyAmbiguousPair(input);
}
