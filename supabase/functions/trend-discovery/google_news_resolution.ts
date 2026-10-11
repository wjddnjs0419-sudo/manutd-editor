/**
 * Best-effort Google News RSS link resolver.
 *
 * Google News increasingly emits opaque /rss/articles IDs that point to an
 * HTML/JS shell instead of issuing an ordinary publisher redirect. This
 * resolution uses Google's current article-signature endpoint, so it may
 * stop working without notice. Never mark an unresolved link as extracted.
 */
export interface GoogleNewsResolutionOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const GOOGLE_NEWS = "news.google.com";
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_TIMEOUT_MS = 6_000;
const GOOGLE_RPC_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const ARTICLE_PATH = /^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{8,1600})\/?$/u;

export function isGoogleNewsArticleUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === GOOGLE_NEWS &&
      !url.username && !url.password && ARTICLE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/** Only accept publicly routable-looking HTTPS publisher hosts. */
export function safePublisherUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US");
    if (url.protocol !== "https:" || url.username || url.password ||
      url.port && url.port !== "443" || value.length > 2_000 ||
      !host.includes(".") || host.includes(":") ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) ||
      /\.(?:local|localhost|internal|invalid|test)$/u.test(host) ||
      host === GOOGLE_NEWS || host === "google.com" || host === "www.google.com") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

async function getText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, MAX_TIMEOUT_MS)));
  try {
    let response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && [301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) return null;
      let redirectUrl: URL;
      try {
        redirectUrl = new URL(location, url);
      } catch {
        return null;
      }
      // Google localizes the signed article page with one same-host redirect.
      // Never follow cross-origin redirects or a second redirect hop.
      if (redirectUrl.protocol !== "https:" || redirectUrl.hostname !== GOOGLE_NEWS ||
        redirectUrl.origin !== new URL(url).origin) return null;
      await response.body?.cancel();
      response = await fetchImpl(redirectUrl, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    }
    if (!response.ok || response.status >= 300) return null;
    const indicatedLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(indicatedLength) && indicatedLength > MAX_RESPONSE_BYTES) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return null;
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

function attribute(html: string, name: string): string | null {
  const pattern = new RegExp(`\\b${name}=["']([^"'<>]{1,2048})["']`, "u");
  return pattern.exec(html)?.[1] ?? null;
}

function parseRpcPublisherUrl(body: string): string | null {
  // batchexecute typically returns an anti-XSSI prefix, a byte-length
  // prefix, and then a JSON array. Only accept the known Fbv4je envelope.
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[[")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) continue;
      for (const row of parsed) {
        if (!Array.isArray(row) || row[1] !== "Fbv4je" || typeof row[2] !== "string") continue;
        const inner: unknown = JSON.parse(row[2]);
        if (Array.isArray(inner) && typeof inner[1] === "string") {
          const articleUrl = safePublisherUrl(inner[1]);
          if (articleUrl) return articleUrl;
        }
      }
    } catch {
      // Google changed the envelope; preserve the original RSS link.
    }
  }
  return null;
}

export async function resolveGoogleNewsArticleUrl(
  originalUrl: string,
  options: GoogleNewsResolutionOptions = {},
): Promise<string | null> {
  if (!isGoogleNewsArticleUrl(originalUrl)) return null;
  const id = ARTICLE_PATH.exec(new URL(originalUrl).pathname)?.[1];
  if (!id) return null;
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4_000;

  // The signature and timestamp are per-article. Do not cache or guess them.
  const html = await getText(request, `https://news.google.com/articles/${id}`, {
    method: "GET",
    headers: { accept: "text/html,application/xhtml+xml" },
  }, timeoutMs);
  if (!html) return null;
  const signature = attribute(html, "data-n-a-sg");
  const timestamp = attribute(html, "data-n-a-ts");
  if (!signature || !timestamp || !/^\d{6,14}$/u.test(timestamp)) return null;

  const rpcInput = JSON.stringify([
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    id,
    Number(timestamp),
    signature,
  ]);
  const body = new URLSearchParams({ "f.req": JSON.stringify([[["Fbv4je", rpcInput]]]) });
  const result = await getText(request, GOOGLE_RPC_URL, {
    method: "POST",
    headers: {
      accept: "*/*",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
  }, timeoutMs);
  return result ? parseRpcPublisherUrl(result) : null;
}
