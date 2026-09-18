import { assertEquals, assertFalse } from "jsr:@std/assert@1.0.8";
import {
  createNotionSyncHandler,
  type NotionSyncHandlerDependencies,
} from "../../notion-sync/handler.ts";
import type { NotionSyncSummary } from "../../notion-sync/orchestrator.ts";

const secret = "collector-secret";
const summary: NotionSyncSummary = {
  rankingDate: "2026-09-18",
  considered: 2,
  created: 1,
  updated: 1,
  skipped: 0,
  dropped: 0,
  expired: 0,
  failed: 0,
};

function handler(overrides: Partial<NotionSyncHandlerDependencies> = {}) {
  return createNotionSyncHandler({
    collectorSecret: secret,
    run: async () => summary,
    now: () => new Date("2026-09-18T04:00:00.000Z"),
    requestId: () => "req-123",
    log: () => undefined,
    ...overrides,
  });
}

function request(
  authorization = `Bearer ${secret}`,
  body?: string,
  method = "POST",
): Request {
  return new Request("http://localhost/functions/v1/sync-notion-intelligence", {
    method,
    headers: {
      ...(authorization === "" ? {} : { authorization }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
}

Deno.test("requires POST and the shared collector secret", async () => {
  const response = await handler()(request("", undefined, "GET"));
  assertEquals(response.status, 405);

  const unauthorized = await handler()(request("Bearer wrong"));
  assertEquals(unauthorized.status, 401);
  assertFalse((await unauthorized.text()).includes("wrong"));
});

Deno.test("runs with an empty body or a valid as_of timestamp", async () => {
  let received: Date | undefined;
  const response = await handler({
    run: async (runAt) => {
      received = runAt;
      return summary;
    },
  })(request());
  assertEquals(response.status, 200);
  assertEquals(received?.toISOString(), "2026-09-18T04:00:00.000Z");
  assertEquals(await response.json(), {
    request_id: "req-123",
    ranking_date: "2026-09-18",
    considered: 2,
    created: 1,
    updated: 1,
    skipped: 0,
    dropped: 0,
    expired: 0,
    failed: 0,
  });
});

Deno.test("maps malformed input and unexpected failures to safe responses", async () => {
  const malformed = await handler()(request(secret ? `Bearer ${secret}` : "", "{}"));
  assertEquals(malformed.status, 400);

  const failed = await handler({
    run: async () => {
      throw new Error("database secret should not escape");
    },
  })(request());
  assertEquals(failed.status, 500);
  assertFalse((await failed.text()).includes("database secret"));
});
