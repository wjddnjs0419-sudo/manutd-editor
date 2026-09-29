import type {
  BoundaryInvoker,
  EditorialJob,
  EditorialJobQueue,
  EditorialJobType,
  OrchestrationBatchSummary,
} from "./types.ts";
import { GROUNDING_DEFAULT_LIMIT, GROUNDING_MAX_SCOPE, isGroundingCursor, isGroundingLimit, isGroundingStoryId } from "../ground-claims/contract.ts";

const NEXT_STAGE: Partial<Record<EditorialJobType, EditorialJobType>> = {
  COLLECT_INSTAGRAM: "ANALYZE_CONTENT",
  ANALYZE_CONTENT: "RUN_INTELLIGENCE",
  RUN_INTELLIGENCE: "DISCOVER_SOURCES",
  DISCOVER_SOURCES: "DISCOVER_TRENDS",
  DISCOVER_TRENDS: "PROMOTE_DISCOVERY",
  PROMOTE_DISCOVERY: "GROUND_CLAIMS",
  GROUND_CLAIMS: "RANK_EDITORIAL",
  RANK_EDITORIAL: "GENERATE_PRIORITY",
  GENERATE_PRIORITY: "SYNC_NOTION",
  SYNC_NOTION: "POLL_SELECTED",
  POLL_SELECTED: "DISPATCH_ALERTS",
  FIXTURE_SYNC: "DISPATCH_ALERTS",
};

export interface OrchestrationWorkerOptions {
  readonly queue: EditorialJobQueue;
  readonly invoker: BoundaryInvoker;
  readonly workerId: string;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly now?: () => Date;
  readonly log?: (entry: Record<string, unknown>) => void;
}

