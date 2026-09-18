import type { NotionPagePayload } from "./mapper.ts";

export type NotionErrorCategory =
  | "RATE_LIMITED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR"
  | "NETWORK_TIMEOUT"
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "MALFORMED_RESPONSE";

export class NotionClientError extends Error {
  readonly category: NotionErrorCategory;
  readonly status?: number;

  constructor(category: NotionErrorCategory, status?: number) {
    super(category);
    this.name = "NotionClientError";
    this.category = category;
    this.status = status;
  }
}

interface NotionPageResult {
  id: string;
  url?: string;
}

interface NotionClientOptions {
  token: string;
  databaseId: string;
  fetch?: typeof fetch;
  sleep?: (delayMs: number) => Promise<void>;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface NotionClient {
  createPage(payload: NotionPagePayload): Promise<NotionPageResult>;
  updatePage(pageId: string, payload: NotionPagePayload): Promise<NotionPageResult>;
  retrievePage(pageId: string): Promise<NotionPageResult>;
}

const API_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function statusCategory(status: number): NotionErrorCategory {
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500 && status <= 599) return "SERVER_ERROR";
  if (status === 400) return "BAD_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  return "BAD_REQUEST";
}

function retryAfterMs(
  header: string | null,
  now: () => number,
  fallback: number,
): number {
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - now(), 0), 30_000);
  return fallback;
}

function parsePage(body: unknown): NotionPageResult {
  if (!body || typeof body !== "object") throw new NotionClientError("MALFORMED_RESPONSE");
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new NotionClientError("MALFORMED_RESPONSE");
  }
  return {
    id: record.id,
    url: typeof record.url === "string" ? record.url : undefined,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function createNotionClient(options: NotionClientOptions): NotionClient {
  if (!options.token || !options.databaseId) {
    throw new Error("Notion client configuration is incomplete");
  }

  const requestFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;

  async function request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<NotionPageResult> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await requestFetch(`${API_BASE}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${options.token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (response.ok) {
          let decoded: unknown;
          try {
            decoded = await response.json();
          } catch {
            throw new NotionClientError("MALFORMED_RESPONSE", response.status);
          }
          return parsePage(decoded);
        }

        const category = statusCategory(response.status);
        if (
          (category === "RATE_LIMITED" || category === "SERVER_ERROR") &&
          attempt < maxAttempts
        ) {
          const fallback = baseDelayMs * 2 ** (attempt - 1);
          await sleep(retryAfterMs(response.headers.get("Retry-After"), now, fallback));
          continue;
        }
        throw new NotionClientError(category, response.status);
      } catch (error) {
        if (error instanceof NotionClientError) throw error;
        const category = isAbortError(error) ? "NETWORK_TIMEOUT" : "NETWORK_ERROR";
        if (attempt < maxAttempts) {
          await sleep(baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new NotionClientError(category);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new NotionClientError("NETWORK_ERROR");
  }

  return {
    createPage: (payload) => request("POST", "/pages", {
      parent: { database_id: options.databaseId },
      properties: payload.properties,
      children: payload.children,
    }),
    updatePage: (pageId, payload) => request("PATCH", `/pages/${encodeURIComponent(pageId)}`, {
      properties: payload.properties,
    }),
    retrievePage: (pageId) => request("GET", `/pages/${encodeURIComponent(pageId)}`),
  };
}
