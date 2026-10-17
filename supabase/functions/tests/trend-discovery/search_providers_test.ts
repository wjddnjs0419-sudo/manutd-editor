import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { createGoogleNewsDiscoveryProvider } from "../../trend-discovery/google_news_provider.ts";
import type { DiscoveryQuery } from "../../trend-discovery/types.ts";

const query: DiscoveryQuery = {
  queryId: "q-1",
  text: '"Bruno Fernandes" Manchester United',
  family: "PLAYER",
  mode: "PLAYERS",
  window: "HOT",
  windowStart: "2026-09-29T09:00:00.000Z",
  windowEnd: "2026-09-29T12:00:00.000Z",
  priority: 90,
};

function rssItem(
  id: string,
  date?: string,
  link = `https://news.google.com/rss/articles/${id}`,
): string {
  return `<item><guid>${id}</guid><title>Manchester United ${id} &amp; update</title><link>${link}</link><description>Team news</description>${
    date ? `<pubDate>${date}</pubDate>` : ""
  }</item>`;
}

Deno.test("Google News uses fixed RSS search, normalizes dates and retains undated items", async () => {
  let requested = "";
  const provider = createGoogleNewsDiscoveryProvider({
    fetch: (input, init) => {
      requested = String(input);
      assertEquals(init?.redirect, "manual");
      return Promise.resolve(
        new Response(
          `<rss><channel>${rssItem("inside", "Tue, 29 Sep 2026 10:00:00 GMT")}${
            rssItem("before", "Tue, 29 Sep 2026 08:59:59 GMT")
          }${rssItem("undated")}${
            rssItem(
              "unsafe",
              "Tue, 29 Sep 2026 10:00:00 GMT",
              "http://unsafe.test/x",
            )
          }${
            rssItem(
              "credentialed",
              "Tue, 29 Sep 2026 10:00:00 GMT",
              "https://user:password@example.test/story",
            )
          }</channel></rss>`,
        ),
      );
    },
    now: () => new Date("2026-09-29T12:01:00.000Z"),
  });
  const result = await provider.discover(query);
  const url = new URL(requested);
  assertEquals(url.origin, "https://news.google.com");
  assertEquals(url.pathname, "/rss/search");
  assertEquals(url.searchParams.get("q"), query.text);
  assertEquals(result.map((item) => item.externalId), ["inside", "undated"]);
  assertEquals(result[0].publishedAt, "2026-09-29T10:00:00.000Z");
  assertEquals(result[1].publishedAt, null);
  assertEquals(result[1].observedAt, "2026-09-29T12:01:00.000Z");
  assertEquals(result[0].providerId, "google-news");
  assertEquals(result[0].sourceRole, "DISCOVERY_COMMUNITY");
  assertEquals(result[0].platform, "RSS");
  assertEquals(result[0].metadata, {
    feed_url: "https://news.google.com/rss/search",
    format: "RSS",
  });
});

Deno.test("search providers cap response bytes and results", async () => {
  const big = createGoogleNewsDiscoveryProvider({
    maxBytes: 50,
    fetch: () => Promise.resolve(new Response(`<rss>${"x".repeat(100)}</rss>`)),
  });
  assertEquals(await big.discover(query), []);
  const bounded = createGoogleNewsDiscoveryProvider({
    maxItems: 2,
    fetch: () =>
      Promise.resolve(
        new Response(
          `<rss><channel>${rssItem("a")}${rssItem("b")}${
            rssItem("c")
          }</channel></rss>`,
        ),
      ),
  });
  assertEquals((await bounded.discover(query)).map((item) => item.externalId), [
    "a",
    "b",
  ]);
});

Deno.test("search providers isolate 429, 5xx, redirects, and timeout failures", async () => {
  for (const status of [429, 503, 302]) {
    const provider = createGoogleNewsDiscoveryProvider({
      fetch: () => Promise.resolve(new Response("unavailable", { status })),
    });
    assertEquals(await provider.discover(query), []);
  }
  const provider = createGoogleNewsDiscoveryProvider({
    timeoutMs: 5,
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  assertEquals(await provider.discover(query), []);
});

Deno.test("invalid query bounds never trigger provider fetch", async () => {
  let calls = 0;
  const provider = createGoogleNewsDiscoveryProvider({
    fetch: () => {
      calls++;
      return Promise.resolve(new Response(`<rss><channel>${rssItem("invalid")}</channel></rss>`));
    },
  });
  assertEquals(
    await provider.discover({
      ...query,
      windowStart: query.windowEnd,
      windowEnd: query.windowStart,
    }),
    [],
  );
  assertEquals(calls, 0);
});
