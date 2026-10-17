const MAX_REQUEST_BYTES = 800_000;
const MAX_BATCH_SIZE = 30;
const MAX_COOLDOWN_SECONDS = 21_600;
const ARTICLE_EXCERPT_LIMIT = 2_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DNS_HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u;
const REQUEST_ID = /^[A-Za-z0-9:._-]{8,128}$/u;
const URL_STATUS = new Set(["RESOLVED", "FAILED", "RATE_LIMITED", "EXCLUDED"]);
const FETCH_STATUS = new Set([
  "NOT_ATTEMPTED", "FETCHED", "FAILED", "ACCESS_RESTRICTED",
  "BODY_TOO_LARGE", "RATE_LIMITED", "UNSUPPORTED_CONTENT", "REDIRECT_REJECTED",
]);
const EXTRACTION_STATUS = new Set([
  "NOT_ATTEMPTED", "EXTRACTED", "EMPTY_BODY", "TITLE_NOT_RELEVANT",
]);
const SAFE_ERRORS = new Set([
  "GOOGLE_HTTP_429", "GOOGLE_DECODER_FAILURE", "INVALID_GOOGLE_NEWS_URL",
  "INVALID_PUBLISHER_URL", "NON_ARTICLE_VIDEO", "PUBLISHER_HTTP_403",
  "PUBLISHER_HTTP_429", "PUBLISHER_PAYWALL", "PUBLISHER_BODY_TOO_LARGE",
  "TITLE_NOT_RELEVANT", "NO_ARTICLE_BODY", "UNSUPPORTED_CONTENT_TYPE",
  "PUBLISHER_REDIRECT_REJECTED", "PUBLISHER_NETWORK_ERROR", "PUBLISHER_HTTP_ERROR",
  "PUBLISHER_HTTP_401", "PUBLISHER_HTTP_402", "PUBLISHER_HTTP_407",
  "PUBLISHER_HTTP_451",
  "WORKER_LEASE_EXPIRED",
  "WORKER_ATTEMPT_LIMIT",
]);

export interface GnewsResolverApiOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly workerToken: string;
  readonly enabled: boolean;
  readonly fetch?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

function json(body: JsonObject, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secureEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function boundedJson(request: Request): Promise<JsonObject | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return object(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function publisherUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 12 || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443") || !host.includes(".") ||
      host.startsWith("[") || !DNS_HOSTNAME.test(host) || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) ||
      host === "localhost" || /\.(?:localhost|local|internal|invalid|test)$/u.test(host) ||
      host === "google.com" || host.endsWith(".google.com") || host.startsWith("google.") ||
      host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") ||
      host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" || host.endsWith(".youtube-nocookie.com")
    ) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

type ResultValidation =
  | { readonly result: JsonObject; readonly reason: null }
  | { readonly result: null; readonly reason: string };

function invalidResult(reason: string): ResultValidation {
  return { result: null, reason };
}

function validateResult(value: unknown): ResultValidation {
  if (!object(value)) return invalidResult("INVALID_RESULT_OBJECT");
  if (typeof value.id !== "string" || !UUID.test(value.id)) return invalidResult("INVALID_RESULT_ID");
  if (
    typeof value.url_resolution_status !== "string" ||
    !URL_STATUS.has(value.url_resolution_status) ||
    typeof value.article_fetch_status !== "string" ||
    !FETCH_STATUS.has(value.article_fetch_status) ||
    typeof value.article_extraction_status !== "string" ||
    !EXTRACTION_STATUS.has(value.article_extraction_status)
  ) return invalidResult("INVALID_RESULT_STATUS");
  if (value.safe_error_category !== null &&
    (typeof value.safe_error_category !== "string" || !SAFE_ERRORS.has(value.safe_error_category))) {
    return invalidResult("INVALID_RESULT_ERROR_CATEGORY");
  }
  const resolution = value.url_resolution_status;
  const resolved = resolution === "RESOLVED" ? publisherUrl(value.resolved_publisher_url) : null;
  if (resolution === "RESOLVED" && !resolved) return invalidResult("UNSAFE_RESOLVED_PUBLISHER_URL");
  if (resolution !== "RESOLVED" && value.resolved_publisher_url !== null) {
    return invalidResult("PUBLISHER_URL_WITHOUT_RESOLUTION");
  }
  const finalUrl = value.article_final_url === null ? null : publisherUrl(value.article_final_url);
  if (value.article_final_url !== null && !finalUrl) return invalidResult("UNSAFE_ARTICLE_FINAL_URL");
  const excerpt = value.article_content_excerpt;
  if (excerpt !== null && (typeof excerpt !== "string" || excerpt.length > ARTICLE_EXCERPT_LIMIT)) {
    return invalidResult("INVALID_ARTICLE_EXCERPT");
  }
  if (value.article_extraction_status === "EXTRACTED" &&
    (typeof excerpt !== "string" || excerpt.trim() === "")) {
    return invalidResult("EMPTY_EXTRACTED_ARTICLE_BODY");
  }
  if (value.article_extraction_status !== "EXTRACTED" && excerpt !== null) {
    return invalidResult("EXCERPT_WITHOUT_EXTRACTION");
  }
  if (resolution !== "RESOLVED" && (
    value.article_fetch_status !== "NOT_ATTEMPTED" ||
    value.article_extraction_status !== "NOT_ATTEMPTED" ||
    value.article_final_url !== null || excerpt !== null
  )) return invalidResult("ARTICLE_FETCH_WITHOUT_RESOLUTION");
  return {
    reason: null,
    result: {
      id: value.id,
      url_resolution_status: resolution,
      resolved_publisher_url: resolved,
      article_fetch_status: value.article_fetch_status,
      article_extraction_status: value.article_extraction_status,
      article_final_url: finalUrl,
      article_content_excerpt: excerpt,
      safe_error_category: value.safe_error_category,
    },
  };
}

