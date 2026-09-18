import assert from "node:assert/strict";
import test from "node:test";
import {
  NotionClientError,
  createNotionClient,
} from "../../notion-sync/notion_client.ts";
import type { NotionPagePayload } from "../../notion-sync/mapper.ts";

const pagePayload: NotionPagePayload = {
  properties: {
    Title: { title: [{ type: "text", text: { content: "Example" } }] },
  },
  children: [],
};

function response(status: number, body: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

test("retries 429 using Retry-After and returns a parsed page", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const client = createNotionClient({
    token: "secret-token",
    databaseId: "database-id",
    fetch: async () => {
      attempts += 1;
      return attempts === 1
        ? response(429, { message: "private upstream detail" }, { "Retry-After": "2" })
        : response(200, { id: "page-id", url: "https://notion.example/page" });
    },
    sleep: async (delay) => {
      sleeps.push(delay);
    },
  });

  const page = await client.createPage(pagePayload);
  assert.equal(page.id, "page-id");
  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2000]);
});

test("retries transient 5xx failures with bounded attempts", async () => {
  let attempts = 0;
  const client = createNotionClient({
    token: "secret-token",
    databaseId: "database-id",
    fetch: async () => {
      attempts += 1;
      return response(503, { secret: "do-not-log" });
    },
    sleep: async () => undefined,
    maxAttempts: 3,
  });

  await assert.rejects(
    client.createPage(pagePayload),
    (error: unknown) => error instanceof NotionClientError && error.category === "SERVER_ERROR" && attempts === 3,
  );
});

test("does not retry permanent 400, 401, or 403 failures", async () => {
  for (const status of [400, 401, 403]) {
    let attempts = 0;
    const client = createNotionClient({
      token: "secret-token",
      databaseId: "database-id",
      fetch: async () => {
        attempts += 1;
        return response(status, { token: "secret-token", detail: "do-not-log" });
      },
      sleep: async () => undefined,
    });

    await assert.rejects(
      client.createPage(pagePayload),
      (error: unknown) => error instanceof NotionClientError && attempts === 1,
    );
  }
});

test("classifies a network timeout without exposing the token", async () => {
  const client = createNotionClient({
    token: "secret-token",
    databaseId: "database-id",
    fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = (init as RequestInit | undefined)?.signal;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
    sleep: async () => undefined,
    timeoutMs: 5,
    maxAttempts: 1,
  });

  await assert.rejects(
    client.createPage(pagePayload),
    (error: unknown) => error instanceof NotionClientError &&
      error.category === "NETWORK_TIMEOUT" &&
      !error.message.includes("secret-token"),
  );
});

test("rejects a malformed successful response safely", async () => {
  const client = createNotionClient({
    token: "secret-token",
    databaseId: "database-id",
    fetch: async () => response(200, { object: "page", properties: {} }),
    sleep: async () => undefined,
  });

  await assert.rejects(
    client.createPage(pagePayload),
    (error: unknown) => error instanceof NotionClientError && error.category === "MALFORMED_RESPONSE",
  );
});

test("sends the token only in authorization and the database parent on create", async () => {
  let request: Request | undefined;
  const client = createNotionClient({
    token: "secret-token",
    databaseId: "database-id",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return response(200, { id: "page-id" });
    },
    sleep: async () => undefined,
  });

  await client.createPage(pagePayload);
  assert.equal(request?.headers.get("authorization"), "Bearer secret-token");
  assert.equal(request?.headers.get("notion-version"), "2022-06-28");
  const body = await request!.clone().json() as Record<string, unknown>;
  assert.deepEqual(body.parent, { database_id: "database-id" });
});
