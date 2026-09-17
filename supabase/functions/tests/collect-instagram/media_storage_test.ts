import assert from "node:assert/strict";

import {
  createMediaStorage,
  MediaStorageError,
} from "../../collect-instagram/media_storage.ts";
import type { PendingMediaAsset } from "../../collect-instagram/types.ts";

const asset: PendingMediaAsset = {
  mediaAssetId: "00000000-0000-4000-8000-000000000010",
  rawPostId: "00000000-0000-4000-8000-000000000011",
  externalMediaId: "image-1",
  assetType: "IMAGE",
  carouselIndex: null,
  originalMediaUrl: "https://cdn.example/image-1.jpg?temporary=secret",
};
const context = {
  sourceAccountId: "00000000-0000-4000-8000-000000000001",
  externalPostId: "post-1",
  fetchedAt: new Date("2026-09-17T03:00:00.000Z"),
  signal: new AbortController().signal,
};

function storageClient(
  upload: (
    path: string,
    body: Uint8Array,
    options: Record<string, unknown>,
  ) => Promise<
    { error: null | { statusCode?: string | number; message?: string } }
  >,
) {
  return {
    from: (bucket: string) => ({
      upload: (
        path: string,
        body: Uint8Array,
        options: Record<string, unknown>,
      ) => {
        assert.equal(bucket, "instagram-analysis");
        return upload(path, body, options);
      },
    }),
  };
}

Deno.test("downloads and uploads an image to a deterministic private path", async () => {
  let uploadedPath = "";
  let uploadedBody: Uint8Array | undefined;
  let uploadedOptions: Record<string, unknown> | undefined;
  const mediaStorage = createMediaStorage({
    bucket: "instagram-analysis",
    maxBytes: 20 * 1024 * 1024,
    fetch: (_input, init) => {
      assert.equal(
        (init as globalThis.RequestInit | undefined)?.signal,
        context.signal,
      );
      return Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "3" },
        }),
      );
    },
    storageClient: storageClient((path, body, options) => {
      uploadedPath = path;
      uploadedBody = body;
      uploadedOptions = options;
      return Promise.resolve({ error: null });
    }),
  });

  const stored = await mediaStorage.store(asset, context);

  assert.deepEqual(stored, {
    mediaAssetId: asset.mediaAssetId,
    storagePath:
      "instagram/00000000-0000-4000-8000-000000000001/post-1/image-1.jpg",
    mimeType: "image/jpeg",
    fetchedAt: "2026-09-17T03:00:00.000Z",
  });
  assert.equal(uploadedPath, stored.storagePath);
  assert.deepEqual(uploadedBody, new Uint8Array([1, 2, 3]));
  assert.deepEqual(uploadedOptions, {
    contentType: "image/jpeg",
    cacheControl: "2592000",
    upsert: false,
  });
});

