import type { SourceDiscoveryRunInput, SourceDiscoverySummary } from "./types.ts";

export interface SourceDiscoveryHandlerDependencies {
  readonly collectorSecret: string;
  readonly defaultLimit?: number;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly run: (input: SourceDiscoveryRunInput) => Promise<SourceDiscoverySummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...headers } });
}

function bearerToken(value: string | null): string {
  return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

async function input(request: Request, defaultLimit: number): Promise<SourceDiscoveryRunInput> {
  const body = await request.text();
  if (body.trim() === "") return { limit: defaultLimit };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "as_of" && key !== "limit")) throw new InvalidRequestError();
  const limit = object.limit === undefined ? defaultLimit : object.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidRequestError();
  if (object.as_of === undefined) return { limit };
  if (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of)) throw new InvalidRequestError();
  const asOf = new Date(object.as_of);
  if (!Number.isFinite(asOf.getTime())) throw new InvalidRequestError();
  return { asOf, limit };
}

export function createSourceDiscoveryHandler(dependencies: SourceDiscoveryHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const defaultLimit = dependencies.defaultLimit ?? 20;
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    const supplied = bearerToken(request.headers.get("authorization"));
    if (!supplied || !await timingSafeEqual(supplied, dependencies.collectorSecret)) {
      log({ requestId: id, event: "source_discovery_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }
    try {
      const requested = await input(request, defaultLimit);
      const result = await dependencies.run({ ...requested, asOf: requested.asOf ?? now() });
      return json({ request_id: id, status: result.status, observed: result.observed, duplicates: result.duplicates, failed_feeds: result.failedFeeds, feed_count: result.feedCount }, 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      log({ requestId: id, event: "source_discovery_failed", code: "SOURCE_DISCOVERY_FAILED" });
      return json({ request_id: id, error: { code: "SOURCE_DISCOVERY_FAILED", message: "Source discovery failed" } }, 500);
    }
  };
}
