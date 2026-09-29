import type { DiscoveryMode, DiscoveryRunSummary, DiscoverySearchProfile } from "./types.ts";

export interface TrendDiscoveryHandlerDependencies {
  readonly collectorSecret: string;
  readonly defaultMaxQueries?: number;
  readonly now?: () => Date;
  readonly run: (input: { asOf?: Date; mode?: DiscoveryMode; searchProfile?: DiscoverySearchProfile; maxQueries?: number }) => Promise<DiscoveryRunSummary>;
}

const MODES = new Set<DiscoveryMode>(["GENERAL", "BREAKING", "TRANSFERS", "MATCH", "PLAYERS", "COMMUNITY"]);
const SEARCH_PROFILES = new Set<DiscoverySearchProfile>(["FAST", "PLAYER_SWEEP", "MANUAL"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function bearer(value: string | null): string { return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }

async function equal(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let index = 0; index < x.length; index += 1) diff |= x[index]! ^ y[index]!;
  return diff === 0;
}

export function createTrendDiscoveryHandler(dependencies: TrendDiscoveryHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret.trim()) throw new Error("Collector secret is required");
  const defaultMaxQueries = dependencies.defaultMaxQueries ?? 8;
  const now = dependencies.now ?? (() => new Date());
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    if (!await equal(bearer(request.headers.get("authorization")), dependencies.collectorSecret)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    let value: unknown;
    try { value = await request.json(); } catch { return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 }); }
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (Object.keys(object).some((key) => !["as_of", "mode", "search_profile", "max_queries"].includes(key))) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const mode = object.mode === undefined ? undefined : typeof object.mode === "string" && MODES.has(object.mode as DiscoveryMode) ? object.mode as DiscoveryMode : null;
    const searchProfile = object.search_profile === undefined ? undefined : typeof object.search_profile === "string" && SEARCH_PROFILES.has(object.search_profile as DiscoverySearchProfile) ? object.search_profile as DiscoverySearchProfile : null;
    const maxQueries = object.max_queries === undefined ? defaultMaxQueries : object.max_queries;
    if (mode === null || searchProfile === null || typeof maxQueries !== "number" || !Number.isSafeInteger(maxQueries) || maxQueries < 1 || maxQueries > 64) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    if (object.as_of !== undefined && (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of) || !Number.isFinite(new Date(object.as_of).getTime()))) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const summary = await dependencies.run({ asOf: typeof object.as_of === "string" ? new Date(object.as_of) : now(), mode: mode ?? undefined, searchProfile: searchProfile ?? undefined, maxQueries });
    return Response.json({ run_id: summary.runId, status: summary.status, mode: summary.mode, query_count: summary.queryCount, observation_count: summary.observationCount, new_observation_count: summary.newObservationCount, new_story_count: summary.newStoryCount, updated_story_count: summary.updatedStoryCount, provider_statuses: summary.providerStatuses, duration_ms: summary.durationMs });
  };
}
