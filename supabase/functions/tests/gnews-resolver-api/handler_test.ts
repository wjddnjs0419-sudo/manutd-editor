import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.8";
import { createGnewsResolverApiHandler } from "../../gnews-resolver-api/handler.ts";

const headers = { authorization: "Bearer worker-secret", "content-type": "application/json" };

Deno.test("resolver API rejects unauthenticated requests before calling Supabase", async () => {
  let calls = 0;
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "never-return-this-service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => { calls += 1; return Response.json({}); },
  });

  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "claim", request_id: "run-1", batch_size: 30 }),
  }));

  assertEquals(response.status, 401);
  assertEquals(calls, 0);
});

Deno.test("resolver API rejects disabled operation and oversized batches", async () => {
  const disabled = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: false,
  });
  const disabledResponse = await disabled(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: "run-1", batch_size: 30 }),
  }));
  assertEquals(disabledResponse.status, 503);

  let calls = 0;
  const enabled = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => { calls += 1; return Response.json({}); },
  });
  const oversized = await enabled(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: "run-2", batch_size: 31 }),
  }));
  assertEquals(oversized.status, 400);
  assertEquals(calls, 0);
});

Deno.test("claim response is bounded and never returns the service role key", async () => {
  let rpcPath = "";
  let rpcBody: Record<string, unknown> = {};
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "never-return-this-service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async (input, init) => {
      rpcPath = new URL(String(input)).pathname;
      rpcBody = JSON.parse(String(init?.body ?? "{}"));
      return Response.json({
        lease_id: "00000000-0000-4000-8000-000000000001",
        lease_expires_at: "2026-10-12T09:00:00Z",
        cooldown_until: null,
        items: [{
          id: "00000000-0000-4000-8000-000000000002",
          google_article_id: "article-123",
          original_google_news_url: "https://news.google.com/rss/articles/article-123",
          title: "Manchester United update",
          source_canonical_name: "BBC Sport",
          published_at: null,
          hidden_database_field: "must-not-be-forwarded",
        }],
      });
    },
  });

  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: "run-0003", batch_size: 30 }),
  }));
  const body = await response.text();

  assertEquals(response.status, 200);
  assertEquals(rpcPath, "/rest/v1/rpc/gnews_resolver_claim_batch");
  assertEquals(rpcBody.p_mode, "recent");
  assertStringIncludes(body, "article-123");
  assertEquals(body.includes("never-return-this-service-role-key"), false);
  assertEquals(body.includes("hidden_database_field"), false);
});

Deno.test("claim mode defaults to recent and only explicit backfill enters history", async () => {
  const modes: unknown[] = [];
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async (_input, init) => {
      modes.push((JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>).p_mode);
      return Response.json({ lease_id: null, lease_expires_at: null, cooldown_until: null, items: [] });
    },
  });
  const send = (requestId: string, mode?: string) => handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: requestId, batch_size: 30, ...(mode === undefined ? {} : { mode }) }),
  }));

  assertEquals((await send("default-mode-run")).status, 200);
  assertEquals((await send("explicit-backfill", "backfill")).status, 200);
  assertEquals((await send("invalid-mode-run", "all")).status, 400);
  assertEquals(modes, ["recent", "backfill"]);
});

Deno.test("claim response rejects a non-Google URL or mismatched article ID", async () => {
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => Response.json({
      lease_id: "00000000-0000-4000-8000-000000000001",
      lease_expires_at: "2026-10-12T09:00:00Z",
      cooldown_until: null,
      items: [{
        id: "00000000-0000-4000-8000-000000000002",
        google_article_id: "article-123",
        original_google_news_url: "https://attacker.example/rss/articles/article-123",
        title: "Manchester United update",
        source_canonical_name: "BBC Sport",
        published_at: null,
      }],
    }),
  });
  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: "run-invalid-claim", batch_size: 30 }),
  }));
  assertEquals(response.status, 502);
  assertEquals(await response.json(), { error: "API_INVALID_RESPONSE" });
});