Deno.test("rejects unsafe downloads with safe categorized errors", async (test) => {
  const cases: Array<{
    name: string;
    candidate: PendingMediaAsset;
    maxBytes: number;
    fetch: typeof fetch;
    category: string;
    retriable: boolean;
  }> = [
    {
      name: "non-HTTPS URL",
      candidate: { ...asset, originalMediaUrl: "http://cdn.example/image.jpg" },
      maxBytes: 20,
      fetch: () => Promise.resolve(new Response()),
      category: "invalid_url",
      retriable: false,
    },
    {
      name: "non-2xx response",
      candidate: asset,
      maxBytes: 20,
      fetch: () =>
        Promise.resolve(
          new Response("private upstream detail", { status: 503 }),
        ),
      category: "download",
      retriable: true,
    },
    {
      name: "unsupported MIME",
      candidate: asset,
      maxBytes: 20,
      fetch: () =>
        Promise.resolve(
          new Response("video", {
            headers: { "content-type": "video/mp4" },
          }),
        ),
      category: "invalid_mime",
      retriable: false,
    },
    {
      name: "oversized Content-Length",
      candidate: asset,
      maxBytes: 4,
      fetch: () =>
        Promise.resolve(
          new Response(new Uint8Array([1]), {
            headers: { "content-type": "image/png", "content-length": "5" },
          }),
        ),
      category: "too_large",
      retriable: false,
    },
    {
      name: "oversized streamed body",
      candidate: asset,
      maxBytes: 4,
      fetch: () =>
        Promise.resolve(
          new Response(new Uint8Array([1, 2, 3, 4, 5]), {
            headers: { "content-type": "image/webp" },
          }),
        ),
      category: "too_large",
      retriable: false,
    },
  ];

  for (const testCase of cases) {
    await test.step(testCase.name, async () => {
      let uploads = 0;
      const mediaStorage = createMediaStorage({
        bucket: "instagram-analysis",
        maxBytes: testCase.maxBytes,
        fetch: testCase.fetch,
        storageClient: storageClient(() => {
          uploads += 1;
          return Promise.resolve({ error: null });
        }),
      });

      await assert.rejects(
        mediaStorage.store(testCase.candidate, context),
        (error: unknown) => {
          assert.ok(error instanceof MediaStorageError);
          assert.equal(error.category, testCase.category);
          assert.equal(error.retriable, testCase.retriable);
          assert.doesNotMatch(
            JSON.stringify(error),
            /temporary=secret|private upstream detail/,
          );
          return true;
        },
      );
      assert.equal(uploads, 0);
    });
  }
});

Deno.test("aborted downloads stop safely before upload", async () => {
  const controller = new AbortController();
  controller.abort();
  let fetches = 0;
  const mediaStorage = createMediaStorage({
    bucket: "instagram-analysis",
    maxBytes: 20,
    fetch: () => {
      fetches += 1;
      return Promise.reject(
        new DOMException("private abort detail", "AbortError"),
      );
    },
    storageClient: storageClient(() => Promise.resolve({ error: null })),
  });

  await assert.rejects(
    mediaStorage.store(asset, { ...context, signal: controller.signal }),
    (error: unknown) =>
      error instanceof MediaStorageError &&
      error.category === "aborted" &&
      error.retriable === false &&
      !error.message.includes("private abort detail"),
  );
  assert.equal(fetches, 0);
});

Deno.test("reports upload failures without exposing storage details", async () => {
  const mediaStorage = createMediaStorage({
    bucket: "instagram-analysis",
    maxBytes: 20,
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/gif" },
        }),
      ),
    storageClient: storageClient(() =>
      Promise.resolve({
        error: { statusCode: 500, message: "private storage detail" },
      })
    ),
  });

  await assert.rejects(
    mediaStorage.store(asset, context),
    (error: unknown) =>
      error instanceof MediaStorageError &&
      error.category === "upload" &&
      error.statusClass === "5xx" &&
      error.retriable &&
      !error.message.includes("private storage detail"),
  );
});

Deno.test("treats an existing deterministic object as a successful retry", async () => {
  const mediaStorage = createMediaStorage({
    bucket: "instagram-analysis",
    maxBytes: 20,
    fetch: () =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/jpeg" },
        }),
      ),
    storageClient: storageClient(() =>
      Promise.resolve({
        error: { statusCode: "409", message: "private duplicate detail" },
      })
    ),
  });

  const stored = await mediaStorage.store(asset, context);

  assert.equal(stored.mimeType, "image/jpeg");
  assert.match(stored.storagePath, /\/image-1\.jpg$/);
});

Deno.test("rejects unsafe path segments before downloading", async () => {
  let fetches = 0;
  const mediaStorage = createMediaStorage({
    bucket: "instagram-analysis",
    maxBytes: 20,
    fetch: () => {
      fetches += 1;
      return Promise.resolve(new Response());
    },
    storageClient: storageClient(() => Promise.resolve({ error: null })),
  });

  await assert.rejects(
    mediaStorage.store(
      { ...asset, externalMediaId: "..%2fsecret" },
      context,
    ),
    (error: unknown) =>
      error instanceof MediaStorageError && error.category === "invalid_path",
  );
  assert.equal(fetches, 0);
});
