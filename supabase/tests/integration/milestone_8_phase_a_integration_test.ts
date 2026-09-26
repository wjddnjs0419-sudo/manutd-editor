import assert from "node:assert/strict";

import { goldenAnalysisOutput } from "../../functions/tests/fixtures/m8_phase_a.ts";
import { runContentAnalysis, type AnalysisCandidate, type AnalysisRepository } from "../../functions/analyze-content/orchestrator.ts";
import { createOrchestrationWorker } from "../../functions/orchestration-worker/worker.ts";
import type {
  BoundaryInvoker,
  EditorialJob,
  EditorialJobQueue,
} from "../../functions/orchestration-worker/types.ts";

const now = new Date("2026-09-27T00:00:00.000Z");
const contract = { analysisVersion: "m8-a-v1", model: "test-model", promptVersion: "prompt-v1" };

function job(id: string, jobType: EditorialJob["job_type"], chainKey: string): EditorialJob {
  return {
    id,
    job_type: jobType,
    payload: { chain_key: chainKey },
    dedupe_key: `${chainKey}:${jobType}`,
    status: "PENDING",
    attempt_count: 1,
    max_attempts: 3,
    available_at: now.toISOString(),
    locked_at: null,
    locked_by: null,
    last_error_category: null,
    last_error_message: null,
    created_at: now.toISOString(),
    started_at: null,
    finished_at: null,
    updated_at: now.toISOString(),
  };
}

function queueWith(root: EditorialJob): EditorialJobQueue & { readonly jobs: EditorialJob[] } {
  const jobs = [root];
  let sequence = 1;
  return {
    jobs,
    async claim(workerId, limit, lockedAt) {
      return jobs.filter((entry) => entry.status === "PENDING").slice(0, limit).map((entry) => {
        entry.status = "RUNNING";
        Object.assign(entry, { locked_by: workerId, locked_at: lockedAt.toISOString() });
        return entry;
      });
    },
    async complete(jobId) {
      const entry = jobs.find((candidate) => candidate.id === jobId);
      if (!entry) return false;
      entry.status = "SUCCEEDED";
      return true;
    },
    async fail(jobId, _workerId, category, message) {
      const entry = jobs.find((candidate) => candidate.id === jobId);
      if (entry) {
        entry.status = "FAILED";
        Object.assign(entry, { last_error_category: category, last_error_message: message });
        return entry;
      }
      return root;
    },
    async enqueue(jobType, payload, dedupeKey) {
      const existing = jobs.find((entry) => entry.dedupe_key === dedupeKey);
      if (existing) return existing.id;
      const created = { ...job(`job-${++sequence}`, jobType, String(payload.chain_key)), payload, dedupe_key: dedupeKey };
      jobs.push(created);
      return created.id;
    },
  };
}

function candidate(rawPostId: string, caption: string): AnalysisCandidate {
  return {
    rawPostId,
    caption,
    mediaType: "IMAGE",
    mediaProductType: null,
    assets: [{
      mediaAssetId: "00000000-0000-4000-8000-000000000201",
      assetType: "IMAGE",
      carouselIndex: null,
      storagePath: "instagram/00000000-0000-4000-8000-000000000102/post-1/media-1.jpg",
      mimeType: "image/jpeg",
      sha256: "a".repeat(64),
    }],
    existingFingerprints: [],
  };
}

Deno.test("one root yields one analysis batch and one intelligence job despite a per-post failure", async () => {
  const chainKey = "m8-phase-a-smoke";
  const queue = queueWith(job("job-1", "COLLECT_INSTAGRAM", chainKey));
  const calls: string[] = [];
  let analysisSummary: unknown;
  const repository: AnalysisRepository = {
    async listCandidates() {
      return [candidate("00000000-0000-4000-8000-000000000101", "Thoughts? 👀"), candidate("00000000-0000-4000-8000-000000000103", "provider failure")];
    },
    async save() {},
  };
  const runAnalysis = () => runContentAnalysis({
    repository,
    contract,
    batchSize: 20,
    concurrency: 2,
    now: () => now,
    readMedia: async (asset) => ({
      mediaAssetId: asset.mediaAssetId,
      assetType: asset.assetType,
      carouselIndex: asset.carouselIndex,
      mimeType: "image/jpeg",
      bytes: new Uint8Array([1, 2, 3]),
      dataUrl: "data:image/jpeg;base64,AQID",
      sha256: asset.sha256 ?? "a".repeat(64),
    }),
    analyze: async (input) => {
      if (input.caption === "provider failure") throw new Error("upstream body must stay private");
      return { ...goldenAnalysisOutput, visualFormat: input.visualFormat };
    },
  });
  const invoker: BoundaryInvoker = {
    invoke: async (jobType) => {
      calls.push(jobType);
      if (jobType === "ANALYZE_CONTENT") {
        analysisSummary = await runAnalysis();
        return { status: 200, body: { status: "COMPLETED" } };
      }
      return { status: 200, body: { status: "COMPLETED" } };
    },
  };
  const worker = createOrchestrationWorker({ queue, invoker, workerId: "m8-smoke-worker", batchSize: 1, now: () => now });

  assert.deepEqual(await worker.processBatch(), { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(await worker.processBatch(), { claimed: 1, succeeded: 1, failed: 0, downstream_enqueued: 1 });
  assert.deepEqual(calls, ["COLLECT_INSTAGRAM", "ANALYZE_CONTENT"]);
  assert.deepEqual(analysisSummary, { status: "COMPLETED", candidates: 2, analyzed: 2, skipped: 0, succeeded: 1, partial: 0, unavailable: 0, failed: 1 });
  assert.equal(queue.jobs.filter((entry) => entry.job_type === "ANALYZE_CONTENT").length, 1);
  assert.equal(queue.jobs.filter((entry) => entry.job_type === "RUN_INTELLIGENCE").length, 1);
  assert.equal(queue.jobs.find((entry) => entry.job_type === "RUN_INTELLIGENCE")?.status, "PENDING");
  assert.equal(JSON.stringify(goldenAnalysisOutput).includes("original_media_url"), false);
});
