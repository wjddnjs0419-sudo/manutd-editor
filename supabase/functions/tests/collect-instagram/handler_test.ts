import assert from "node:assert/strict";

import { createHandler } from "../../collect-instagram/handler.ts";
import { RepositoryError } from "../../collect-instagram/repository.ts";
import type { CollectionRunSummary } from "../../collect-instagram/types.ts";

const url = "http://localhost/functions/v1/collect-instagram";
const validUuid1 = "00000000-0000-4000-8000-000000000001";
const validUuid2 = "00000000-0000-4000-8000-000000000002";
const summary: CollectionRunSummary = {
  accountsRequested: 2,
  accountsSuccess: 1,
  accountsFailed: 1,
  postsCreated: 3,
  postsUpdated: 2,
  snapshotsCreated: 4,
  assetsStored: 0,
  assetsFailed: 0,
  accounts: [
    {
      sourceAccountId: validUuid1,
      status: "success",
      insertedPosts: 3,
      updatedPosts: 2,
      insertedSnapshots: 4,
      assetsStored: 0,
      assetsFailed: 0,
    },
    {
      sourceAccountId: validUuid2,
      status: "failed",
      errorCategory: "permission",
      insertedPosts: 0,
      updatedPosts: 0,
      insertedSnapshots: 0,
      assetsStored: 0,
      assetsFailed: 0,
    },
  ],
};

function authorizedRequest(body?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: "Bearer collector-secret",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
}

Deno.test("rejects non-POST methods without invoking collection", async () => {
  let collectCalls = 0;
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: () => {
      collectCalls += 1;
      return Promise.resolve(summary);
    },
    requestId: () => "req-method",
  });

  const response = await handler(new Request(url, { method: "GET" }));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(collectCalls, 0);
});

Deno.test("rejects missing, malformed, and incorrect collector credentials", async (test) => {
  const credentials: Array<[string, string | undefined]> = [
    ["missing", undefined],
    ["wrong scheme", "Basic collector-secret"],
    ["empty bearer", "Bearer "],
    ["wrong bearer", "Bearer wrong-secret"],
  ];

  for (const [name, authorization] of credentials) {
    await test.step(name, async () => {
      let collectCalls = 0;
      const handler = createHandler({
        collectorSecret: "collector-secret",
        collect: () => {
          collectCalls += 1;
          return Promise.resolve(summary);
        },
        requestId: () => "req-auth",
        log: () => undefined,
      });
      const headers = new Headers();
      if (authorization !== undefined) {
        headers.set("authorization", authorization);
      }

      const response = await handler(
        new Request(url, { method: "POST", headers }),
      );
      const body = await response.text();

      assert.equal(response.status, 401);
      assert.equal(collectCalls, 0);
      assert.doesNotMatch(body, /collector-secret|wrong-secret/);
    });
  }
});

Deno.test("body omission collects all active accounts", async () => {
  let receivedIds: string[] | undefined = ["not-reset"];
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: (_date, ids) => {
      receivedIds = ids;
      return Promise.resolve(summary);
    },
    requestId: () => "req-all",
    log: () => undefined,
  });

  const response = await handler(authorizedRequest());

  assert.equal(response.status, 200);
  assert.equal(receivedIds, undefined);
});

Deno.test("valid source_account_ids are passed to collection in request order", async () => {
  let receivedIds: string[] | undefined;
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: (_date, ids) => {
      receivedIds = ids;
      return Promise.resolve(summary);
    },
    now: () => new Date("2026-09-17T01:00:00.000Z"),
    requestId: () => "req-subset",
    log: () => undefined,
  });

  const response = await handler(authorizedRequest(JSON.stringify({
    source_account_ids: [validUuid2, validUuid1],
  })));

  assert.equal(response.status, 200);
  assert.deepEqual(receivedIds, [validUuid2, validUuid1]);
});

Deno.test("invalid request bodies return 400 without invoking collection", async (test) => {
  const bodies: Array<[string, string]> = [
    ["malformed JSON", "{"],
    ["array root", "[]"],
    ["missing key", "{}"],
    ["empty IDs", JSON.stringify({ source_account_ids: [] })],
    [
      "duplicate IDs",
      JSON.stringify({
        source_account_ids: [validUuid1, validUuid1],
      }),
    ],
    ["non-string ID", JSON.stringify({ source_account_ids: [7] })],
    ["malformed UUID", JSON.stringify({ source_account_ids: ["account-1"] })],
    [
      "unknown key",
      JSON.stringify({
        source_account_ids: [validUuid1],
        username: "utdreport",
      }),
    ],
  ];

  for (const [name, body] of bodies) {
    await test.step(name, async () => {
      let collectCalls = 0;
      const handler = createHandler({
        collectorSecret: "collector-secret",
        collect: () => {
          collectCalls += 1;
          return Promise.resolve(summary);
        },
        requestId: () => "req-invalid",
        log: () => undefined,
      });

      const response = await handler(authorizedRequest(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        requestId: "req-invalid",
        error: { code: "INVALID_REQUEST", message: "Invalid request body" },
      });
      assert.equal(collectCalls, 0);
    });
  }
});

Deno.test("returns a partial-failure aggregate as HTTP 200 with safe logs", async () => {
  const logs: unknown[] = [];
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: () => Promise.resolve(summary),
    requestId: () => "req-partial",
    log: (entry) => logs.push(entry),
  });

  const response = await handler(authorizedRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    requestId: "req-partial",
    ...summary,
  });
  assert.deepEqual(logs, [{
    requestId: "req-partial",
    event: "collection_completed",
    accountsRequested: 2,
    accountsSuccess: 1,
    accountsFailed: 1,
    failureCategories: { permission: 1 },
    postsCreated: 3,
    postsUpdated: 2,
    snapshotsCreated: 4,
    assetsStored: 0,
    assetsFailed: 0,
  }]);
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(validUuid1));
  assert.doesNotMatch(JSON.stringify(logs), /collector-secret/);
});

Deno.test("maps account-list database failures to a safe 500 response", async () => {
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: () =>
      Promise.reject(new RepositoryError("DATABASE_HTTP_ERROR", 400, false)),
    requestId: () => "req-database",
    log: () => undefined,
  });

  const response = await handler(authorizedRequest());
  const body = await response.text();

  assert.equal(response.status, 500);
  assert.deepEqual(JSON.parse(body), {
    requestId: "req-database",
    error: {
      code: "DATABASE_HTTP_ERROR",
      message: "Database ingestion failed",
    },
  });
  assert.doesNotMatch(body, /collector-secret|400/);
});
