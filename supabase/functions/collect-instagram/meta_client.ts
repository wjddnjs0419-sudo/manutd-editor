import type { AccountFailureCategory, MetaClient } from "./types.ts";

export type MetaErrorCode =
  | "META_HTTP_ERROR"
  | "META_NETWORK_ERROR"
  | "META_INVALID_RESPONSE";

export class MetaApiError extends Error {
  constructor(
    readonly code: MetaErrorCode,
    readonly status: number | null,
    readonly retriable: boolean,
    readonly category: AccountFailureCategory,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = "MetaApiError";
  }
}

export interface MetaClientConfig {
  accessToken: string;
  businessAccountId: string;
  apiVersion: string;
  mediaLimit: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}

const maxAttempts = 3;
const maxResponseBytes = 5_000_000;
const maxErrorResponseBytes = 65_536;

interface SafeMetaErrorFields {
  code?: number;
  errorSubcode?: number;
  type?: string;
}

function retryDelay(
  response: Response | null,
  attempt: number,
  random: () => number,
): number {
  const retryAfter = response?.headers.get("retry-after");
  if (
    retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== ""
  ) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1_000);
    }
  }
  return 500 * 2 ** (attempt - 1) + Math.floor(random() * 250);
}

async function decodeSuccess(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length > maxResponseBytes) {
    throw new MetaApiError(
      "META_INVALID_RESPONSE",
      response.status,
      false,
      "invalid_payload",
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new MetaApiError(
      "META_INVALID_RESPONSE",
      response.status,
      false,
      "invalid_payload",
    );
  }
}

async function readErrorFields(
  response: Response,
): Promise<SafeMetaErrorFields> {
  if (!response.body) return {};

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxErrorResponseBytes) {
        await reader.cancel();
        return {};
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return {};
  }

  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || !("error" in value)) {
      return {};
    }
    const error = (value as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return {};
    const fields = error as Record<string, unknown>;
    return {
      code: typeof fields.code === "number" ? fields.code : undefined,
      errorSubcode: typeof fields.error_subcode === "number"
        ? fields.error_subcode
        : undefined,
      type: typeof fields.type === "string" ? fields.type : undefined,
    };
  } catch {
    return {};
  }
}

function errorCategory(
  status: number,
  fields: SafeMetaErrorFields,
): AccountFailureCategory {
  if (status === 429 || [4, 17, 32, 613].includes(fields.code ?? -1)) {
    return "rate_limited";
  }
  if (
    status === 401 || status === 403 ||
    [10, 190, 200].includes(fields.code ?? -1)
  ) {
    return "permission";
  }
  if (fields.code === 100) return "unsupported_account";
  if (status >= 500) return "temporary_upstream";
  return "invalid_payload";
}

function abortedError(): MetaApiError {
  return new MetaApiError(
    "META_NETWORK_ERROR",
    null,
    false,
    "temporary_upstream",
  );
}

function fields(username: string, mediaLimit: number): string {
  return [
    `business_discovery.username(${username}){`,
    "id,username,followers_count,",
    `media.limit(${mediaLimit}){`,
    "id,caption,permalink,media_type,media_product_type,timestamp,",
    "like_count,comments_count,views,media_url,thumbnail_url,",
    "children{id,media_type,media_url,thumbnail_url}",
    "}}",
  ].join("");
}

export function createMetaClient(config: MetaClientConfig): MetaClient {
  if (!config.accessToken || !config.businessAccountId || !config.apiVersion) {
    throw new Error("Meta client configuration is incomplete");
  }
  if (
    !Number.isInteger(config.mediaLimit) || config.mediaLimit < 1 ||
    config.mediaLimit > 100
  ) {
    throw new Error("Meta media limit must be between 1 and 100");
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = config.random ?? Math.random;

  return {
    async fetchAccount(
      username: string,
      options?: { signal?: AbortSignal },
    ): Promise<unknown> {
      if (!/^[A-Za-z0-9._]+$/.test(username)) {
        throw new MetaApiError(
          "META_INVALID_RESPONSE",
          null,
          false,
          "invalid_payload",
        );
      }

      const url = new URL(
        `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${
          encodeURIComponent(config.businessAccountId)
        }`,
      );
      url.searchParams.set("fields", fields(username, config.mediaLimit));
      url.searchParams.set("access_token", config.accessToken);

      let lastError: MetaApiError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw abortedError();

        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "GET",
            signal: options?.signal,
          });
        } catch (error) {
          if (
            options?.signal?.aborted ||
            (error instanceof DOMException && error.name === "AbortError")
          ) {
            throw abortedError();
          }
          lastError = new MetaApiError(
            "META_NETWORK_ERROR",
            null,
            true,
            "temporary_upstream",
          );
          if (attempt === maxAttempts) throw lastError;
          if (options?.signal?.aborted) throw abortedError();
          await sleep(retryDelay(null, attempt, random));
          continue;
        }

        if (response.ok) {
          return await decodeSuccess(response);
        }

        const safeFields = await readErrorFields(response);
        const category = errorCategory(response.status, safeFields);
        const retriable = category === "rate_limited" ||
          category === "temporary_upstream";
        lastError = new MetaApiError(
          "META_HTTP_ERROR",
          response.status,
          retriable,
          category,
        );
        if (!retriable || attempt === maxAttempts) throw lastError;
        if (options?.signal?.aborted) throw abortedError();
        await sleep(retryDelay(response, attempt, random));
      }

      throw lastError ?? new MetaApiError(
        "META_NETWORK_ERROR",
        null,
        true,
        "temporary_upstream",
      );
    },
  };
}
