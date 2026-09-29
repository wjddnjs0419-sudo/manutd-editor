import type { BoundaryInvoker, EditorialJobType } from "./types.ts";
import { isGroundingCursor, isGroundingLimit, isGroundingScope } from "../ground-claims/contract.ts";

interface BoundaryClientOptions {
  readonly functionsUrl: string;
  readonly collectorSecret: string;
  readonly telegramSecret: string;
  readonly request?: typeof fetch;
}

const BOUNDARIES: Record<EditorialJobType, { path: string; secret: "collector" | "telegram" }> = {
  COLLECT_INSTAGRAM: { path: "collect-instagram", secret: "collector" },
  ANALYZE_CONTENT: { path: "analyze-content", secret: "collector" },
  RUN_INTELLIGENCE: { path: "intelligence", secret: "collector" },
  DISCOVER_SOURCES: { path: "source-discovery", secret: "collector" },
  DISCOVER_TRENDS: { path: "trend-discovery", secret: "collector" },
  PROMOTE_DISCOVERY: { path: "promote-discovery", secret: "collector" },
  GROUND_CLAIMS: { path: "ground-claims", secret: "collector" },
  RANK_EDITORIAL: { path: "rank-editorial", secret: "collector" },
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

function requestBody(jobType: EditorialJobType, payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (jobType === "COLLECT_INSTAGRAM") {
    return Array.isArray(payload.source_account_ids)
      ? { source_account_ids: payload.source_account_ids }
      : undefined;
  }
  if (jobType === "ANALYZE_CONTENT") {
    const value = {
      ...(typeof payload.as_of === "string" ? { as_of: payload.as_of } : {}),
      ...(typeof payload.limit === "number" && Number.isSafeInteger(payload.limit) ? { limit: payload.limit } : {}),
    };
    return Object.keys(value).length === 0 ? undefined : value;
  }
  if (jobType === "RUN_INTELLIGENCE" || jobType === "SYNC_NOTION" || jobType === "DISCOVER_SOURCES" || jobType === "RANK_EDITORIAL") {
    return typeof payload.as_of === "string" ? { as_of: payload.as_of } : undefined;
  }
  if (jobType === "GROUND_CLAIMS") {
    if (payload.story_cluster_ids !== undefined && !isGroundingScope(payload.story_cluster_ids)) throw new Error("GROUNDING_PAYLOAD_INVALID");
    if (payload.limit !== undefined && !isGroundingLimit(payload.limit)) throw new Error("GROUNDING_PAYLOAD_INVALID");
    if (payload.cursor !== undefined && payload.cursor !== null && !isGroundingCursor(payload.cursor)) throw new Error("GROUNDING_PAYLOAD_INVALID");
    const value = {
      ...(typeof payload.as_of === "string" ? { as_of: payload.as_of } : {}),
      ...(Array.isArray(payload.story_cluster_ids) ? { story_cluster_ids: payload.story_cluster_ids.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof payload.limit === "number" && Number.isSafeInteger(payload.limit) ? { limit: payload.limit } : {}),
      ...(typeof payload.cursor === "string" || payload.cursor === null ? { cursor: payload.cursor } : {}),
    };
    return Object.keys(value).length === 0 ? undefined : value;
  }
  if (jobType === "DISCOVER_TRENDS") {
    const value = {
      ...(typeof payload.as_of === "string" ? { as_of: payload.as_of } : {}),
      ...(typeof payload.search_profile === "string" ? { search_profile: payload.search_profile } : {}),
      ...(typeof payload.mode === "string" ? { mode: payload.mode } : {}),
      ...(typeof payload.max_queries === "number" && Number.isSafeInteger(payload.max_queries) ? { max_queries: payload.max_queries } : {}),
    };
    return Object.keys(value).length === 0 ? undefined : value;
  }
  if (jobType === "PROMOTE_DISCOVERY") {
    const promotionJobId = payload.promotion_job_id;
    if (promotionJobId !== undefined && (typeof promotionJobId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(promotionJobId))) throw new Error("PROMOTION_JOB_ID_INVALID");
    const value = {
      ...(typeof payload.as_of === "string" ? { as_of: payload.as_of } : {}),
      ...(typeof payload.limit === "number" && Number.isSafeInteger(payload.limit) ? { limit: payload.limit } : {}),
      ...(typeof payload.ranking_date === "string" ? { ranking_date: payload.ranking_date } : {}),
      ...(typeof promotionJobId === "string" ? { promotion_job_id: promotionJobId } : {}),
    };
    return Object.keys(value).length === 0 ? undefined : value;
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
        body: (() => {
          const value = requestBody(jobType, record(payload));
          return value === undefined ? undefined : JSON.stringify(value);
        })(),
      });
      if (!response.ok) return { status: response.status };
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        return { status: response.status };
      }
    },
  };
}
