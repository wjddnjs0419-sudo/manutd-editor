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

export type MediaAssetType = "IMAGE" | "CAROUSEL_CHILD" | "THUMBNAIL";

export interface NormalizedMediaAsset {
  externalMediaId: string;
  assetType: MediaAssetType;
  carouselIndex: number | null;
  originalMediaUrl: string;
}

export interface PendingMediaAsset {
  mediaAssetId: string;
  rawPostId: string;
  externalMediaId: string;
  assetType: MediaAssetType;
  carouselIndex: number | null;
  originalMediaUrl: string;
}

export interface PreparedMediaAsset {
  rawPostId: string;
  externalMediaId: string;
  assetType: MediaAssetType;
  carouselIndex: number | null;
  originalMediaUrl: string;
}

export type StoredImageMime =
  | "image/jpeg"
  | "image/png"
  | "image/webp"
  | "image/gif";

export interface StoredMediaAsset {
  mediaAssetId: string;
  storagePath: string;
  mimeType: StoredImageMime;
  fetchedAt: string;
}

export interface MediaStorage {
  store(
    asset: PendingMediaAsset,
    context: {
      sourceAccountId: string;
      externalPostId: string;
      fetchedAt: Date;
      signal: AbortSignal;
    },
  ): Promise<StoredMediaAsset>;
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
  assets: NormalizedMediaAsset[];
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

export interface MediaAssetRepository {
  prepareMediaAssets(
    sourceAccountId: string,
    assets: PreparedMediaAsset[],
  ): Promise<PendingMediaAsset[]>;
  finalizeMediaAssets(
    sourceAccountId: string,
    assets: StoredMediaAsset[],
  ): Promise<number>;
}

export interface MediaWorkItem {
  sourceAccountId: string;
  batch: NormalizedBatch;
  ingestedPosts: IngestedPost[];
}

export interface CoreCollectionResult {
  summary: CollectionSummary;
  mediaWork: MediaWorkItem;
}
