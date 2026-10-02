export interface CanonicalGenerationInvocation {
  readonly candidate_id: string;
  readonly trigger_type: "MANUAL";
  readonly trust_state?: "VERIFIED" | "REPORTED" | "DISCOVERY";
  readonly slide_count?: number;
}

export interface CanonicalGenerationResult {
  readonly status: "READY" | "NOOP";
  readonly creative_brief_id: string;
}

function canonicalGenerationFailure(value: Record<string, unknown>): string {
  const candidateCodes = Array.isArray(value.error_codes) ? value.error_codes : [];
  const errorCode = candidateCodes.find((candidate): candidate is string => typeof candidate === "string" && /^[A-Z0-9_]{1,64}$/u.test(candidate));
  if (errorCode && (errorCode === "PROVIDER_TIMEOUT" || errorCode === "PROVIDER_MALFORMED_RESPONSE" || errorCode === "PROVIDER_REQUEST_FAILED" || errorCode === "PROVIDER_QUOTA_EXCEEDED" || errorCode === "PROVIDER_RATE_LIMIT" || /^PROVIDER_HTTP_[45][0-9]{2}$/u.test(errorCode))) return errorCode;
  if (value.status === "CLASSIFICATION_UNCERTAIN" || value.status === "BLOCKED_EVIDENCE" || value.status === "FAILED_VALIDATION" || value.status === "FAILED_PROVIDER" || value.status === "NOT_ELIGIBLE") return value.status;
  return "CREATIVE_GENERATION_FAILED";
}

export interface CanonicalGenerationDependencies {
  invoke(input: CanonicalGenerationInvocation): Promise<unknown>;
  loadBrief(id: string): Promise<Record<string, unknown> | null>;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export async function invokeCanonicalCarousel(
  candidateId: string,
  dependencies: CanonicalGenerationDependencies,
  expectedStoryClusterId?: string,
  options: { trust_state?: "VERIFIED" | "REPORTED" | "DISCOVERY"; slide_count?: number } = {},
): Promise<Record<string, unknown>> {
  if (!candidateId.trim()) throw new Error("CANDIDATE_NOT_FOUND");
  const value = await dependencies.invoke({ candidate_id: candidateId, trigger_type: "MANUAL", ...options });
  if (!object(value)) throw new Error("CREATIVE_GENERATION_FAILED");
  if ((value.status !== "READY" && value.status !== "NOOP") || typeof value.creative_brief_id !== "string") {
    throw new Error(canonicalGenerationFailure(value));
  }
  const result = value as unknown as CanonicalGenerationResult;
  const brief = await dependencies.loadBrief(result.creative_brief_id);
  if (!brief) throw new Error("CREATIVE_BRIEF_NOT_FOUND");
  if (brief.candidate_id !== candidateId) throw new Error("CREATIVE_BRIEF_CANDIDATE_MISMATCH");
  if (expectedStoryClusterId) {
    const snapshot = object(brief.evidence_snapshot) ? brief.evidence_snapshot : null;
    const snapshotCandidate = snapshot && object(snapshot.candidate) ? snapshot.candidate : null;
    const snapshotStory = snapshot && object(snapshot.story) ? snapshot.story : null;
    const clusterIds = [snapshotCandidate?.story_cluster_id, snapshotStory?.id].filter((value): value is string => typeof value === "string");
    if (clusterIds.length === 0 || clusterIds.some((storyClusterId) => storyClusterId !== expectedStoryClusterId)) {
      throw new Error("CREATIVE_BRIEF_STORY_MISMATCH");
    }
  }
  return brief;
}
