import type {
  EditorialJob,
  EditorialJobQueue,
  EditorialJobType,
} from "./types.ts";

interface EditorialJobQueueOptions {
  readonly supabaseUrl: string;
  readonly serviceKey: string;
  readonly request?: typeof fetch;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function jobFromRow(value: unknown): EditorialJob {
  const row = object(value);
  return {
    id: string(row.id),
    job_type: string(row.job_type) as EditorialJobType,
    payload: object(row.payload),
    dedupe_key: string(row.dedupe_key),
    status: string(row.status) as EditorialJob["status"],
    attempt_count: number(row.attempt_count),
    max_attempts: number(row.max_attempts),
    available_at: string(row.available_at),
    locked_at: nullableString(row.locked_at),
    locked_by: nullableString(row.locked_by),
    last_error_category: nullableString(row.last_error_category),
    last_error_message: nullableString(row.last_error_message),
    created_at: string(row.created_at),
    started_at: nullableString(row.started_at),
    finished_at: nullableString(row.finished_at),
    updated_at: string(row.updated_at),
  };
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("QUEUE_RESPONSE_INVALID");
  }
}

export function createEditorialJobQueue(options: EditorialJobQueueOptions): EditorialJobQueue {
  const fetchImpl = options.request ?? fetch;
  const base = `${options.supabaseUrl.replace(/\/$/u, "")}/rest/v1`;

  async function rpc(name: string, body: Record<string, unknown>): Promise<unknown> {
    const headers = new Headers({
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
      "content-type": "application/json",
    });
    const response = await fetchImpl(`${base}/rpc/${name}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("QUEUE_REQUEST_FAILED");
    return await responseBody(response);
  }

  return {
    async enqueue(jobType, payload, dedupeKey, maxAttempts, availableAt) {
      const value = await rpc("enqueue_editorial_job", {
        p_job_type: jobType,
        p_payload: payload,
        p_dedupe_key: dedupeKey,
        p_max_attempts: maxAttempts,
        p_available_at: availableAt.toISOString(),
      });
      if (typeof value === "string") return value;
      const first = array(value)[0];
      if (typeof first === "string") return first;
      if (typeof first === "object" && first !== null) {
        const row = object(first);
        if (typeof row.enqueue_editorial_job === "string") return row.enqueue_editorial_job;
      }
      throw new Error("QUEUE_ENQUEUE_RESPONSE_INVALID");
    },

    async claim(workerId, limit, now, leaseSeconds) {
      const value = await rpc("claim_editorial_jobs", {
        p_worker_id: workerId,
        p_limit: limit,
        p_now: now.toISOString(),
        p_lease_seconds: leaseSeconds,
      });
      return array(value).map(jobFromRow);
    },

    async complete(jobId, workerId, finishedAt) {
      const value = await rpc("complete_editorial_job", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_finished_at: finishedAt.toISOString(),
      });
      if (typeof value === "boolean") return value;
      if (typeof value === "string") return value === "true";
      const first = array(value)[0];
      return first === true || first === "true";
    },

    async fail(jobId, workerId, category, message, failedAt) {
      const value = await rpc("fail_editorial_job", {
        p_job_id: jobId,
        p_worker_id: workerId,
        p_error_category: category,
        p_error_message: message,
        p_failed_at: failedAt.toISOString(),
      });
      const first = array(value)[0] ?? value;
      const job = jobFromRow(first);
      if (!job.id) throw new Error("QUEUE_FAILURE_RESPONSE_INVALID");
      return job;
    },
  };
}

