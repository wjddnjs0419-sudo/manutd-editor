export type TelegramErrorCategory = "RATE_LIMITED" | "SERVER_ERROR" | "NETWORK_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "BAD_REQUEST" | "MALFORMED_RESPONSE";

export class TelegramClientError extends Error {
  constructor(readonly category: TelegramErrorCategory, readonly status: number | null = null) {
    super(category);
    this.name = "TelegramClientError";
  }
}

export interface TelegramSendResult { message_id: number | null; }

export interface TelegramClient {
  sendText(chatId: string | number, text: string): Promise<TelegramSendResult>;
  sendPhoto(chatId: string | number, photoUrl: string, caption: string): Promise<TelegramSendResult>;
}

interface TelegramClientOptions {
  token: string;
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
}

function retryAfter(body: unknown, headers: Headers): number | null {
  if (typeof body === "object" && body !== null && "parameters" in body) {
    const value = (body as { parameters?: { retry_after?: unknown }}).parameters?.retry_after;
    if (typeof value === "number" && value >= 0) return value * 1000;
  }
  const header = Number(headers.get("retry-after"));
  return Number.isFinite(header) && header >= 0 ? header * 1000 : null;
}

function category(status: number): TelegramErrorCategory {
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "SERVER_ERROR";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  return "BAD_REQUEST";
}

export function createTelegramClient(options: TelegramClientOptions): TelegramClient {
  if (!options.token.trim()) throw new Error("Telegram bot token is required");
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const maxAttempts = options.maxAttempts ?? 3;

  async function send(method: "sendMessage" | "sendPhoto", body: Record<string, unknown>): Promise<TelegramSendResult> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${options.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        if (attempt === maxAttempts) throw new TelegramClientError("NETWORK_ERROR");
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }
      let decoded: unknown = null;
      try { decoded = await response.json(); } catch { throw new TelegramClientError("MALFORMED_RESPONSE", response.status); }
      if (response.ok && typeof decoded === "object" && decoded !== null && (decoded as { ok?: unknown }).ok === true) {
        const message = (decoded as { result?: { message_id?: unknown }}).result;
        return { message_id: typeof message?.message_id === "number" ? message.message_id : null };
      }
      const errorCategory = category(response.status);
      if ((errorCategory === "RATE_LIMITED" || errorCategory === "SERVER_ERROR") && attempt < maxAttempts) {
        await sleep(retryAfter(decoded, response.headers) ?? 250 * 2 ** (attempt - 1));
        continue;
      }
      throw new TelegramClientError(errorCategory, response.status);
    }
    throw new TelegramClientError("NETWORK_ERROR");
  }

  return {
    sendText: (chatId, text) => send("sendMessage", { chat_id: chatId, text }),
    sendPhoto: (chatId, photoUrl, caption) => send("sendPhoto", { chat_id: chatId, photo: photoUrl, caption }),
  };
}
