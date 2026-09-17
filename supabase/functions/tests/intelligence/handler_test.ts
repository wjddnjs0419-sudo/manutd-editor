import assert from "node:assert/strict";

import {
  createIntelligenceHandler,
  type IntelligenceHandlerDependencies,
} from "../../intelligence/handler.ts";
import type { IntelligenceRunSummary } from "../../intelligence/types.ts";

const url = "http://localhost/functions/v1/intelligence";
const secret = "collector-secret";
const runAt = new Date("2026-09-18T12:00:00.000Z");
const summary: IntelligenceRunSummary = {
  runId: "run-123",
  status: "completed",
  clustersProcessed: 3,
  candidatesUpserted: 2,
};

function handler(
  overrides: Partial<IntelligenceHandlerDependencies> = {},
) {
  return createIntelligenceHandler({
    collectorSecret: secret,
    run: async () => summary,
    now: () => runAt,
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
  return new Request(url, {
    method,
    headers: {
      ...(authorization === "" ? {} : { authorization }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
}

Deno.test("rejects non-POST methods without invoking intelligence", async () => {
  let runCalls = 0;
  const response = await handler({
    run: async () => {
      runCalls += 1;
      return summary;
    },
  })(request(`Bearer ${secret}`, undefined, "GET"));

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(runCalls, 0);
});

Deno.test("rejects missing, malformed, and incorrect bearer credentials", async (test) => {
  const credentials: Array<[string, string]> = [
    ["missing", ""],
    ["wrong scheme", "Basic collector-secret"],
    ["empty bearer", "Bearer "],
    ["wrong bearer", "Bearer wrong-secret"],
  ];

  for (const [name, authorization] of credentials) {
    await test.step(name, async () => {
      let runCalls = 0;
      const response = await handler({
        run: async () => {
          runCalls += 1;
          return summary;
        },
      })(request(authorization));

      assert.equal(response.status, 401);
      assert.equal(runCalls, 0);
      const body = await response.text();
      assert.doesNotMatch(body, /collector-secret|wrong-secret/);
    });
  }
});

Deno.test("empty POST body runs at the current time", async () => {
  let receivedRunAt: Date | undefined;
  const response = await handler({
    run: async (value) => {
      receivedRunAt = value;
      return summary;
    },
  })(request());

  assert.equal(response.status, 200);
  assert.equal(receivedRunAt?.toISOString(), runAt.toISOString());
});

Deno.test("accepts an ISO as_of timestamp and passes it to the run", async () => {
  let receivedRunAt: Date | undefined;
  const response = await handler({
    run: async (value) => {
      receivedRunAt = value;
      return summary;
    },
  })(request(
    `Bearer ${secret}`,
    JSON.stringify({ as_of: "2026-09-18T03:04:05+00:00" }),
  ));

  assert.equal(response.status, 200);
  assert.equal(receivedRunAt?.toISOString(), "2026-09-18T03:04:05.000Z");
});

Deno.test(
  "rejects malformed or unsupported POST bodies without invoking intelligence",
  async (test) => {
  const bodies = [
    "{",
    "[]",
    "null",
    "{}",
    JSON.stringify({ as_of: "2026-09-18" }),
    JSON.stringify({ as_of: "not-a-timestamp" }),
    JSON.stringify({ as_of: 7 }),
    JSON.stringify({ as_of: "2026-09-18T12:00:00.000Z", extra: true }),
  ];

    for (const body of bodies) {
      await test.step(body, async () => {
        let runCalls = 0;
        const response = await handler({
          run: async () => {
            runCalls += 1;
            return summary;
          },
        })(request(`Bearer ${secret}`, body));

        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
          request_id: "req-123",
          error: { code: "INVALID_REQUEST", message: "Invalid request body" },
        });
        assert.equal(runCalls, 0);
      });
    }
  },
);

Deno.test("returns only the documented safe summary for a completed run", async () => {
  const response = await handler({
    run: async () => ({
      ...summary,
      upstreamSecret: "do-not-copy",
      rawPayload: { access_token: "do-not-copy" },
    } as IntelligenceRunSummary & Record<string, unknown>),
  })(request());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    request_id: "req-123",
    run_id: "run-123",
    status: "completed",
    clusters_processed: 3,
    candidates_upserted: 2,
  });
});

Deno.test("returns HTTP 202 when another intelligence run owns the lease", async () => {
  const response = await handler({
    run: async () => ({
      runId: "run-busy",
      status: "already_running",
      clustersProcessed: 0,
      candidatesUpserted: 0,
    }),
  })(request());

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    request_id: "req-123",
    run_id: "run-busy",
    status: "already_running",
    clusters_processed: 0,
    candidates_upserted: 0,
  });
});

Deno.test("maps run failures to a safe response and log", async () => {
  const logs: unknown[] = [];
  const response = await handler({
    log: (entry) => logs.push(entry),
    run: async () => {
      throw new Error("upstream payload with secret collector-secret");
    },
  })(request());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    request_id: "req-123",
    error: { code: "INTELLIGENCE_FAILED", message: "Intelligence run failed" },
  });
  assert.doesNotMatch(JSON.stringify(logs), /upstream payload|collector-secret/);
});
