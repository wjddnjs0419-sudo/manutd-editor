import assert from "node:assert/strict";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

import {
  createMediaStorage,
  storageClientFromSupabase,
} from "../../collect-instagram/media_storage.ts";
import { createIngestRepository } from "../../collect-instagram/repository.ts";
import type { NormalizedBatch } from "../../collect-instagram/types.ts";

const bucket = "instagram-analysis";
const jpeg1x1 = new Uint8Array([
  0xff,
  0xd8,
  0xff,
  0xdb,
  0x00,
  0x43,
  0x00,
  0xff,
  0xd9,
]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing integration configuration: ${name}`);
  return value;
}

async function deleteRow(
  supabaseUrl: string,
  secretKey: string,
  table: string,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { apikey: secretKey } },
  );
  if (!response.ok) throw new Error("Integration cleanup failed");
  await response.body?.cancel();
}

Deno.test("stores, retries, finalizes, and privately serves a local media asset", async () => {
  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY");
  const client = createClient(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  const repository = createIngestRepository({ supabaseUrl, secretKey });
  const storage = createMediaStorage({
    bucket,
    maxBytes: 20 * 1024 * 1024,
    storageClient: storageClientFromSupabase(client),
    fetch: () =>
      Promise.resolve(
        new Response(jpeg1x1, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(jpeg1x1.byteLength),
          },
        }),
      ),
  });

  const suffix = crypto.randomUUID();
  const externalPostId = `integration-${suffix}`;
  const externalMediaId = `image-${suffix}`;
  let rawPostId: string | undefined;
  let mediaAssetId: string | undefined;
  let storedPath: string | undefined;

  try {
    const sourceAccount = (await repository.listActive()).find((account) =>
      account.username === "utdreport"
    );
    if (!sourceAccount) throw new Error("Integration source account missing");
    const batch: NormalizedBatch = {
      username: sourceAccount.username,
      account: {
        instagramAccountId: "17841400000000001",
        followersCount: 250_000,
        capabilities: {
          followersAvailable: true,
          likesAvailable: true,
          commentsAvailable: true,
          viewsAvailable: false,
          mediaUrlAvailable: true,
          carouselChildrenAvailable: false,
        },
      },
      posts: [{
        externalPostId,
        caption: "Storage integration fixture",
        permalink: null,
        mediaType: "IMAGE",
        mediaProductType: null,
        publishedAt: "2026-09-17T02:30:00.000Z",
        likeCount: 1,
        commentsCount: 0,
        viewCount: null,
        followersCountAtCollection: 250_000,
        postAgeMinutes: 30,
        rawPayload: { id: externalPostId, media_type: "IMAGE" },
        assets: [],
      }],
      collectedAt: "2026-09-17T03:00:00.000Z",
      receivedMedia: 1,
    };
    const ingested = await repository.ingest(sourceAccount.id, batch);
    rawPostId = ingested.posts[0]?.rawPostId;
    if (!rawPostId) throw new Error("Integration raw post missing");

    const pending = await repository.prepareMediaAssets(sourceAccount.id, [{
      rawPostId,
      externalMediaId,
      assetType: "IMAGE",
      carouselIndex: null,
      originalMediaUrl: "https://cdn.example/integration.jpg",
    }]);
    if (pending.length !== 1) {
      throw new Error("Integration pending asset missing");
    }
    mediaAssetId = pending[0].mediaAssetId;

    const context = {
      sourceAccountId: sourceAccount.id,
      externalPostId,
      fetchedAt: new Date("2026-09-17T03:05:00.000Z"),
      signal: AbortSignal.timeout(5_000),
    };
    const first = await storage.store(pending[0], context);
    const retry = await storage.store(pending[0], context);
    assert.deepEqual(retry, first);
    storedPath = first.storagePath;

    assert.equal(
      await repository.finalizeMediaAssets(sourceAccount.id, [first]),
      1,
    );

    const slash = first.storagePath.lastIndexOf("/");
    const directory = first.storagePath.slice(0, slash);
    const filename = first.storagePath.slice(slash + 1);
    const { data: objects, error: listError } = await client.storage
      .from(bucket)
      .list(directory, { search: filename });
    if (listError) throw new Error("Integration object lookup failed");
    assert.ok(objects.some((object) => object.name === filename));

    const rowResponse = await fetch(
      `${supabaseUrl}/rest/v1/media_assets?select=storage_path&id=eq.${mediaAssetId}`,
      { headers: { apikey: secretKey } },
    );
    if (!rowResponse.ok) throw new Error("Integration metadata lookup failed");
    const rows = await rowResponse.json() as Array<{ storage_path: string }>;
    assert.deepEqual(rows, [{ storage_path: first.storagePath }]);

    const publicUrl =
      client.storage.from(bucket).getPublicUrl(first.storagePath)
        .data.publicUrl;
    const publicResponse = await fetch(publicUrl);
    assert.equal(publicResponse.ok, false);
    await publicResponse.body?.cancel();
  } finally {
    if (storedPath) {
      await client.storage.from(bucket).remove([storedPath]);
    }
    if (mediaAssetId) {
      await deleteRow(supabaseUrl, secretKey, "media_assets", mediaAssetId);
    }
    if (rawPostId) {
      await deleteRow(supabaseUrl, secretKey, "raw_posts", rawPostId);
    }
  }
});
