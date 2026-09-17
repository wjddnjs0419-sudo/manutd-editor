import assert from "node:assert/strict";

import {
  createIngestRepository,
  RepositoryError,
} from "../../collect-instagram/repository.ts";
import type { NormalizedBatch } from "../../collect-instagram/types.ts";

const batch: NormalizedBatch = {
  username: "utdreport",
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
  posts: [
    {
      externalPostId: "image-1",
      caption: "Image fixture",
      permalink: "https://www.instagram.com/p/image-1/",
      mediaType: "IMAGE",
      mediaProductType: null,
      publishedAt: "2026-09-17T00:30:00.000Z",
      likeCount: 10,
      commentsCount: 2,
      viewCount: null,
      followersCountAtCollection: 250_000,
      postAgeMinutes: 30,
      rawPayload: { id: "image-1", media_type: "IMAGE" },
    },
  ],
  collectedAt: "2026-09-17T01:00:00.000Z",
  receivedMedia: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("calls the ingest RPC with service credentials and maps its summary", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const repository = createIngestRepository({
    supabaseUrl: "http://127.0.0.1:55321/",
    serviceRoleKey: "service-role-secret",
    fetch: (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return Promise.resolve(jsonResponse({
        account_id: "17841400000000001",
        inserted_posts: 1,
        updated_posts: 0,
        inserted_snapshots: 1,
      }));
    },
    sleep: () => Promise.resolve(),
  });

  const result = await repository.ingest(batch);

  assert.deepEqual(result, {
    accountId: "17841400000000001",
    insertedPosts: 1,
    updatedPosts: 0,
    insertedSnapshots: 1,
  });
  assert.equal(
    requestUrl,
    "http://127.0.0.1:55321/rest/v1/rpc/ingest_instagram_batch",
  );
  assert.equal(requestInit?.method, "POST");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("apikey"), "service-role-secret");
  assert.equal(headers.get("authorization"), "Bearer service-role-secret");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    p_username: "utdreport",
    p_account: {
      instagram_account_id: "17841400000000001",
      followers_count: 250_000,
      followers_available: true,
      likes_available: true,
      comments_available: true,
      views_available: false,
      media_url_available: true,
      carousel_children_available: false,
    },
    p_posts: [
      {
        external_post_id: "image-1",
        caption: "Image fixture",
        permalink: "https://www.instagram.com/p/image-1/",
        media_type: "IMAGE",
        media_product_type: null,
        published_at: "2026-09-17T00:30:00.000Z",
        like_count: 10,
        comments_count: 2,
        view_count: null,
        followers_count_at_collection: 250_000,
        post_age_minutes: 30,
        raw_payload: { id: "image-1", media_type: "IMAGE" },
      },
    ],
    p_collected_at: "2026-09-17T01:00:00.000Z",
  });
});

Deno.test("retries one ambiguous 5xx response and returns the second result", async () => {
  let attempts = 0;
  const repository = createIngestRepository({
    supabaseUrl: "http://127.0.0.1:55321",
    serviceRoleKey: "service-role-secret",
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? jsonResponse({ message: "private database detail" }, 503)
          : jsonResponse({
            account_id: "17841400000000001",
            inserted_posts: 0,
            updated_posts: 1,
            inserted_snapshots: 0,
          }),
      );
    },
    sleep: () => Promise.resolve(),
  });

  const result = await repository.ingest(batch);

  assert.equal(attempts, 2);
  assert.equal(result.updatedPosts, 1);
});

Deno.test("retries one thrown network failure after ambiguous commit state", async () => {
  let attempts = 0;
  const repository = createIngestRepository({
    supabaseUrl: "http://127.0.0.1:55321",
    serviceRoleKey: "service-role-secret",
    fetch: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new TypeError("socket failure with private detail"))
        : Promise.resolve(jsonResponse({
          account_id: "17841400000000001",
          inserted_posts: 0,
          updated_posts: 1,
          inserted_snapshots: 0,
        }));
    },
    sleep: () => Promise.resolve(),
  });

  await repository.ingest(batch);

  assert.equal(attempts, 2);
});

Deno.test("does not retry deterministic database errors and redacts details", async () => {
  let attempts = 0;
  const repository = createIngestRepository({
    supabaseUrl: "http://127.0.0.1:55321",
    serviceRoleKey: "service-role-secret",
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        jsonResponse(
          { message: "constraint detail includes service-role-secret" },
          400,
        ),
      );
    },
    sleep: () => Promise.resolve(),
  });

  await assert.rejects(
    repository.ingest(batch),
    (error: unknown) => {
      assert.ok(error instanceof RepositoryError);
      assert.equal(error.code, "DATABASE_HTTP_ERROR");
      assert.equal(error.status, 400);
      assert.equal(error.retriable, false);
      assert.doesNotMatch(
        error.message,
        /service-role-secret|constraint detail/,
      );
      return true;
    },
  );
  assert.equal(attempts, 1);
});

Deno.test("rejects a malformed successful RPC response safely", async () => {
  const repository = createIngestRepository({
    supabaseUrl: "http://127.0.0.1:55321",
    serviceRoleKey: "service-role-secret",
    fetch: () =>
      Promise.resolve(jsonResponse({ inserted_posts: "not-a-number" })),
    sleep: () => Promise.resolve(),
  });

  await assert.rejects(
    repository.ingest(batch),
    (error: unknown) =>
      error instanceof RepositoryError &&
      error.code === "DATABASE_INVALID_RESPONSE" &&
      error.status === 200,
  );
});
