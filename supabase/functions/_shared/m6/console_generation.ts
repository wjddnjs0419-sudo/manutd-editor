export interface CanonicalGenerationInvocation {
  readonly candidate_id: string;
  readonly trigger_type: "MANUAL";
}

export interface CanonicalGenerationResult {
  readonly status: "READY" | "NOOP";
  readonly creative_brief_id: string;
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
): Promise<Record<string, unknown>> {
  if (!candidateId.trim()) throw new Error("CANDIDATE_NOT_FOUND");
  const value = await dependencies.invoke({ candidate_id: candidateId, trigger_type: "MANUAL" });
  if (!object(value) || (value.status !== "READY" && value.status !== "NOOP") || typeof value.creative_brief_id !== "string") {
    throw new Error("CREATIVE_GENERATION_FAILED");
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
