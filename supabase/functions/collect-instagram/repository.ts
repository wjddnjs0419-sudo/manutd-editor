import type {
  AccountRepository,
  IngestedPost,
  IngestRepository,
  IngestResult,
  JsonObject,
  NormalizedBatch,
  SourceAccount,
} from "./types.ts";

export type RepositoryErrorCode =
  | "DATABASE_HTTP_ERROR"
  | "DATABASE_NETWORK_ERROR"
  | "DATABASE_INVALID_RESPONSE";

export class RepositoryError extends Error {
  constructor(
    readonly code: RepositoryErrorCode,
    readonly status: number | null,
    readonly retriable: boolean,
  ) {
    super(status === null ? code : `${code} (${status})`);
    this.name = "RepositoryError";
  }
}

export interface IngestRepositoryConfig {
  supabaseUrl: string;
  secretKey: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type InstagramRepository = IngestRepository & AccountRepository;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestBody(
  sourceAccountId: string,
  batch: NormalizedBatch,
): JsonObject {
  return {
    p_source_account_id: sourceAccountId,
    p_account: {
      instagram_account_id: batch.account.instagramAccountId,
      followers_count: batch.account.followersCount,
      followers_available: batch.account.capabilities.followersAvailable,
      likes_available: batch.account.capabilities.likesAvailable,
      comments_available: batch.account.capabilities.commentsAvailable,
      views_available: batch.account.capabilities.viewsAvailable,
      media_url_available: batch.account.capabilities.mediaUrlAvailable,
      carousel_children_available:
        batch.account.capabilities.carouselChildrenAvailable,
    },
    p_posts: batch.posts.map((post) => ({
      external_post_id: post.externalPostId,
      caption: post.caption,
      permalink: post.permalink,
      media_type: post.mediaType,
      media_product_type: post.mediaProductType,
      published_at: post.publishedAt,
      like_count: post.likeCount,
      comments_count: post.commentsCount,
      view_count: post.viewCount,
      followers_count_at_collection: post.followersCountAtCollection,
      post_age_minutes: post.postAgeMinutes,
      raw_payload: post.rawPayload,
    })),
    p_collected_at: batch.collectedAt,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
}

function invalidResponse(status: number): RepositoryError {
  return new RepositoryError("DATABASE_INVALID_RESPONSE", status, false);
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    throw invalidResponse(response.status);
  }
}

function decodeSourceAccount(value: unknown, status: number): SourceAccount {
  if (
    !isObject(value) || typeof value.id !== "string" ||
    !UUID_PATTERN.test(value.id) || typeof value.username !== "string" ||
    value.username.trim() === "" || value.active !== true
  ) {
    throw invalidResponse(status);
  }
  return { id: value.id, username: value.username };
}

async function decodeAccounts(response: Response): Promise<SourceAccount[]> {
  const value = await parseJson(response);
  if (!Array.isArray(value)) throw invalidResponse(response.status);
  return value.map((account) => decodeSourceAccount(account, response.status));
}

function decodeIngestedPost(value: unknown, status: number): IngestedPost {
  if (
    !isObject(value) || typeof value.external_post_id !== "string" ||
    value.external_post_id.trim() === "" ||
    typeof value.raw_post_id !== "string" ||
    !UUID_PATTERN.test(value.raw_post_id)
  ) {
    throw invalidResponse(status);
  }
  return {
    externalPostId: value.external_post_id,
    rawPostId: value.raw_post_id,
  };
}

async function decodeResult(response: Response): Promise<IngestResult> {
  const value = await parseJson(response);
  if (
    !isObject(value) || typeof value.account_id !== "string" ||
    !UUID_PATTERN.test(value.account_id) || !Array.isArray(value.posts)
  ) {
    throw invalidResponse(response.status);
  }

  const insertedPosts = requiredCount(value.inserted_posts);
  const updatedPosts = requiredCount(value.updated_posts);
  const insertedSnapshots = requiredCount(value.inserted_snapshots);
  if (
    insertedPosts === null || updatedPosts === null ||
    insertedSnapshots === null
  ) {
    throw invalidResponse(response.status);
  }

  return {
    accountId: value.account_id,
    insertedPosts,
    updatedPosts,
    insertedSnapshots,
    posts: value.posts.map((post) => decodeIngestedPost(post, response.status)),
  };
}

export function createIngestRepository(
  config: IngestRepositoryConfig,
): InstagramRepository {
  if (!config.supabaseUrl || !config.secretKey) {
    throw new Error("Ingest repository configuration is incomplete");
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = config.supabaseUrl.replace(/\/$/, "");

  async function request(path: string, init: RequestInit): Promise<Response> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          ...init,
          headers: {
            apikey: config.secretKey,
            ...init.headers,
          },
        });
      } catch {
        const error = new RepositoryError(
          "DATABASE_NETWORK_ERROR",
          null,
          true,
        );
        if (attempt === 2) throw error;
        await sleep(250);
        continue;
      }

      if (response.ok) return response;

      const retriable = response.status >= 500;
      const error = new RepositoryError(
        "DATABASE_HTTP_ERROR",
        response.status,
        retriable,
      );
      await response.body?.cancel();
      if (!retriable || attempt === 2) throw error;
      await sleep(250);
    }

    throw new RepositoryError("DATABASE_NETWORK_ERROR", null, true);
  }

  return {
    async listActive(): Promise<SourceAccount[]> {
      const query = new URLSearchParams({
        select: "id,username,active",
        active: "eq.true",
        order: "username.asc",
      });
      const response = await request(
        `/rest/v1/source_accounts?${query.toString()}`,
        { method: "GET" },
      );
      return await decodeAccounts(response);
    },

    async ingest(
      sourceAccountId: string,
      batch: NormalizedBatch,
    ): Promise<IngestResult> {
      const response = await request(
        "/rest/v1/rpc/ingest_instagram_account_batch",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(requestBody(sourceAccountId, batch)),
        },
      );
      return await decodeResult(response);
    },

    async recordFailure(input): Promise<void> {
      const response = await request(
        "/rest/v1/rpc/record_instagram_probe_failure",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            p_source_account_id: input.sourceAccountId,
            p_probed_at: input.probedAt,
            p_category: input.category,
            p_mark_unsupported: input.markUnsupported,
          }),
        },
      );
      await response.body?.cancel();
    },
  };
}
