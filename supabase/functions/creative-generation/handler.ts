import type { GenerationResult, GenerationTrigger } from "./orchestrator.ts";

export interface CreativeGenerationHandlerDependencies {
  readonly collectorSecret: string;
  readonly run: (trigger: GenerationTrigger) => Promise<GenerationResult>;
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
  for (let index = 0; index < leftDigest.length; index += 1) difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  return difference === 0;
}

function bearerToken(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers: { ...headers } });
}

async function requestedTrigger(request: Request): Promise<GenerationTrigger> {
  const body = await request.text();
  if (!body.trim()) throw new InvalidRequestError();
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new InvalidRequestError(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const object = value as Record<string, unknown>;
  if (typeof object.candidate_id !== "string" || object.candidate_id.trim() === "") throw new InvalidRequestError();
  if (object.trigger_type !== "AUTO_PRIORITY" && object.trigger_type !== "NOTION_SELECTED" && object.trigger_type !== "MANUAL") throw new InvalidRequestError();
  return { candidate_id: object.candidate_id, trigger_type: object.trigger_type };
}

export function createCreativeGenerationHandler(
  dependencies: CreativeGenerationHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    const suppliedSecret = bearerToken(request.headers.get("authorization"));
    if (suppliedSecret === "" || !await timingSafeEqual(suppliedSecret, dependencies.collectorSecret)) {
      log({ requestId: id, event: "creative_generation_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }
    try {
      const result = await dependencies.run(await requestedTrigger(request));
      log({ requestId: id, event: "creative_generation_completed", status: result.status });
      return json({ request_id: id, status: result.status, candidate_id: result.candidate_id, creative_brief_id: result.creative_brief_id ?? null, revision: result.revision ?? null, input_fingerprint: result.input_fingerprint ?? null, error_codes: result.error_codes ?? [] }, result.status === "CONCURRENT" ? 202 : 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      log({ requestId: id, event: "creative_generation_failed", code: "CREATIVE_GENERATION_FAILED" });
      return json({ request_id: id, error: { code: "CREATIVE_GENERATION_FAILED", message: "Creative generation failed" } }, 500);
    }
  };
}
