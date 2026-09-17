import type { SupabaseClient } from "npm:@supabase/supabase-js@2.116.0";
import type {
  MediaStorage,
  StoredImageMime,
  StoredMediaAsset,
} from "./types.ts";

export type MediaStorageErrorCategory =
  | "invalid_url"
  | "invalid_path"
  | "download"
  | "invalid_mime"
  | "too_large"
  | "aborted"
  | "upload";

export class MediaStorageError extends Error {
  constructor(
    readonly category: MediaStorageErrorCategory,
    readonly statusClass: string | null,
    readonly retriable: boolean,
  ) {
    super(`MEDIA_STORAGE_${category.toUpperCase()}`);
    this.name = "MediaStorageError";
  }
}

interface StorageUploadError {
  statusCode?: string | number;
  message?: string;
}

export interface MediaStorageClient {
  from(bucket: string): {
    upload(
      path: string,
      body: Uint8Array,
      options: {
        contentType: string;
        cacheControl: string;
        upsert: boolean;
      },
    ): Promise<{ error: StorageUploadError | null }>;
  };
}

export function storageClientFromSupabase(
  client: SupabaseClient,
): MediaStorageClient {
  return client.storage as unknown as MediaStorageClient;
}

export interface MediaStorageConfig {
  bucket: string;
  maxBytes: number;
  storageClient: MediaStorageClient;
  fetch?: typeof globalThis.fetch;
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const META_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const extensionByMime: Record<StoredImageMime, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function statusClass(status: number | null): string | null {
  return status === null ? null : `${Math.floor(status / 100)}xx`;
}

function mediaError(
  category: MediaStorageErrorCategory,
  status: number | null = null,
  retriable = false,
): MediaStorageError {
  return new MediaStorageError(category, statusClass(status), retriable);
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError");
}

function safeMetaId(value: string): boolean {
  return META_ID_PATTERN.test(value) && !value.includes("..") &&
    value !== ".";
}

function storagePath(
  sourceAccountId: string,
  externalPostId: string,
  externalMediaId: string,
  extension: string,
): string {
  if (
    !UUID_PATTERN.test(sourceAccountId) || !safeMetaId(externalPostId) ||
    !safeMetaId(externalMediaId)
  ) {
    throw mediaError("invalid_path");
  }
  return `instagram/${sourceAccountId}/${externalPostId}/${externalMediaId}.${extension}`;
}

function imageMime(value: string | null): StoredImageMime | null {
  const normalized = value?.split(";", 1)[0].trim().toLowerCase();
  return normalized !== undefined && normalized in extensionByMime
    ? normalized as StoredImageMime
    : null;
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw mediaError("aborted");
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw mediaError("too_large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MediaStorageError) throw error;
    if (isAbort(error, signal)) throw mediaError("aborted");
    throw mediaError("download", null, true);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function uploadStatus(error: StorageUploadError): number | null {
  const parsed = Number(error.statusCode);
  return Number.isInteger(parsed) ? parsed : null;
}

export function createMediaStorage(config: MediaStorageConfig): MediaStorage {
  if (
    config.bucket.trim() === "" || !Number.isSafeInteger(config.maxBytes) ||
    config.maxBytes < 1 || config.maxBytes > MAX_MEDIA_BYTES
  ) {
    throw new Error("Media storage configuration is invalid");
  }
  const fetchImpl = config.fetch ?? globalThis.fetch;

  return {
    async store(asset, context): Promise<StoredMediaAsset> {
      if (context.signal.aborted) throw mediaError("aborted");

      let sourceUrl: URL;
      try {
        sourceUrl = new URL(asset.originalMediaUrl);
      } catch {
        throw mediaError("invalid_url");
      }
      if (sourceUrl.protocol !== "https:") throw mediaError("invalid_url");

      if (
        !UUID_PATTERN.test(asset.mediaAssetId) ||
        !safeMetaId(context.externalPostId) ||
        !safeMetaId(asset.externalMediaId)
      ) {
        throw mediaError("invalid_path");
      }

      let response: Response;
      try {
        response = await fetchImpl(sourceUrl, {
          method: "GET",
          signal: context.signal,
        });
      } catch (error) {
        if (isAbort(error, context.signal)) throw mediaError("aborted");
        throw mediaError("download", null, true);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw mediaError(
          "download",
          response.status,
          response.status === 429 || response.status >= 500,
        );
      }

      const mimeType = imageMime(response.headers.get("content-type"));
      if (mimeType === null) {
        await response.body?.cancel();
        throw mediaError("invalid_mime");
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null) {
        const parsedLength = Number(contentLength);
        if (Number.isFinite(parsedLength) && parsedLength > config.maxBytes) {
          await response.body?.cancel();
          throw mediaError("too_large");
        }
      }

      const body = await readLimitedBody(
        response,
        config.maxBytes,
        context.signal,
      );
      const path = storagePath(
        context.sourceAccountId,
        context.externalPostId,
        asset.externalMediaId,
        extensionByMime[mimeType],
      );

      let uploadError: StorageUploadError | null;
      try {
        ({ error: uploadError } = await config.storageClient
          .from(config.bucket)
          .upload(path, body, {
            contentType: mimeType,
            cacheControl: "2592000",
            upsert: false,
          }));
      } catch {
        throw mediaError("upload", null, true);
      }

      const uploadStatusCode = uploadError === null
        ? null
        : uploadStatus(uploadError);
      if (uploadError !== null && uploadStatusCode !== 409) {
        throw mediaError(
          "upload",
          uploadStatusCode,
          uploadStatusCode === null || uploadStatusCode === 429 ||
            uploadStatusCode >= 500,
        );
      }

      return {
        mediaAssetId: asset.mediaAssetId,
        storagePath: path,
        mimeType,
        fetchedAt: context.fetchedAt.toISOString(),
      };
    },
  };
}
