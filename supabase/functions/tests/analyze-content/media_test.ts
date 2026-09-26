import assert from "node:assert/strict";

import {
  createPrivateMediaReader,
  MediaReadError,
} from "../../analyze-content/media.ts";

const postId = "00000000-0000-4000-8000-000000000101";

function storageFor(
  data: Blob | null,
  error: { statusCode?: string | number } | null = null,
) {
  const calls: Array<{ bucket: string; path: string }> = [];
  return {
    calls,
    storageClient: {
      from(bucket: string) {
        return {
          async download(path: string) {
            calls.push({ bucket, path });
            return { data, error };
          },
        };
      },
    },
  };
}

const imageAsset = {
  mediaAssetId: "00000000-0000-4000-8000-000000000201",
  assetType: "IMAGE" as const,
  carouselIndex: null,
  storagePath: `instagram/${postId}/post-1/media-1.jpg`,
  mimeType: "image/jpeg",
};

Deno.test("reads a private image as bytes, data URI, and SHA-256 without a URL", async () => {
  const storage = storageFor(new Blob(["hello"], { type: "image/jpeg" }));
  const reader = createPrivateMediaReader({
    bucket: "instagram-analysis",
    maxBytes: 32,
    storageClient: storage.storageClient,
  });

  const result = await reader.read(imageAsset);

  assert.deepEqual(Array.from(result.bytes), Array.from(new TextEncoder().encode("hello")));
  assert.equal(result.dataUrl, "data:image/jpeg;base64,aGVsbG8=");
  assert.equal(result.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(Object.hasOwn(result, "url"), false);
  assert.deepEqual(storage.calls, [{ bucket: "instagram-analysis", path: imageAsset.storagePath }]);
});

Deno.test("rejects an unsafe path before calling Storage", async () => {
  const storage = storageFor(new Blob(["hello"], { type: "image/jpeg" }));
  const reader = createPrivateMediaReader({
    bucket: "instagram-analysis",
    maxBytes: 32,
    storageClient: storage.storageClient,
  });

  await assert.rejects(
    () => reader.read({ ...imageAsset, storagePath: "https://example.com/public.jpg" }),
    (error: unknown) => error instanceof MediaReadError && error.category === "MEDIA_INVALID",
  );
  assert.equal(storage.calls.length, 0);
});

Deno.test("rejects unsupported MIME types without exposing the Storage error", async () => {
  const storage = storageFor(new Blob(["hello"], { type: "text/plain" }));
  const reader = createPrivateMediaReader({
    bucket: "instagram-analysis",
    maxBytes: 32,
    storageClient: storage.storageClient,
  });

  await assert.rejects(
    () => reader.read({ ...imageAsset, mimeType: "text/plain" }),
    (error: unknown) => error instanceof MediaReadError && error.category === "MEDIA_INVALID",
  );
});

Deno.test("rejects downloaded media over the configured byte limit", async () => {
  const storage = storageFor(new Blob(["this is too large"], { type: "image/jpeg" }));
  const reader = createPrivateMediaReader({
    bucket: "instagram-analysis",
    maxBytes: 4,
    storageClient: storage.storageClient,
  });

  await assert.rejects(
    () => reader.read(imageAsset),
    (error: unknown) => error instanceof MediaReadError && error.category === "MEDIA_TOO_LARGE",
  );
});

Deno.test("maps missing private media to a safe unavailable category", async () => {
  const storage = storageFor(null, { statusCode: 404 });
  const reader = createPrivateMediaReader({
    bucket: "instagram-analysis",
    maxBytes: 32,
    storageClient: storage.storageClient,
  });

  await assert.rejects(
    () => reader.read(imageAsset),
    (error: unknown) => error instanceof MediaReadError && error.category === "MEDIA_UNAVAILABLE" &&
      !String(error).includes("404"),
  );
});
