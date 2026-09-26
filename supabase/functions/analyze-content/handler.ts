import type { AnalysisBatchSummary } from "./orchestrator.ts";

export interface AnalyzeContentHandlerDependencies {
  readonly collectorSecret: string;
  readonly defaultLimit?: number;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly run: (asOf: Date | undefined, limit: number) => Promise<AnalysisBatchSummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function bearerToken(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...headers } });
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

async function requestInput(request: Request, defaultLimit: number): Promise<{ asOf: Date | undefined; limit: number }> {
  const body = await request.text();
  if (body.trim() === "") return { asOf: undefined, limit: defaultLimit };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidRequestError();
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidRequestError();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.some((key) => key !== "as_of" && key !== "limit") || keys.length === 0) throw new InvalidRequestError();
  let asOf: Date | undefined;
  if ("as_of" in object) {
    if (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of)) throw new InvalidRequestError();
    asOf = new Date(object.as_of);
    if (!Number.isFinite(asOf.getTime())) throw new InvalidRequestError();
  }
  const limit = object.limit === undefined ? defaultLimit : object.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new InvalidRequestError();
  return { asOf, limit };
}

export function createAnalyzeContentHandler(dependencies: AnalyzeContentHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const defaultLimit = dependencies.defaultLimit ?? 20;
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > 100) throw new Error("Default analysis limit is invalid");
  const now = dependencies.now ?? (() => new Date());
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    const supplied = bearerToken(request.headers.get("authorization"));
    if (!supplied || !await timingSafeEqual(supplied, dependencies.collectorSecret)) {
      log({ requestId: id, event: "analyze_content_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }
    try {
      const input = await requestInput(request, defaultLimit);
      const result = await dependencies.run(input.asOf ?? now(), input.limit);
      log({ requestId: id, event: "analyze_content_completed", status: result.status, candidates: result.candidates, analyzed: result.analyzed, failed: result.failed });
      return json({ request_id: id, ...result }, 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      log({ requestId: id, event: "analyze_content_failed", code: "ANALYSIS_FAILED" });
      return json({ request_id: id, error: { code: "ANALYSIS_FAILED", message: "Content analysis failed" } }, 500);
    }
  };
}
