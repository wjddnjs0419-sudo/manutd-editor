export interface TelegramAgentHandlerDependencies {
  invokeSecret: string;
  ownerUserId: string;
  run: (update: unknown) => Promise<{ status: string; reply?: string }>;
  claimUpdate?: (update: unknown) => Promise<boolean>;
}

function bearer(value: string | null): string { return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }
async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b); let diff = x.length ^ y.length;
  for (let index = 0; index < x.length; index += 1) diff |= x[index] ^ y[index];
  return diff === 0;
}
function fromId(update: unknown): string { const value = update as { message?: { from?: { id?: unknown } } }; return typeof value.message?.from?.id === "number" ? String(value.message.from.id) : ""; }

export function createTelegramAgentHandler(dependencies: TelegramAgentHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret) throw new Error("Telegram agent invoke secret is required");
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    if (!await equalSecret(bearer(request.headers.get("authorization")), dependencies.invokeSecret)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    let update: unknown;
    try { update = await request.json(); } catch { return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid Telegram update" } }, { status: 400 }); }
    if (fromId(update) !== dependencies.ownerUserId) return Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    if (dependencies.claimUpdate && !await dependencies.claimUpdate(update)) return Response.json({ status: "ALREADY_PROCESSED" });
    return Response.json(await dependencies.run(update));
  };
}
