export type JsonObject = Record<string, unknown>;

export interface SourceAccount {
  id: string;
  username: string;
}

export type AccountFailureCategory =
  | "unsupported_account"
  | "permission"
  | "rate_limited"
  | "temporary_upstream"
  | "invalid_payload"
  | "database"
  | "run_budget_exhausted"
  | "internal";

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
  posts: IngestedPost[];
}

export interface IngestedPost {
  externalPostId: string;
  rawPostId: string;
}

export interface CollectionSummary extends IngestResult {
  username: string;
  receivedMedia: number;
  deduplicatedMedia: number;
}

export interface AccountCollectionResult {
  sourceAccountId: string;
  status: "success" | "failed";
  errorCategory?: AccountFailureCategory;
  insertedPosts: number;
  updatedPosts: number;
  insertedSnapshots: number;
  assetsStored: number;
  assetsFailed: number;
}

export interface CollectionRunSummary {
  accountsRequested: number;
  accountsSuccess: number;
  accountsFailed: number;
  postsCreated: number;
  postsUpdated: number;
  snapshotsCreated: number;
  assetsStored: number;
  assetsFailed: number;
  accounts: AccountCollectionResult[];
}

export interface MetaClient {
  fetchAccount(
    username: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface IngestRepository {
  ingest(
    sourceAccountId: string,
    batch: NormalizedBatch,
  ): Promise<IngestResult>;
}

export interface AccountRepository {
  listActive(): Promise<SourceAccount[]>;
  recordFailure(input: {
    sourceAccountId: string;
    probedAt: string;
    category: AccountFailureCategory;
    markUnsupported: boolean;
  }): Promise<void>;
}
