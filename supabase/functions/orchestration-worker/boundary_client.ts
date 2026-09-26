import type { BoundaryInvoker, EditorialJobType } from "./types.ts";

interface BoundaryClientOptions {
  readonly functionsUrl: string;
  readonly collectorSecret: string;
  readonly telegramSecret: string;
  readonly request?: typeof fetch;
}

const BOUNDARIES: Record<EditorialJobType, { path: string; secret: "collector" | "telegram" }> = {
  COLLECT_INSTAGRAM: { path: "collect-instagram", secret: "collector" },
  RUN_INTELLIGENCE: { path: "intelligence", secret: "collector" },
  GENERATE_PRIORITY: { path: "creative-generation-priority", secret: "collector" },
  SYNC_NOTION: { path: "sync-notion-intelligence", secret: "collector" },
  PROJECT_NOTION: { path: "project-notion", secret: "collector" },
  POLL_SELECTED: { path: "creative-generation-selected-poll", secret: "collector" },
  DISPATCH_ALERTS: { path: "telegram-alerts", secret: "telegram" },
  FIXTURE_SYNC: { path: "fixture-sync", secret: "telegram" },
  MORNING_BRIEF: { path: "telegram-morning-brief", secret: "telegram" },
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestBody(jobType: EditorialJobType, payload: Record<string, unknown>): Record<string, unknown> {
  if (jobType === "COLLECT_INSTAGRAM") {
    return Array.isArray(payload.source_account_ids)
      ? { source_account_ids: payload.source_account_ids }
      : {};
  }
  if (jobType === "RUN_INTELLIGENCE" || jobType === "SYNC_NOTION") {
    return typeof payload.as_of === "string" ? { as_of: payload.as_of } : {};
  }
  if (jobType === "PROJECT_NOTION") {
    return typeof payload.creative_brief_id === "string" ? { creative_brief_id: payload.creative_brief_id } : {};
  }
  if (jobType === "FIXTURE_SYNC") {
    return { mode: payload.mode === "FORCE" ? "FORCE" : "AUTO" };
  }
  return {};
}

export function createBoundaryInvoker(options: BoundaryClientOptions): BoundaryInvoker {
  const fetchImpl = options.request ?? fetch;
  const base = options.functionsUrl.replace(/\/$/u, "");
  return {
    async invoke(jobType, payload) {
      const boundary = BOUNDARIES[jobType];
      const secret = boundary.secret === "collector" ? options.collectorSecret : options.telegramSecret;
      const response = await fetchImpl(`${base}/${boundary.path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody(jobType, record(payload))),
      });
      return { status: response.status };
    },
  };
}
