import type {
  IngestRepository,
  IngestResult,
  JsonObject,
  NormalizedBatch,
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

function requestBody(batch: NormalizedBatch): JsonObject {
  return {
    p_username: batch.username,
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

async function decodeResult(response: Response): Promise<IngestResult> {
  let value: unknown;
  try {
    value = JSON.parse(await response.text());
  } catch {
    throw new RepositoryError(
      "DATABASE_INVALID_RESPONSE",
      response.status,
      false,
    );
  }
  if (
    !isObject(value) || typeof value.account_id !== "string" ||
    value.account_id === ""
  ) {
    throw new RepositoryError(
      "DATABASE_INVALID_RESPONSE",
      response.status,
      false,
    );
  }

  const insertedPosts = requiredCount(value.inserted_posts);
  const updatedPosts = requiredCount(value.updated_posts);
  const insertedSnapshots = requiredCount(value.inserted_snapshots);
  if (
    insertedPosts === null || updatedPosts === null ||
    insertedSnapshots === null
  ) {
    throw new RepositoryError(
      "DATABASE_INVALID_RESPONSE",
      response.status,
      false,
    );
  }

  return {
    accountId: value.account_id,
    insertedPosts,
    updatedPosts,
    insertedSnapshots,
  };
}

export function createIngestRepository(
  config: IngestRepositoryConfig,
): IngestRepository {
  if (!config.supabaseUrl || !config.secretKey) {
    throw new Error("Ingest repository configuration is incomplete");
  }

  const fetchImpl = config.fetch ?? globalThis.fetch;
  const sleep = config.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const url = `${
    config.supabaseUrl.replace(/\/$/, "")
  }/rest/v1/rpc/ingest_instagram_batch`;

  return {
    async ingest(batch: NormalizedBatch): Promise<IngestResult> {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: "POST",
            headers: {
              apikey: config.secretKey,
              "content-type": "application/json",
            },
            body: JSON.stringify(requestBody(batch)),
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

        if (response.ok) {
          return await decodeResult(response);
        }

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
    },
  };
}
