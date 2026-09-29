import type { EditorialJobQueue } from "../orchestration-worker/types.ts";

export interface ManualDiscoveryResult {
  readonly status: "QUEUED";
  readonly run_id: string;
}

export interface ManualDiscoveryPayload {
  readonly mode: "GENERAL";
  readonly search_profile: "MANUAL";
  readonly max_queries: 24;
}

export async function enqueueManualDiscovery(
  queue: EditorialJobQueue,
  threadId: string,
  requestKey: string,
  availableAt: Date,
  payload: ManualDiscoveryPayload,
): Promise<ManualDiscoveryResult> {
  const dedupeKey = `telegram-discovery:${threadId}:${requestKey}`;
  const jobId = await queue.enqueue(
    "DISCOVER_TRENDS",
    {
      chain_key: dedupeKey,
      ...payload,
      trigger: "TELEGRAM_MANUAL",
      thread_id: threadId,
    },
    dedupeKey,
    3,
    availableAt,
  );
  return { status: "QUEUED", run_id: jobId };
}
