import type { MediaAssetType } from "./types.ts";

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPPORTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

export type MediaReadErrorCategory =
  | "MEDIA_UNAVAILABLE"
  | "MEDIA_TOO_LARGE"
  | "MEDIA_INVALID";

export class MediaReadError extends Error {
  constructor(readonly category: MediaReadErrorCategory) {
    super(category);
    this.name = "MediaReadError";
  }
}

interface StorageError {
  readonly statusCode?: string | number;
}

export interface PrivateStorage {
  from(bucket: string): {
    download(path: string): Promise<{
      data: Blob | null;
      error: StorageError | null;
    }>;
  };
}

export interface PrivateMediaAsset {
  readonly mediaAssetId: string;
  readonly assetType: MediaAssetType;
  readonly carouselIndex: number | null;
  readonly storagePath: string;
  readonly mimeType: string | null;
}

export interface PrivateMediaInput {
  readonly mediaAssetId: string;
  readonly assetType: MediaAssetType;
  readonly carouselIndex: number | null;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly dataUrl: string;
  readonly sha256: string;
}

export interface PrivateMediaReaderOptions {
  readonly bucket: "instagram-analysis";
  readonly maxBytes: number;
  readonly storageClient: PrivateStorage;
}

function safePathSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(value) && value !== "." &&
    value !== ".." && !value.includes("..");
}

function validStoragePath(path: string): boolean {
  const parts = path.split("/");
  if (parts.length !== 4 || parts[0] !== "instagram") return false;
  if (!UUID_PATTERN.test(parts[1] ?? "")) return false;
  if (!safePathSegment(parts[2] ?? "")) return false;
  const mediaPart = parts[3] ?? "";
  const dot = mediaPart.lastIndexOf(".");
  if (dot <= 0) return false;
  const stem = mediaPart.slice(0, dot);
  const extension = mediaPart.slice(dot + 1).toLowerCase();
  return safePathSegment(stem) && extension in EXTENSION_TO_MIME;
}

function normalizeMime(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const mime = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_MIME.has(mime) ? mime : null;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function createPrivateMediaReader(options: PrivateMediaReaderOptions) {
  if (
    options.bucket !== "instagram-analysis" ||
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 || options.maxBytes > MAX_MEDIA_BYTES
  ) {
    throw new Error("Invalid private media configuration");
  }

  return {
    async read(asset: PrivateMediaAsset): Promise<PrivateMediaInput> {
      if (!validStoragePath(asset.storagePath)) {
        throw new MediaReadError("MEDIA_INVALID");
      }

      const declaredMime = normalizeMime(asset.mimeType);
      if (asset.mimeType !== null && declaredMime === null) {
        throw new MediaReadError("MEDIA_INVALID");
      }

      let downloaded: { data: Blob | null; error: StorageError | null };
      try {
        downloaded = await options.storageClient.from(options.bucket).download(asset.storagePath);
      } catch {
        throw new MediaReadError("MEDIA_UNAVAILABLE");
      }
      if (downloaded.error !== null || downloaded.data === null) {
        throw new MediaReadError("MEDIA_UNAVAILABLE");
      }

      const blobMime = normalizeMime(downloaded.data.type);
      const mimeType = declaredMime ?? blobMime;
      if (mimeType === null || (blobMime !== null && blobMime !== mimeType)) {
        throw new MediaReadError("MEDIA_INVALID");
      }
      if (downloaded.data.size > options.maxBytes) {
        throw new MediaReadError("MEDIA_TOO_LARGE");
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      } catch {
        throw new MediaReadError("MEDIA_UNAVAILABLE");
      }
      if (bytes.byteLength > options.maxBytes) {
        throw new MediaReadError("MEDIA_TOO_LARGE");
      }

      return {
        mediaAssetId: asset.mediaAssetId,
        assetType: asset.assetType,
        carouselIndex: asset.carouselIndex,
        mimeType,
        bytes,
        dataUrl: `data:${mimeType};base64,${base64(bytes)}`,
        sha256: await sha256(bytes),
      };
    },
  };
}
