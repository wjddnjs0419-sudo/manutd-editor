import assert from "node:assert/strict";

import {
  createMetaClient,
  MetaApiError,
} from "../../collect-instagram/meta_client.ts";

const successPayload = {
  business_discovery: {
    id: "17841400000000001",
    username: "utdreport",
    media: { data: [] },
  },
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

Deno.test("builds the configured Business Discovery request and returns decoded JSON", async () => {
  let requestedUrl: URL | undefined;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: (input) => {
      requestedUrl = new URL(String(input));
      return Promise.resolve(jsonResponse(successPayload));
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

  const result = await client.fetchAccount("utdreport");

  assert.deepEqual(result, successPayload);
  assert.equal(requestedUrl?.origin, "https://graph.facebook.com");
  assert.equal(requestedUrl?.pathname, "/v99.0/business-account-id");
  assert.equal(
    requestedUrl?.searchParams.get("access_token"),
    "meta-secret-token",
  );
  const fields = requestedUrl?.searchParams.get("fields") ?? "";
  assert.match(fields, /^business_discovery\.username\(utdreport\)/);
  assert.match(fields, /media\.limit\(25\)/);
  assert.match(fields, /media_product_type/);
  assert.match(fields, /views/);
});

Deno.test("uses Retry-After for a 429 response before retrying", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? jsonResponse(
            { error: { message: "do not expose this body" } },
            429,
            {
              "retry-after": "2",
            },
          )
          : jsonResponse(successPayload),
      );
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
    random: () => 0.75,
  });

  await client.fetchAccount("utdreport");

  assert.equal(attempts, 2);
  assert.deepEqual(sleeps, [2_000]);
});

Deno.test("retries transient 5xx responses at most three total attempts", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        attempts < 3
          ? jsonResponse({ error: { message: "temporary" } }, 503)
          : jsonResponse(successPayload),
      );
    },
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      return Promise.resolve();
    },
    random: () => 0,
  });

  await client.fetchAccount("utdreport");

  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [500, 1_000]);
});

Deno.test("retries thrown network failures and succeeds on the third attempt", async () => {
  let attempts = 0;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return attempts < 3
        ? Promise.reject(
          new TypeError("socket included sensitive infrastructure details"),
        )
        : Promise.resolve(jsonResponse(successPayload));
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

  await client.fetchAccount("utdreport");

  assert.equal(attempts, 3);
});

Deno.test("does not retry permanent Meta errors and redacts secret material", async () => {
  let attempts = 0;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        jsonResponse(
          {
            error: {
              message: "raw body contains meta-secret-token and private detail",
            },
          },
          401,
        ),
      );
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

  await assert.rejects(
    client.fetchAccount("utdreport"),
    (error: unknown) => {
      assert.ok(error instanceof MetaApiError);
      assert.equal(error.code, "META_HTTP_ERROR");
      assert.equal(error.status, 401);
      assert.equal(error.retriable, false);
      assert.equal(error.category, "permission");
      assert.doesNotMatch(error.message, /meta-secret-token|private detail/);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

Deno.test("classifies Meta failures from safe status and numeric error fields", async () => {
  const cases = [
    {
      status: 400,
      body: { error: { code: 100, message: "secret unsupported detail" } },
      category: "unsupported_account",
      retriable: false,
    },
    {
      status: 403,
      body: { error: { code: 10, message: "secret permission detail" } },
      category: "permission",
      retriable: false,
    },
    {
      status: 429,
      body: { error: { code: 4, message: "secret rate detail" } },
      category: "rate_limited",
      retriable: true,
    },
    {
      status: 503,
      body: { error: { message: "secret upstream detail" } },
      category: "temporary_upstream",
      retriable: true,
    },
  ] as const;

  for (const testCase of cases) {
    const client = createMetaClient({
      accessToken: "meta-secret-token",
      businessAccountId: "business-account-id",
      apiVersion: "v99.0",
      mediaLimit: 25,
      fetch: () =>
        Promise.resolve(jsonResponse(testCase.body, testCase.status)),
      sleep: () => Promise.resolve(),
      random: () => 0,
    });

    await assert.rejects(
      client.fetchAccount("utdreport"),
      (error: unknown) => {
        assert.ok(error instanceof MetaApiError);
        assert.equal(error.category, testCase.category);
        assert.equal(error.retriable, testCase.retriable);
        assert.doesNotMatch(
          JSON.stringify({
            name: error.name,
            message: error.message,
            code: error.code,
            category: error.category,
          }),
          /meta-secret-token|secret .* detail/,
        );
        return true;
      },
    );
  }
});

Deno.test("an aborted account request stops without retry or sleep", async () => {
  let attempts = 0;
  let sleeps = 0;
  const controller = new AbortController();
  controller.abort();
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return Promise.reject(
        new DOMException("private abort detail", "AbortError"),
      );
    },
    sleep: () => {
      sleeps += 1;
      return Promise.resolve();
    },
    random: () => 0,
  });

  await assert.rejects(
    client.fetchAccount("utdreport", { signal: controller.signal }),
    (error: unknown) =>
      error instanceof MetaApiError &&
      error.category === "temporary_upstream" &&
      error.retriable === false &&
      !error.message.includes("private abort detail"),
  );
  assert.equal(attempts, 0);
  assert.equal(sleeps, 0);
});

Deno.test("stops after three transient failures with a safe error", async () => {
  let attempts = 0;
  const client = createMetaClient({
    accessToken: "meta-secret-token",
    businessAccountId: "business-account-id",
    apiVersion: "v99.0",
    mediaLimit: 25,
    fetch: () => {
      attempts += 1;
      return Promise.resolve(
        jsonResponse({ error: { message: "private detail" } }, 500),
      );
    },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });

  await assert.rejects(
    client.fetchAccount("utdreport"),
    (error: unknown) =>
      error instanceof MetaApiError &&
      error.code === "META_HTTP_ERROR" &&
      error.status === 500 &&
      error.retriable,
  );
  assert.equal(attempts, 3);
});
