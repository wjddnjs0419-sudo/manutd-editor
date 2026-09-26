import type {
  BoundaryInvoker,
  EditorialJob,
  EditorialJobQueue,
  EditorialJobType,
  OrchestrationBatchSummary,
} from "./types.ts";

const NEXT_STAGE: Partial<Record<EditorialJobType, EditorialJobType>> = {
  COLLECT_INSTAGRAM: "RUN_INTELLIGENCE",
  RUN_INTELLIGENCE: "GENERATE_PRIORITY",
  GENERATE_PRIORITY: "SYNC_NOTION",
  SYNC_NOTION: "POLL_SELECTED",
  POLL_SELECTED: "DISPATCH_ALERTS",
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

function downstreamFor(job: EditorialJob, result: { status: number; body?: unknown }): EditorialJobType | null {
  const next = NEXT_STAGE[job.job_type] ?? null;
  if (!next) return null;
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
      const result = await options.invoker.invoke(job.job_type, job.payload);
      if (result.status < 200 || result.status >= 300) throw httpFailure(job.job_type, result.status);

      const next = downstreamFor(job, result);
      let downstreamEnqueued = 0;
      if (next) {
        await options.queue.enqueue(
          next,
          downstreamPayload(job, next),
          `${chainKey(job)}:${next}`,
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

