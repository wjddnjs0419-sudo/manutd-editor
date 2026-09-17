import assert from "node:assert/strict";

import { createHandler } from "../../collect-instagram/handler.ts";
import { MetaApiError } from "../../collect-instagram/meta_client.ts";
import { RepositoryError } from "../../collect-instagram/repository.ts";
import type { CollectionSummary } from "../../collect-instagram/types.ts";

const url = "http://localhost/functions/v1/collect-instagram";
const summary: CollectionSummary = {
  username: "utdreport",
  accountId: "17841400000000001",
  receivedMedia: 3,
  deduplicatedMedia: 3,
  insertedPosts: 3,
  updatedPosts: 0,
  insertedSnapshots: 3,
};

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

Deno.test("authenticates the exact bearer secret and returns a request-scoped summary", async () => {
  let collectedAt: Date | undefined;
  const logs: unknown[] = [];
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: (date) => {
      collectedAt = date;
      return Promise.resolve(summary);
    },
    now: () => new Date("2026-09-17T01:00:00.000Z"),
    requestId: () => "req-success",
    log: (entry) => logs.push(entry),
  });

  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer collector-secret" },
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    requestId: "req-success",
    ...summary,
  });
  assert.equal(collectedAt?.toISOString(), "2026-09-17T01:00:00.000Z");
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /collector-secret/);
});

Deno.test("maps Meta failures to a safe 502 response and log entry", async () => {
  const logs: unknown[] = [];
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: () =>
      Promise.reject(new MetaApiError("META_HTTP_ERROR", 401, false)),
    requestId: () => "req-meta",
    log: (entry) => logs.push(entry),
  });

  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer collector-secret" },
    }),
  );
  const body = await response.text();

  assert.equal(response.status, 502);
  assert.deepEqual(JSON.parse(body), {
    requestId: "req-meta",
    error: { code: "META_HTTP_ERROR", message: "Meta collection failed" },
  });
  assert.doesNotMatch(body, /collector-secret|401/);
  assert.doesNotMatch(JSON.stringify(logs), /collector-secret/);
});

Deno.test("maps database failures to a safe 500 response", async () => {
  const handler = createHandler({
    collectorSecret: "collector-secret",
    collect: () =>
      Promise.reject(
        new RepositoryError("DATABASE_HTTP_ERROR", 400, false),
      ),
    requestId: () => "req-database",
    log: () => undefined,
  });

  const response = await handler(
    new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer collector-secret" },
    }),
  );
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
