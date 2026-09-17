import type {
  AccountCapabilities,
  JsonObject,
  NormalizedBatch,
  NormalizedPost,
} from "./types.ts";

export type ValidationErrorCode =
  | "INVALID_PAYLOAD"
  | "USERNAME_MISMATCH"
  | "INVALID_FIELD"
  | "UNSUPPORTED_MEDIA";

export class ValidationError extends Error {
  constructor(
    readonly code: ValidationErrorCode,
    readonly field: string,
    readonly itemId?: string,
  ) {
    super(itemId ? `${code}: ${field} (${itemId})` : `${code}: ${field}`);
    this.name = "ValidationError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireObject(
  value: unknown,
  field: string,
  itemId?: string,
): JsonObject {
  if (!isObject(value)) {
    throw new ValidationError("INVALID_PAYLOAD", field, itemId);
  }
  return value;
}

function requireString(value: unknown, field: string, itemId?: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("INVALID_FIELD", field, itemId);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  itemId?: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("INVALID_FIELD", field, itemId);
  }
  return value;
}

function optionalCount(
  value: unknown,
  field: string,
  itemId?: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ValidationError("INVALID_FIELD", field, itemId);
  }
  return value as number;
}

function normalizePost(
  value: unknown,
  followersCount: number | null,
  collectedAt: Date,
): NormalizedPost {
  const media = requireObject(value, "media");
  const externalPostId = requireString(media.id, "id");
  const mediaType = requireString(
    media.media_type,
    "media_type",
    externalPostId,
  );
  const mediaProductType = optionalString(
    media.media_product_type,
    "media_product_type",
    externalPostId,
  );

  if (
    mediaType !== "IMAGE" && mediaType !== "CAROUSEL_ALBUM" &&
    mediaType !== "VIDEO"
  ) {
    throw new ValidationError(
      "UNSUPPORTED_MEDIA",
      "media_type",
      externalPostId,
    );
  }
  if (mediaType === "VIDEO" && mediaProductType !== "REELS") {
    throw new ValidationError(
      "UNSUPPORTED_MEDIA",
      "media_product_type",
      externalPostId,
    );
  }

  const timestamp = requireString(media.timestamp, "timestamp", externalPostId);
  const publishedAt = new Date(timestamp);
  if (
    Number.isNaN(publishedAt.getTime()) ||
    publishedAt.getTime() > collectedAt.getTime()
  ) {
    throw new ValidationError("INVALID_FIELD", "timestamp", externalPostId);
  }

  const postAgeMinutes = Math.floor(
    (collectedAt.getTime() - publishedAt.getTime()) / 60_000,
  );

  return {
    externalPostId,
    caption: optionalString(media.caption, "caption", externalPostId),
    permalink: optionalString(media.permalink, "permalink", externalPostId),
    mediaType,
    mediaProductType: mediaType === "VIDEO" ? "REELS" : null,
    publishedAt: publishedAt.toISOString(),
    likeCount: optionalCount(media.like_count, "like_count", externalPostId),
    commentsCount: optionalCount(
      media.comments_count,
      "comments_count",
      externalPostId,
    ),
    viewCount: optionalCount(media.views, "views", externalPostId),
    followersCountAtCollection: followersCount,
    postAgeMinutes,
    rawPayload: media,
  };
}

function capabilities(
  mediaItems: JsonObject[],
  followersCount: number | null,
): AccountCapabilities {
  return {
    followersAvailable: followersCount !== null,
    likesAvailable: mediaItems.length > 0 &&
      mediaItems.every((item) => item.like_count != null),
    commentsAvailable: mediaItems.length > 0 &&
      mediaItems.every((item) => item.comments_count != null),
    viewsAvailable: mediaItems.some((item) => item.views != null),
    mediaUrlAvailable: mediaItems.some(
      (item) =>
        typeof item.media_url === "string" ||
        typeof item.thumbnail_url === "string",
    ),
    carouselChildrenAvailable: mediaItems.some(
      (item) => item.media_type === "CAROUSEL_ALBUM" && isObject(item.children),
    ),
  };
}

export function normalizeBusinessDiscovery(
  payload: unknown,
  expectedUsername: string,
  collectedAt: Date,
): NormalizedBatch {
  if (Number.isNaN(collectedAt.getTime())) {
    throw new ValidationError("INVALID_FIELD", "collectedAt");
  }

  const root = requireObject(payload, "payload");
  const discovery = requireObject(
    root.business_discovery,
    "business_discovery",
  );
  const instagramAccountId = requireString(discovery.id, "id");
  const username = requireString(discovery.username, "username");
  if (
    username.toLocaleLowerCase("en-US") !==
      expectedUsername.toLocaleLowerCase("en-US")
  ) {
    throw new ValidationError("USERNAME_MISMATCH", "username");
  }

  const followersCount = optionalCount(
    discovery.followers_count,
    "followers_count",
  );
  const media = requireObject(discovery.media, "media");
  if (!Array.isArray(media.data)) {
    throw new ValidationError("INVALID_PAYLOAD", "media.data");
  }

  const normalized = media.data.map((item) =>
    normalizePost(item, followersCount, collectedAt)
  );
  const postsById = new Map<string, NormalizedPost>();
  for (const post of normalized) {
    if (!postsById.has(post.externalPostId)) {
      postsById.set(post.externalPostId, post);
    }
  }

  const mediaItems = media.data.map((item) => requireObject(item, "media"));
  return {
    username: expectedUsername,
    account: {
      instagramAccountId,
      followersCount,
      capabilities: capabilities(mediaItems, followersCount),
    },
    posts: [...postsById.values()],
    collectedAt: collectedAt.toISOString(),
    receivedMedia: media.data.length,
  };
}