Deno.test("completion rejects an unverified or non-HTTPS publisher URL", async () => {
  let calls = 0;
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => { calls += 1; return Response.json({}); },
  });
  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "complete",
      request_id: "run-4-complete",
      lease_id: "00000000-0000-4000-8000-000000000001",
      results: [{
        id: "00000000-0000-4000-8000-000000000002",
        url_resolution_status: "RESOLVED",
        resolved_publisher_url: "http://publisher.example/article",
        article_fetch_status: "NOT_ATTEMPTED",
        article_extraction_status: "NOT_ATTEMPTED",
        article_content_excerpt: null,
        safe_error_category: null,
      }],
      unprocessed_ids: [],
      global_cooldown_seconds: 0,
    }),
  }));

  assertEquals(response.status, 400);
  assertEquals(calls, 0);
});

Deno.test("completion accepts a 2000-character excerpt containing supplementary Unicode", async () => {
  let rpcPath = "";
  let rpcBody: Record<string, unknown> = {};
  const excerpt = "🦁".repeat(2_000);
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: (input, init) => {
      rpcPath = new URL(String(input)).pathname;
      rpcBody = JSON.parse(String(init?.body ?? "{}"));
      return Promise.resolve(Response.json({ status: "COMPLETED" }));
    },
  });
  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "complete",
      request_id: "run-unicode-excerpt",
      lease_id: "00000000-0000-4000-8000-000000000001",
      results: [{
        id: "00000000-0000-4000-8000-000000000002",
        url_resolution_status: "RESOLVED",
        resolved_publisher_url: "https://publisher.example/article",
        article_fetch_status: "FETCHED",
        article_extraction_status: "EXTRACTED",
        article_final_url: "https://publisher.example/article",
        article_content_excerpt: excerpt,
        safe_error_category: null,
      }],
      unprocessed_ids: [],
      global_cooldown_seconds: 0,
    }),
  }));

  assertEquals(response.status, 200);
  assertEquals(rpcPath, "/rest/v1/rpc/gnews_resolver_complete_batch");
  const results = rpcBody.p_results as Array<Record<string, unknown>>;
  assertEquals(results[0]?.article_content_excerpt, excerpt);
});

Deno.test("completion reports a safe reason for an invalid result without echoing article data", async () => {
  let calls = 0;
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => { calls += 1; return Response.json({}); },
  });
  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "complete",
      request_id: "run-5-complete",
      lease_id: "00000000-0000-4000-8000-000000000001",
      results: [{
        id: "00000000-0000-4000-8000-000000000002",
        url_resolution_status: "RESOLVED",
        resolved_publisher_url: "https://publisher.example/article",
        article_fetch_status: "FETCHED",
        article_extraction_status: "EXTRACTED",
        article_final_url: "https://publisher.example/article",
        article_content_excerpt: "   ",
        private_article_text: "must not be reflected in the response",
        safe_error_category: null,
      }],
      unprocessed_ids: [],
      global_cooldown_seconds: 0,
    }),
  }));

  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: "INVALID_RESULTS",
    invalid_results: [{ index: 0, reason: "EMPTY_EXTRACTED_ARTICLE_BODY" }],
  });
  assertEquals(calls, 0);
});

Deno.test("completion surfaces an expired lease as a conflict for safe worker restart", async () => {
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => Response.json({ status: "LEASE_EXPIRED" }),
  });
  const response = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "complete", request_id: "run-expired-lease", lease_id: "00000000-0000-4000-8000-000000000001", results: [], unprocessed_ids: [], global_cooldown_seconds: 0 }),
  }));
  assertEquals(response.status, 409);
  assertEquals(await response.json(), { error: "LEASE_EXPIRED" });
});

Deno.test("resolver API applies its request-size cap and maps database rate limits", async () => {
  let calls = 0;
  const handler = createGnewsResolverApiHandler({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role-key",
    workerToken: "worker-secret",
    enabled: true,
    fetch: async () => {
      calls += 1;
      return Response.json({ rate_limited: true, retry_after_seconds: 60 });
    },
  });
  const oversized = await handler(new Request("https://edge.test", {
    method: "POST",
    headers: { ...headers, "content-length": "800001" },
    body: JSON.stringify({ action: "claim", request_id: "large-request", batch_size: 30 }),
  }));
  assertEquals(oversized.status, 413);
  assertEquals(calls, 0);

  const limited = await handler(new Request("https://edge.test", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "claim", request_id: "limited-request", batch_size: 30 }),
  }));
  assertEquals(limited.status, 429);
  assertEquals(limited.headers.get("retry-after"), "60");
});
