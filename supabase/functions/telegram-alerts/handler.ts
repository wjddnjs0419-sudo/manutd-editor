import type { AlertDispatchSummary } from "../_shared/m6/alerts.ts";

export interface TelegramAlertsHandlerDependencies {
  invokeSecret: string;
  run: () => Promise<AlertDispatchSummary>;
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
    const result = await dependencies.run();
    return Response.json(result);
  };
}