function validateClaimResponse(value: unknown): JsonObject | null {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > MAX_BATCH_SIZE) return null;
  const items: JsonObject[] = [];
  for (const raw of value.items) {
    if (!object(raw) || typeof raw.id !== "string" || !UUID.test(raw.id) ||
      typeof raw.google_article_id !== "string" || !/^[A-Za-z0-9_-]{1,2000}$/u.test(raw.google_article_id) ||
      typeof raw.original_google_news_url !== "string" || raw.original_google_news_url.length > 2_000 ||
      typeof raw.title !== "string" || raw.title.length > 500 ||
      typeof raw.source_canonical_name !== "string" || raw.source_canonical_name.length > 160 ||
      !(raw.published_at === null || typeof raw.published_at === "string" && Number.isFinite(Date.parse(raw.published_at)))) return null;
    try {
      const original = new URL(raw.original_google_news_url);
      const match = /^\/rss\/articles\/([A-Za-z0-9_-]{1,2000})\/?$/u.exec(original.pathname);
      if (original.protocol !== "https:" || original.hostname !== "news.google.com" ||
        original.username || original.password || original.port && original.port !== "443" ||
        !match || match[1] !== raw.google_article_id) return null;
    } catch {
      return null;
    }
    items.push({
      id: raw.id,
      google_article_id: raw.google_article_id,
      original_google_news_url: raw.original_google_news_url,
      title: raw.title,
      source_canonical_name: raw.source_canonical_name,
      published_at: raw.published_at,
    });
  }
  if (new Set(items.map((item) => item.google_article_id)).size !== items.length ||
    new Set(items.map((item) => item.id)).size !== items.length) return null;
  const leaseId = value.lease_id;
  const leaseExpiresAt = value.lease_expires_at;
  if (items.length === 0) {
    if (leaseId !== null || leaseExpiresAt !== null) return null;
  } else if (typeof leaseId !== "string" || !UUID.test(leaseId) ||
    typeof leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(leaseExpiresAt))) return null;
  const cooldownUntil = value.cooldown_until;
  if (!(cooldownUntil === null || typeof cooldownUntil === "string" && Number.isFinite(Date.parse(cooldownUntil)))) return null;
  return { lease_id: leaseId, lease_expires_at: leaseExpiresAt, items, cooldown_until: cooldownUntil };
}

