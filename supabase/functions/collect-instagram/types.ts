export type JsonObject = Record<string, unknown>;

export interface AccountCapabilities {
  followersAvailable: boolean;
  likesAvailable: boolean;
  commentsAvailable: boolean;
  viewsAvailable: boolean;
  mediaUrlAvailable: boolean;
  carouselChildrenAvailable: boolean;
}

export interface NormalizedAccount {
  instagramAccountId: string;
  followersCount: number | null;
  capabilities: AccountCapabilities;
}

export interface NormalizedPost {
  externalPostId: string;
  caption: string | null;
  permalink: string | null;
  mediaType: "IMAGE" | "CAROUSEL_ALBUM" | "VIDEO";
  mediaProductType: "REELS" | null;
  publishedAt: string;
  likeCount: number | null;
  commentsCount: number | null;
  viewCount: number | null;
  followersCountAtCollection: number | null;
  postAgeMinutes: number;
  rawPayload: JsonObject;
}

export interface NormalizedBatch {
  username: string;
  account: NormalizedAccount;
  posts: NormalizedPost[];
  collectedAt: string;
  receivedMedia: number;
}

export interface IngestResult {
  accountId: string;
  insertedPosts: number;
  updatedPosts: number;
  insertedSnapshots: number;
}

export interface CollectionSummary extends IngestResult {
  username: string;
  receivedMedia: number;
  deduplicatedMedia: number;
}

export interface MetaClient {
  fetchAccount(username: string): Promise<unknown>;
}

export interface IngestRepository {
  ingest(batch: NormalizedBatch): Promise<IngestResult>;
}