interface SafeWorkerFailure {
  readonly category: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chainKey(job: EditorialJob): string {
  const candidate = job.payload.chain_key;
  return typeof candidate === "string" && candidate.trim() !== ""
    ? candidate
    : job.dedupe_key;
}

function statusOf(body: unknown): string | null {
  if (!isRecord(body) || typeof body.status !== "string") return null;
  return body.status;
}

function booleanField(body: unknown, camel: string, snake: string): boolean {
  if (!isRecord(body)) return false;
  return body[camel] === true || body[snake] === true;
}

function stringField(body: unknown, camel: string, snake: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[camel] ?? body[snake];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function storyIds(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GROUNDING_MAX_SCOPE || value.some((item) => !isGroundingStoryId(item)) || new Set(value).size !== value.length) {
    throw { category: "GROUNDING_PAYLOAD_INVALID", message: `${field} is invalid` } satisfies SafeWorkerFailure;
  }
  return [...value] as string[];
}

function affectedStoryIds(body: unknown): string[] {
  if (!isRecord(body)) return [];
  const value = body.affectedStoryIds ?? body.affected_story_ids;
  return storyIds(value, "affected_story_ids");
}

function asOfFor(job: EditorialJob, fallback: Date | string): string {
  return typeof job.payload.as_of === "string" && job.payload.as_of.trim() !== ""
    ? job.payload.as_of
    : typeof fallback === "string" ? fallback : fallback.toISOString();
}

function groundLimit(payload: Record<string, unknown>): number {
  if (payload.limit === undefined) return GROUNDING_DEFAULT_LIMIT;
  if (!isGroundingLimit(payload.limit)) throw { category: "GROUNDING_PAYLOAD_INVALID", message: "limit is invalid" } satisfies SafeWorkerFailure;
  return payload.limit;
}

function validateGroundingJob(job: EditorialJob): void {
  if (job.job_type !== "GROUND_CLAIMS") return;
  storyIds(job.payload.story_cluster_ids, "story_cluster_ids");
  groundLimit(job.payload);
  if (job.payload.cursor !== undefined && job.payload.cursor !== null && !isGroundingCursor(job.payload.cursor)) {
    throw { category: "GROUNDING_PAYLOAD_INVALID", message: "cursor is invalid" } satisfies SafeWorkerFailure;
  }
}

function downstreamFor(job: EditorialJob, result: { status: number; body?: unknown }): EditorialJobType | null {
  const next = NEXT_STAGE[job.job_type] ?? null;
  if (!next) return null;
  if (job.job_type === "PROMOTE_DISCOVERY" || job.job_type === "GROUND_CLAIMS") return null;
  if (job.job_type === "RUN_INTELLIGENCE" && (result.status === 202 || statusOf(result.body) === "already_running")) {
    return null;
  }
  return next;
}

function failureFor(jobType: EditorialJobType, error: unknown): SafeWorkerFailure {
  if (error && typeof error === "object" && "category" in error && "message" in error) {
    const candidate = error as { category?: unknown; message?: unknown };
    if (typeof candidate.category === "string" && typeof candidate.message === "string") {
      return { category: candidate.category, message: candidate.message };
    }
  }
  return { category: "WORKER_FAILURE", message: `${jobType} invocation failed` };
}

function httpFailure(jobType: EditorialJobType, status: number): SafeWorkerFailure {
  const className = `${Math.floor(status / 100)}XX`;
  return {
    category: `DOWNSTREAM_HTTP_${className}`,
    message: `${jobType} returned HTTP ${status}`,
  };
}

function downstreamPayload(job: EditorialJob, next: EditorialJobType): Record<string, unknown> {
  return {
    ...job.payload,
    chain_key: chainKey(job),
    parent_job_id: job.id,
    stage: next,
  };
}

interface DownstreamTransition {
  readonly jobType: EditorialJobType;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string;
}

function promotionTransition(job: EditorialJob, body: unknown, completedAt: Date): DownstreamTransition | null {
  const savedIds = storyIds(job.payload.grounding_story_cluster_ids, "grounding_story_cluster_ids");
  const ids = savedIds.length > 0 ? savedIds : affectedStoryIds(body);
  if (ids.length === 0) return null;
  if (ids.length > 100) throw { category: "PROMOTE_DISCOVERY_INVALID_RESULT", message: "Promotion grounding scope exceeds 100 stories" } satisfies SafeWorkerFailure;
  const root = chainKey(job);
  return {
    jobType: "GROUND_CLAIMS",
    payload: {
      chain_key: root,
      parent_job_id: job.id,
      stage: "GROUND_CLAIMS",
      as_of: savedIds.length > 0 && typeof job.payload.grounding_as_of === "string"
        ? asOfFor(job, job.payload.grounding_as_of)
        : asOfFor(job, completedAt),
      story_cluster_ids: ids,
      limit: savedIds.length > 0 ? groundLimit({ limit: job.payload.grounding_limit }) : GROUNDING_DEFAULT_LIMIT,
      cursor: null,
    },
    dedupeKey: `${root}:GROUND_CLAIMS:initial`,
  };
}

function groundingTransition(job: EditorialJob, body: unknown): DownstreamTransition {
  const status = statusOf(body);
  const hasMore = booleanField(body, "hasMore", "has_more");
  const root = chainKey(job);
  if (status === "PARTIAL" || hasMore) {
    const cursor = stringField(body, "nextCursor", "next_cursor");
    if (!cursor || !isGroundingCursor(cursor)) throw { category: "GROUND_CLAIMS_INVALID_RESULT", message: "GROUND_CLAIMS continuation cursor is invalid" } satisfies SafeWorkerFailure;
    const payload: Record<string, unknown> = {
      chain_key: root,
      parent_job_id: job.id,
      stage: "GROUND_CLAIMS",
      as_of: typeof job.payload.as_of === "string" ? job.payload.as_of : undefined,
      story_cluster_ids: job.payload.story_cluster_ids === undefined ? undefined : storyIds(job.payload.story_cluster_ids, "story_cluster_ids"),
      limit: groundLimit(job.payload),
      cursor,
    };
    Object.keys(payload).forEach((key) => payload[key] === undefined && delete payload[key]);
    return { jobType: "GROUND_CLAIMS", payload, dedupeKey: `${root}:GROUND_CLAIMS:${cursor}` };
  }
  if (status !== "COMPLETED" || hasMore) throw { category: "GROUND_CLAIMS_INVALID_RESULT", message: "GROUND_CLAIMS did not complete" } satisfies SafeWorkerFailure;
  const next = NEXT_STAGE.GROUND_CLAIMS!;
  return { jobType: next, payload: downstreamPayload(job, next), dedupeKey: `${root}:${next}` };
}

export function createOrchestrationWorker(options: OrchestrationWorkerOptions): {
  processBatch(): Promise<OrchestrationBatchSummary>;
} {
  if (!options.workerId.trim()) throw new Error("Worker id is required");
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 5;
  const leaseSeconds = options.leaseSeconds ?? 300;
  const log = options.log ?? (() => undefined);

  async function processJob(job: EditorialJob, claimedAt: Date): Promise<{ succeeded: boolean; downstreamEnqueued: number }> {
    try {
      validateGroundingJob(job);
      // Once the handoff is durable, retries only replay it. Promoting again could
      // assign new observations to a scope whose downstream job already exists.
      const result = job.job_type === "PROMOTE_DISCOVERY" && storyIds(job.payload.grounding_story_cluster_ids, "grounding_story_cluster_ids").length > 0
        ? { status: 200, body: { affectedStoryIds: [] } }
        : await options.invoker.invoke(
          job.job_type,
          job.job_type === "PROMOTE_DISCOVERY" ? { ...job.payload, promotion_job_id: job.id } : job.payload,
        );
      if (result.status < 200 || result.status >= 300) throw httpFailure(job.job_type, result.status);

      const transition = job.job_type === "PROMOTE_DISCOVERY"
        ? promotionTransition(job, result.body, now())
        : job.job_type === "GROUND_CLAIMS"
        ? groundingTransition(job, result.body)
        : (() => {
          const next = downstreamFor(job, result);
          return next ? { jobType: next, payload: downstreamPayload(job, next), dedupeKey: `${chainKey(job)}:${next}` } : null;
        })();
      let downstreamEnqueued = 0;
      if (transition) {
        if (job.job_type === "PROMOTE_DISCOVERY" && options.queue.updatePayload) {
          await options.queue.updatePayload(job.id, {
            grounding_story_cluster_ids: transition.payload.story_cluster_ids,
            grounding_as_of: transition.payload.as_of,
            grounding_limit: transition.payload.limit,
          }, options.workerId);
        }
        await options.queue.enqueue(
          transition.jobType,
          transition.payload,
          transition.dedupeKey,
          job.max_attempts,
          claimedAt,
        );
        downstreamEnqueued = 1;
      }

      if (!await options.queue.complete(job.id, options.workerId, now())) {
        throw { category: "QUEUE_COMPLETION_REJECTED", message: `${job.job_type} completion was rejected` } satisfies SafeWorkerFailure;
      }
      return { succeeded: true, downstreamEnqueued };
    } catch (error) {
      const failure = failureFor(job.job_type, error);
      try {
        await options.queue.fail(job.id, options.workerId, failure.category, failure.message, now());
      } catch {
        log({ event: "editorial_job_failure_persistence_failed", jobType: job.job_type, category: "QUEUE_FAILURE" });
      }
      log({ event: "editorial_job_failed", jobType: job.job_type, category: failure.category });
      return { succeeded: false, downstreamEnqueued: 0 };
    }
  }

  return {
    async processBatch(): Promise<OrchestrationBatchSummary> {
      const claimedAt = now();
      const jobs = await options.queue.claim(options.workerId, batchSize, claimedAt, leaseSeconds);
      const results = await Promise.all(jobs.map((job) => processJob(job, claimedAt)));
      return {
        claimed: jobs.length,
        succeeded: results.filter((result) => result.succeeded).length,
        failed: results.filter((result) => !result.succeeded).length,
        downstream_enqueued: results.reduce((total, result) => total + result.downstreamEnqueued, 0),
      };
    },
  };
}
