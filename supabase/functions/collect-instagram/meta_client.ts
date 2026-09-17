import type { MetaClient } from './types.ts';

export type MetaErrorCode =
  | 'META_HTTP_ERROR'
  | 'META_NETWORK_ERROR'
  | 'META_INVALID_RESPONSE';

export class MetaApiError extends Error {
  constructor(
    readonly code: MetaErrorCode,
    readonly status: number | null,
    readonly retriable: boolean,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = 'MetaApiError';
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

function retryDelay(response: Response | null, attempt: number, random: () => number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter !== null && retryAfter !== undefined && retryAfter.trim() !== '') {
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
    throw new MetaApiError('META_INVALID_RESPONSE', response.status, false);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new MetaApiError('META_INVALID_RESPONSE', response.status, false);
  }
}

function fields(username: string, mediaLimit: number): string {
  return [
    `business_discovery.username(${username}){`,
    'id,username,followers_count,',
    `media.limit(${mediaLimit}){`,
    'id,caption,permalink,media_type,media_product_type,timestamp,',
    'like_count,comments_count,views,media_url,thumbnail_url,',
    'children{id,media_type,media_url,thumbnail_url}',
    '}}',
  ].join('');
}

export function createMetaClient(config: MetaClientConfig): MetaClient {
  if (!config.accessToken || !config.businessAccountId || !config.apiVersion) {
    throw new Error('Meta client configuration is incomplete');
  }
  if (!Number.isInteger(config.mediaLimit) || config.mediaLimit < 1 || config.mediaLimit > 100) {
    throw new Error('Meta media limit must be between 1 and 100');
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = config.random ?? Math.random;

  return {
    async fetchAccount(username: string): Promise<unknown> {
      if (!/^[A-Za-z0-9._]+$/.test(username)) {
        throw new MetaApiError('META_INVALID_RESPONSE', null, false);
      }

      const url = new URL(
        `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${
          encodeURIComponent(config.businessAccountId)
        }`,
      );
      url.searchParams.set('fields', fields(username, config.mediaLimit));
      url.searchParams.set('access_token', config.accessToken);

      let lastError: MetaApiError | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(url, { method: 'GET' });
        } catch {
          lastError = new MetaApiError('META_NETWORK_ERROR', null, true);
          if (attempt === maxAttempts) throw lastError;
          await sleep(retryDelay(null, attempt, random));
          continue;
        }

        if (response.ok) {
          return await decodeSuccess(response);
        }

        const retriable = response.status === 429 || response.status >= 500;
        lastError = new MetaApiError('META_HTTP_ERROR', response.status, retriable);
        await response.body?.cancel();
        if (!retriable || attempt === maxAttempts) throw lastError;
        await sleep(retryDelay(response, attempt, random));
      }

      throw lastError ?? new MetaApiError('META_NETWORK_ERROR', null, true);
    },
  };
}
