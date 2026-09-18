export interface CreativeBatchHandlerDependencies {
  readonly collectorSecret: string;
  readonly run: () => Promise<unknown>;
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

async function emptyBody(request: Request): Promise<void> {
  const body = await request.text();
  if (body.trim() !== "" && body.trim() !== "{}") throw new InvalidRequestError();
}

export function createCreativeBatchHandler(dependencies: CreativeBatchHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request) => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405, { allow: "POST" });
    const suppliedSecret = bearerToken(request.headers.get("authorization"));
    if (suppliedSecret === "" || !await timingSafeEqual(suppliedSecret, dependencies.collectorSecret)) {
      log({ requestId: id, event: "creative_batch_rejected", code: "UNAUTHORIZED" });
      return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    }
    try {
      await emptyBody(request);
      const result = await dependencies.run();
      log({ requestId: id, event: "creative_batch_completed" });
      return json({ request_id: id, status: "COMPLETED", result }, 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Empty request body required" } }, 400);
      log({ requestId: id, event: "creative_batch_failed", code: "CREATIVE_BATCH_FAILED" });
      return json({ request_id: id, error: { code: "CREATIVE_BATCH_FAILED", message: "Creative batch failed" } }, 500);
    }
  };
}
