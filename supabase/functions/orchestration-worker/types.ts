export const EDITORIAL_JOB_TYPES = [
  "COLLECT_INSTAGRAM",
  "RUN_INTELLIGENCE",
  "GENERATE_PRIORITY",
  "SYNC_NOTION",
  "PROJECT_NOTION",
  "POLL_SELECTED",
  "DISPATCH_ALERTS",
  "FIXTURE_SYNC",
  "MORNING_BRIEF",
] as const;

export type EditorialJobType = typeof EDITORIAL_JOB_TYPES[number];
export type EditorialJobStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "DEAD";

export interface EditorialJob {
  readonly id: string;
  readonly job_type: EditorialJobType;
  readonly payload: Record<string, unknown>;
  readonly dedupe_key: string;
  status: EditorialJobStatus;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly available_at: string;
  readonly locked_at: string | null;
  readonly locked_by: string | null;
  readonly last_error_category: string | null;
  readonly last_error_message: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly updated_at: string;
}

export interface BoundaryResult {
  readonly status: number;
  readonly body?: unknown;
}

export interface BoundaryInvoker {
  invoke(jobType: EditorialJobType, payload: Record<string, unknown>): Promise<BoundaryResult>;
}

export interface EditorialJobQueue {
  claim(workerId: string, limit: number, now: Date, leaseSeconds: number): Promise<readonly EditorialJob[]>;
  complete(jobId: string, workerId: string, finishedAt: Date): Promise<boolean>;
  fail(jobId: string, workerId: string, category: string, message: string, failedAt: Date): Promise<EditorialJob>;
  enqueue(jobType: EditorialJobType, payload: Record<string, unknown>, dedupeKey: string, maxAttempts: number, availableAt: Date): Promise<string>;
}

export interface OrchestrationBatchSummary {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly downstream_enqueued: number;
}
