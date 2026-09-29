const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 200_000;
const HARD_MAX_BYTES = 200_000;
const DEFAULT_MAX_ITEMS = 20;

export function boundedItemCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
  return Math.max(1, Math.min(DEFAULT_MAX_ITEMS, Math.floor(value)));
}

export function boundedByteCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.max(1, Math.min(HARD_MAX_BYTES, Math.floor(value)));
}

function timeoutDuration(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new Error("BODY_TOO_LARGE");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export async function fetchBoundedText(
  url: URL,
  options: {
    readonly fetch?: typeof fetch;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    readonly accept?: string;
  },
): Promise<string | null> {
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const fetchImpl = options.fetch ?? fetch;
  const controller = new AbortController();
  const timeoutMs = timeoutDuration(options.timeoutMs);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = fetchImpl(url, {
      method: "GET",
      headers: {
        accept: options.accept ?? "application/rss+xml, application/atom+xml, application/json",
      },
      signal: controller.signal,
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const timedOut = new Promise<null>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, timeoutMs);
    });
    return await Promise.race([
      request.then(async (response) => {
        if (!response.ok || response.status >= 300) return null;
        return await readBody(response, boundedByteCount(options.maxBytes));
      }),
      timedOut,
    ]);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function validWindow(
  windowStart: string,
  windowEnd: string,
): { readonly start: number; readonly end: number } | null {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    return null;
  }
  return { start, end };
}

export function inWindow(
  publishedAt: string | null,
  window: { readonly start: number; readonly end: number },
): boolean {
  if (!publishedAt) return true;
  const timestamp = Date.parse(publishedAt);
  return Number.isFinite(timestamp) && timestamp >= window.start &&
    timestamp <= window.end;
}

export function asGdeltTimestamp(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${
    pad(date.getUTCDate())
  }${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${
    pad(date.getUTCSeconds())
  }`;
}

export function parseGdeltDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/u,
  );
  if (match) {
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${
      match[6]
    }Z`;
    const parsed = new Date(iso);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.replace(/\s+/gu, " ").trim();
  return result ? result.slice(0, maxLength) : null;
}

export function safeHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString().slice(0, 2_000);
  } catch {
    return null;
  }
}
