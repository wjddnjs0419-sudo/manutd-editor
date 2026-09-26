import type { OrchestrationBatchSummary } from "./types.ts";

export interface OrchestrationHandlerDependencies {
  readonly workerSecret: string;
  readonly defaultLimit?: number;
  readonly run: (limit: number) => Promise<OrchestrationBatchSummary>;
  readonly requestId?: () => string;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}

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

async function requestedLimit(request: Request, defaultLimit: number): Promise<number> {
  const text = await request.text();
  if (text.trim() === "") return defaultLimit;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return defaultLimit;
  if (entries.length !== 1 || entries[0]?.[0] !== "limit") throw new InvalidRequestError();
  const limit = entries[0]?.[1];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new InvalidRequestError();
  return limit;
}

export function createOrchestrationHandler(
  dependencies: OrchestrationHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.workerSecret) throw new Error("Worker secret is required");
  const defaultLimit = dependencies.defaultLimit ?? 5;
  if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > 20) throw new Error("Default limit is invalid");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    const supplied = bearerToken(request.headers.get("authorization"));
    if (!supplied || !await timingSafeEqual(supplied, dependencies.workerSecret)) {
      log({ requestId: id, event: "orchestration_worker_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }
    try {
      const result = await dependencies.run(await requestedLimit(request, defaultLimit));
      log({ requestId: id, event: "orchestration_worker_completed", claimed: result.claimed, succeeded: result.succeeded, failed: result.failed });
      return json({ request_id: id, ...result }, 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      log({ requestId: id, event: "orchestration_worker_failed", code: "WORKER_FAILED" });
      return json({ request_id: id, error: { code: "WORKER_FAILED", message: "Orchestration worker failed" } }, 500);
    }
  };
}