export function createGnewsResolverApiHandler(options: GnewsResolverApiOptions): (request: Request) => Promise<Response> {
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.fetch ?? fetch;

  async function callRpc(path: string, body: JsonObject): Promise<{ response: Response; value: unknown }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${path}`, {
        method: "POST",
        headers: {
          apikey: options.serviceRoleKey,
          authorization: `Bearer ${options.serviceRoleKey}`,
          "content-type": "application/json",
          accept: "application/json",
          "accept-profile": "app_private",
          "content-profile": "app_private",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      const text = await response.text();
      let value: unknown = null;
      if (text.trim()) {
        try { value = JSON.parse(text); } catch { value = null; }
      }
      return { response, value };
    } finally {
      clearTimeout(timeout);
    }
  }

  return async (request) => {
    if (request.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "POST" });
    if (!options.enabled) return json({ error: "RESOLVER_DISABLED" }, 503);
    const authorization = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${options.workerToken}`;
    if (!options.workerToken || !secureEqual(authorization, expected)) return json({ error: "UNAUTHORIZED" }, 401);
    if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) return json({ error: "REQUEST_TOO_LARGE" }, 413);
    const payload = await boundedJson(request);
    if (!payload) return json({ error: "INVALID_REQUEST_BODY" }, 400);
    if (typeof payload.request_id !== "string" || !REQUEST_ID.test(payload.request_id)) return json({ error: "INVALID_REQUEST_ID" }, 400);

    let rpcPath: string;
    let rpcBody: JsonObject;
    if (payload.action === "claim") {
      if (!Number.isInteger(payload.batch_size) || (payload.batch_size as number) < 1 || (payload.batch_size as number) > MAX_BATCH_SIZE) {
        return json({ error: "INVALID_BATCH_SIZE" }, 400);
      }
      const mode = payload.mode === undefined ? "recent" : payload.mode;
      if (mode !== "recent" && mode !== "backfill") return json({ error: "INVALID_MODE" }, 400);
      rpcPath = "gnews_resolver_claim_batch";
      rpcBody = {
        p_request_id: payload.request_id,
        p_batch_size: payload.batch_size,
        p_worker_id: "github-actions",
        p_mode: mode,
      };
    } else if (payload.action === "complete") {
      if (typeof payload.lease_id !== "string" || !UUID.test(payload.lease_id)) return json({ error: "INVALID_LEASE_ID" }, 400);
      if (!Array.isArray(payload.results)) return json({ error: "INVALID_RESULTS" }, 400);
      if (payload.results.length > MAX_BATCH_SIZE) {
        return json({ error: "INVALID_RESULTS", invalid_results: [{ index: null, reason: "RESULT_BATCH_TOO_LARGE" }] }, 400);
      }
      if (!Array.isArray(payload.unprocessed_ids) || payload.unprocessed_ids.length > MAX_BATCH_SIZE ||
        payload.unprocessed_ids.some((id) => typeof id !== "string" || !UUID.test(id)) ||
        new Set(payload.unprocessed_ids).size !== payload.unprocessed_ids.length) return json({ error: "INVALID_UNPROCESSED_IDS" }, 400);
      const unprocessedIds = payload.unprocessed_ids as string[];
      const validatedResults = payload.results.map(validateResult);
      const invalidResults = validatedResults.flatMap((validation, index) =>
        validation.result === null ? [{ index, reason: validation.reason }] : []
      );
      const results = validatedResults.flatMap((validation) =>
        validation.result === null ? [] : [validation.result]
      );
      if (invalidResults.length > 0) return json({ error: "INVALID_RESULTS", invalid_results: invalidResults.slice(0, 5) }, 400);
      if (new Set(results.map((result) => result.id)).size !== results.length) {
        return json({ error: "INVALID_RESULTS", invalid_results: [{ index: null, reason: "DUPLICATE_RESULT_ID" }] }, 400);
      }
      if (results.some((result) => result !== null && unprocessedIds.includes(String(result.id)))) return json({ error: "DUPLICATE_RESULT_ID" }, 400);
      const cooldown = payload.global_cooldown_seconds;
      if (!Number.isInteger(cooldown) || (cooldown as number) < 0 || (cooldown as number) > MAX_COOLDOWN_SECONDS) return json({ error: "INVALID_COOLDOWN" }, 400);
      const isRateLimited = results.some((result) =>
        (result?.url_resolution_status === "RATE_LIMITED" && result.safe_error_category === "GOOGLE_HTTP_429") ||
        (result?.article_fetch_status === "RATE_LIMITED" && result.safe_error_category === "PUBLISHER_HTTP_429")
      );
      if (isRateLimited !== ((cooldown as number) >= 60)) return json({ error: "INVALID_COOLDOWN_STATE" }, 400);
      rpcPath = "gnews_resolver_complete_batch";
      rpcBody = {
        p_request_id: payload.request_id,
        p_worker_id: "github-actions",
        p_lease_id: payload.lease_id,
        p_results: results,
        p_unprocessed_ids: unprocessedIds,
        p_global_cooldown_seconds: cooldown,
      };
    } else {
      return json({ error: "INVALID_ACTION" }, 400);
    }

    try {
      const { response, value } = await callRpc(rpcPath, rpcBody);
      if (response.status === 429 || (object(value) && value.rate_limited === true)) {
        const retry = object(value) && Number.isInteger(value.retry_after_seconds)
          ? Math.max(1, Math.min(3_600, value.retry_after_seconds as number))
          : 60;
        return json({ error: "RATE_LIMITED" }, 429, { "retry-after": String(retry) });
      }
      if (object(value) && (value.status === "LEASE_EXPIRED" || value.status === "IDEMPOTENCY_CONFLICT")) {
        return json({ error: value.status }, 409);
      }
      if (!response.ok) return json({ error: response.status === 409 ? "LEASE_CONFLICT" : "API_OPERATION_FAILED" }, response.status === 409 ? 409 : 502);
      if (rpcPath === "gnews_resolver_claim_batch") {
        const claim = validateClaimResponse(value);
        return claim ? json(claim) : json({ error: "API_INVALID_RESPONSE" }, 502);
      }
      if (!object(value)) return json({ error: "API_INVALID_RESPONSE" }, 502);
      return json(value);
    } catch {
      return json({ error: "API_UNAVAILABLE" }, 502);
    }
  };
}
