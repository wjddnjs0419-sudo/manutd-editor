import type { StoryClusterEvaluation } from "./ai_classifier.ts";

export type EvaluationRepositoryErrorCode =
  | "DATABASE_CONFIGURATION_ERROR"
  | "DATABASE_NETWORK_ERROR"
  | "DATABASE_HTTP_ERROR";

export class EvaluationRepositoryError extends Error {
  constructor(
    readonly code: EvaluationRepositoryErrorCode,
    readonly status: number | null,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = "EvaluationRepositoryError";
  }
}

export interface EvaluationRepositoryDeps {
  readonly supabaseUrl: string;
  readonly serviceRoleKey?: string;
  readonly secretKey?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface EvaluationRepository {
  saveEvaluation(evaluation: StoryClusterEvaluation): Promise<void>;
}

const DECISIONS = new Set([
  "SAME_STORY",
  "DIFFERENT_STORY",
  "MANUAL_REVIEW",
  "ERROR",
]);
const MAX_REASON_LENGTH = 1_000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEvaluation(value: StoryClusterEvaluation): boolean {
  return object(value) &&
    typeof value.rawPostId === "string" && value.rawPostId.trim() !== "" &&
    typeof value.candidateClusterId === "string" &&
    value.candidateClusterId.trim() !== "" &&
    (value.deterministicScore === null ||
      typeof value.deterministicScore === "number" &&
        Number.isFinite(value.deterministicScore)) &&
    DECISIONS.has(value.decision) &&
    (value.sameStory === null || typeof value.sameStory === "boolean") &&
    (value.confidence === null ||
      typeof value.confidence === "number" &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0 && value.confidence <= 1) &&
    (value.reason === null ||
      typeof value.reason === "string" &&
        value.reason.length <= MAX_REASON_LENGTH) &&
    typeof value.model === "string" && value.model.trim() !== "" &&
    typeof value.promptVersion === "string" &&
    value.promptVersion.trim() !== "" &&
    typeof value.dictionaryVersion === "string" &&
    value.dictionaryVersion.trim() !== "" &&
    typeof value.classifierVersion === "string" &&
    value.classifierVersion.trim() !== "" &&
    typeof value.inputHash === "string" && value.inputHash.trim() !== "" &&
    object(value.inputSnapshot) &&
    (value.result === null || object(value.result));
}

function row(evaluation: StoryClusterEvaluation): Record<string, unknown> {
  return {
    raw_post_id: evaluation.rawPostId,
    candidate_cluster_id: evaluation.candidateClusterId,
    deterministic_score: evaluation.deterministicScore,
    decision: evaluation.decision,
    same_story: evaluation.sameStory,
    confidence: evaluation.confidence,
    reason: evaluation.reason,
    model: evaluation.model,
    prompt_version: evaluation.promptVersion,
    dictionary_version: evaluation.dictionaryVersion,
    classifier_version: evaluation.classifierVersion,
    input_hash: evaluation.inputHash,
    input_snapshot: evaluation.inputSnapshot,
    result: evaluation.result,
    ...(evaluation.evaluatedAt ? { evaluated_at: evaluation.evaluatedAt } : {}),
  };
}

export function createEvaluationRepository(
  deps: EvaluationRepositoryDeps,
): EvaluationRepository {
  const serviceRoleKey = deps.serviceRoleKey ?? deps.secretKey;
  if (
    deps.supabaseUrl.trim() === "" || !serviceRoleKey ||
    serviceRoleKey.trim() === ""
  ) {
    throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
  }

  const baseUrl = deps.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const savedKeys = new Set<string>();

  async function saveEvaluation(
    evaluation: StoryClusterEvaluation,
  ): Promise<void> {
    if (!validEvaluation(evaluation)) {
      throw new EvaluationRepositoryError("DATABASE_CONFIGURATION_ERROR", null);
    }

    const key = [
      evaluation.rawPostId,
      evaluation.candidateClusterId,
      evaluation.classifierVersion,
      evaluation.inputHash,
    ].join("\u0000");
    if (savedKeys.has(key)) return;
    savedKeys.add(key);

    try {
      const response = await fetchImpl(
        `${baseUrl}/rest/v1/story_cluster_evaluations?on_conflict=raw_post_id%2Ccandidate_cluster_id%2Cclassifier_version%2Cinput_hash`,
        {
          method: "POST",
          headers: {
            apikey: serviceRoleKey,
            "content-type": "application/json",
            "accept-profile": "app_private",
            "content-profile": "app_private",
            prefer: "resolution=ignore-duplicates,return=minimal",
          },
          body: JSON.stringify(row(evaluation)),
        },
      );
      if (!response.ok) {
        throw new EvaluationRepositoryError(
          "DATABASE_HTTP_ERROR",
          response.status,
        );
      }
    } catch (error) {
      savedKeys.delete(key);
      if (error instanceof EvaluationRepositoryError) throw error;
      throw new EvaluationRepositoryError("DATABASE_NETWORK_ERROR", null);
    }
  }

  return { saveEvaluation };
}

export async function saveEvaluation(
  evaluation: StoryClusterEvaluation,
  deps: EvaluationRepositoryDeps,
): Promise<void> {
  await createEvaluationRepository(deps).saveEvaluation(evaluation);
}
