import type { GroundingRunInput, GroundingSummary } from "./types.ts";
import { GROUNDING_DEFAULT_LIMIT, GROUNDING_MAX_LIMIT, GROUNDING_MAX_SCOPE, isGroundingCursor, isGroundingStoryId } from "./contract.ts";

export interface GroundClaimsHandlerDependencies {
  readonly collectorSecret: string;
  readonly requestId?: () => string;
  readonly run: (input: GroundingRunInput, context?: { requestId: string; log: (entry: Record<string, unknown>) => void }) => Promise<GroundingSummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
function bearer(value: string | null): string {
  return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

async function equal(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function body(request: Request): Promise<GroundingRunInput> {
  if (Number(request.headers.get("content-length")) > 16_384) throw new InvalidRequestError();
  const text = await request.text();
  if (text.length > 16_384) throw new InvalidRequestError();
  if (!text.trim()) return { limit: GROUNDING_DEFAULT_LIMIT };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InvalidRequestError(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["as_of", "story_cluster_ids", "limit", "cursor"].includes(key))) throw new InvalidRequestError();
  const input: { asOf?: Date; storyClusterIds?: readonly string[]; limit: number; cursor?: string | null } = { limit: GROUNDING_DEFAULT_LIMIT };
  if ("as_of" in object) {
    if (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of)) throw new InvalidRequestError();
    const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] =
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(object.as_of) ?? [];
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate() ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 || Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) throw new InvalidRequestError();
    const asOf = new Date(object.as_of);
    if (!Number.isFinite(asOf.getTime())) throw new InvalidRequestError();
    input.asOf = asOf;
  }
  if ("story_cluster_ids" in object) {
    if (!Array.isArray(object.story_cluster_ids) || object.story_cluster_ids.length > GROUNDING_MAX_SCOPE ||
      object.story_cluster_ids.some((id) => !isGroundingStoryId(id)) ||
      new Set(object.story_cluster_ids).size !== object.story_cluster_ids.length) throw new InvalidRequestError();
    input.storyClusterIds = object.story_cluster_ids;
  }
  if ("limit" in object) {
    if (typeof object.limit !== "number" || !Number.isInteger(object.limit) || object.limit < 1 || object.limit > GROUNDING_MAX_LIMIT) throw new InvalidRequestError();
    input.limit = object.limit;
  }
  if ("cursor" in object) {
    if (object.cursor !== null && !isGroundingCursor(object.cursor)) throw new InvalidRequestError();
    input.cursor = object.cursor;
  }
  return input;
}

export function createGroundClaimsHandler(dependencies: GroundClaimsHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request) => {
    const id = requestId();
    let failureLogged = false;
    const phaseLog = (entry: Record<string, unknown>) => {
      if (entry.event === "ground_claims_failed") failureLogged = true;
      log(entry);
    };
    if (request.method !== "POST") return Response.json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405, headers: { allow: "POST" } });
    const supplied = bearer(request.headers.get("authorization"));
    if (!supplied || !await equal(supplied, dependencies.collectorSecret)) {
      log({ request_id: id, event: "ground_claims_rejected", code: "UNAUTHORIZED" });
      return Response.json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    }
    try {
      const result = await dependencies.run(await body(request), { requestId: id, log: phaseLog });
      return Response.json({ request_id: id, status: result.status, claims_processed: result.claimsProcessed, verified: result.verified, discovery_only: result.discoveryOnly, contradicted: result.contradicted, insufficient: result.insufficient, has_more: result.hasMore ?? false, next_cursor: result.nextCursor ?? null });
    } catch (error) {
      if (error instanceof InvalidRequestError) return Response.json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
      if (!failureLogged) log({ request_id: id, event: "ground_claims_failed", phase: "REQUEST", error_code: "GROUND_CLAIMS_FAILED", elapsed_ms: 0 });
      return Response.json({ request_id: id, error: { code: "GROUND_CLAIMS_FAILED", message: "Claim grounding failed" } }, { status: 500 });
    }
  };
}
