import type { AlertDispatchSummary } from "../_shared/m6/alerts.ts";

export interface TelegramAlertsHandlerDependencies {
  invokeSecret: string;
  run: (input?: { mode: "HOURLY_DIGEST"; window_start: string; window_end: string }) => Promise<AlertDispatchSummary>;
}

function bearer(header: string | null): string { return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const leftBytes = new Uint8Array(a);
  const rightBytes = new Uint8Array(b);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) diff |= leftBytes[index] ^ rightBytes[index];
  return diff === 0;
}

export function createTelegramAlertsHandler(dependencies: TelegramAlertsHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret) throw new Error("Telegram alerts invoke secret is required");
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    if (!await equalSecret(bearer(request.headers.get("authorization")), dependencies.invokeSecret)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    let input: { mode: "HOURLY_DIGEST"; window_start: string; window_end: string } | undefined;
    if (request.headers.get("content-type")?.includes("application/json")) {
      let body: unknown;
      try { body = await request.json(); } catch { return Response.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 }); }
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const value = body as Record<string, unknown>;
        if (value.mode !== "HOURLY_DIGEST" || typeof value.window_start !== "string" || typeof value.window_end !== "string" || !Number.isFinite(Date.parse(value.window_start)) || !Number.isFinite(Date.parse(value.window_end)) || Date.parse(value.window_start) >= Date.parse(value.window_end)) return Response.json({ error: { code: "INVALID_REQUEST" } }, { status: 400 });
        input = { mode: "HOURLY_DIGEST", window_start: value.window_start, window_end: value.window_end };
      }
    }
    const result = await dependencies.run(input);
    return Response.json(result);
  };
}
