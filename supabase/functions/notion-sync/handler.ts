import type { NotionSyncSummary } from "./orchestrator.ts";

export interface NotionSyncHandlerDependencies {
  readonly collectorSecret: string;
  readonly run: (runAt: Date) => Promise<NotionSyncSummary>;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (let index = 0; index < leftDigest.length; index += 1) {
    difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...headers } });
}

function requestBodyDate(value: unknown): Date {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new InvalidRequestError();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new InvalidRequestError();
  return parsed;
}

async function requestedRunAt(request: Request, now: () => Date): Promise<Date> {
  if (request.body === null) return now();
  const text = await request.text();
  if (text.trim() === "") return now();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError();
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || !("as_of" in object)) {
    throw new InvalidRequestError();
  }
  return requestBodyDate(object.as_of);
}

function safeSummary(requestId: string, result: NotionSyncSummary) {
  return {
    request_id: requestId,
    ranking_date: result.rankingDate,
    considered: result.considered,
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    dropped: result.dropped,
    expired: result.expired,
    failed: result.failed,
  };
}

export function createNotionSyncHandler(
  dependencies: NotionSyncHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") {
      return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    }

    const suppliedSecret = bearerToken(request.headers.get("authorization"));
    if (suppliedSecret === "" || !await timingSafeEqual(suppliedSecret, dependencies.collectorSecret)) {
      log({ requestId: id, event: "notion_sync_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }

    try {
      const result = await dependencies.run(await requestedRunAt(request, now));
      log({ requestId: id, event: "notion_sync_completed", failed: result.failed, updated: result.updated });
      return json(safeSummary(id, result), 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      }
      log({ requestId: id, event: "notion_sync_failed", code: "NOTION_SYNC_FAILED" });
      return json({ request_id: id, error: { code: "NOTION_SYNC_FAILED", message: "Notion sync failed" } }, 500);
    }
  };
}

