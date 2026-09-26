export interface TelegramAgentHandlerDependencies {
  invokeSecret: string;
  webhookSecret?: string;
  ownerUserId: string;
  run: (update: unknown) => Promise<{ status: string; reply?: string }>;
  claimUpdate?: (update: unknown) => Promise<boolean>;
}

interface TelegramUpdate {
  update_id: number;
  message: {
    from: { id: number | string };
    chat: { id: number | string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

type AuthenticationMode = "webhook" | "internal";

function bearer(value: string | null): string {
  return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let index = 0; index < x.length; index += 1) diff |= x[index] ^ y[index];
  return diff === 0;
}

function normalizeUpdate(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return normalizeUpdate(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return Array.isArray(value) && value.length === 1 ? normalizeUpdate(value[0]) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTelegramId(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value);
  return typeof value === "string" && /^-?\d+$/u.test(value.trim());
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  if (!isRecord(value) || typeof value.update_id !== "number" || !Number.isInteger(value.update_id) || value.update_id < 0) return false;
  if (!isRecord(value.message) || !isRecord(value.message.from) || !isRecord(value.message.chat)) return false;
  return isTelegramId(value.message.from.id) && isTelegramId(value.message.chat.id);
}

async function authenticationMode(
  request: Request,
  dependencies: TelegramAgentHandlerDependencies,
): Promise<AuthenticationMode | null> {
  const suppliedWebhookSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (dependencies.webhookSecret?.trim() && suppliedWebhookSecret && await equalSecret(suppliedWebhookSecret, dependencies.webhookSecret)) return "webhook";

  const suppliedInvokeSecret = bearer(request.headers.get("authorization"));
  if (dependencies.invokeSecret.trim() && suppliedInvokeSecret && await equalSecret(suppliedInvokeSecret, dependencies.invokeSecret)) return "internal";
  return null;
}

function fromId(update: TelegramUpdate): string {
  return String(update.message.from.id);
}

export function createTelegramAgentHandler(
  dependencies: TelegramAgentHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret.trim() && !dependencies.webhookSecret?.trim()) throw new Error("Telegram agent authentication secret is required");
  if (!dependencies.ownerUserId.trim()) throw new Error("Telegram owner user id is required");

  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    const mode = await authenticationMode(request, dependencies);
    if (!mode) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid Telegram update" } }, { status: 400 });
    }

    const normalized = mode === "internal" ? normalizeUpdate(parsed) : parsed;
    if (!isTelegramUpdate(normalized)) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid Telegram update" } }, { status: 400 });
    const update = normalized;
    if (fromId(update) !== dependencies.ownerUserId) return Response.json({ error: { code: "FORBIDDEN", message: "Forbidden" } }, { status: 403 });
    if (dependencies.claimUpdate && !await dependencies.claimUpdate(update)) return Response.json({ status: "ALREADY_PROCESSED" });
    return Response.json(await dependencies.run(update));
  };
}
