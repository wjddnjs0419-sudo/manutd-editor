import type { FixtureSyncResult } from "../_shared/m6/fixture_service.ts";

export interface FixtureSyncHandlerDependencies {
  invokeSecret: string;
  run: (request: { mode: "AUTO" | "FORCE" }) => Promise<FixtureSyncResult>;
  now?: () => Date;
}

function token(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(a);
  const rightBytes = new Uint8Array(b);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export function createFixtureSyncHandler(
  dependencies: FixtureSyncHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret) throw new Error("Fixture sync invoke secret is required");
  return async (request) => {
    if (request.method !== "POST") return json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405);
    const supplied = token(request.headers.get("authorization"));
    if (!supplied || !await equalSecret(supplied, dependencies.invokeSecret)) return json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length !== 1 || (entries[0][0] !== "mode") || !["AUTO", "FORCE"].includes(String(entries[0][1]))) return json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
    const result = await dependencies.run({ mode: entries[0][1] as "AUTO" | "FORCE" });
    return json(result, result.status === "FAILED" ? 502 : 200);
  };
}
