import { assert, assertEquals } from "jsr:@std/assert@1.0.8";
import { createGoogleNewsDiscoveryProvider } from "../../trend-discovery/google_news_provider.ts";
import { createGdeltDiscoveryProvider } from "../../trend-discovery/gdelt_provider.ts";
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
  assertEquals(result[0].metadata, { feed_url: "https://news.google.com/rss/search", format: "RSS" });
});

Deno.test("Google News results retain the article publisher separately from the discovery provider", async () => {
  const provider = createGoogleNewsDiscoveryProvider({
    fetch: () => Promise.resolve(new Response(`<rss><channel>${rssItem("goal-1").replace("</item>", '<source url="https://www.goal.com">Goal.com</source></item>')}</channel></rss>`)),
    now: () => new Date("2026-09-29T12:01:00.000Z"),
  });
  const [result] = await provider.discover(query);
  assertEquals(result?.providerId, "google-news");
  assertEquals(result?.sourceCanonicalName, "Goal.com");
  assertEquals(result?.sourceRole, "DISCOVERY_COMMUNITY");
  assertEquals(result?.metadata.publisher_url, "https://www.goal.com/");
});

Deno.test("GDELT DOC uses fixed structured endpoint, bounded dates and safe article fields", async () => {
  let requested = "";
  const provider = createGdeltDiscoveryProvider({
    fetch: (input, init) => {
      requested = String(input);
      assertEquals(init?.redirect, "manual");
      return Promise.resolve(Response.json({
        articles: [
          {
            url: "https://example.test/inside",
            title: "Manchester United inside",
            seendate: "20260929T120000Z",
            domain: "example.test",
            language: "English",
            socialimage: "https://example.test/image.jpg",
          },
          {
            url: "https://example.test/before",
            title: "Manchester United before",
            seendate: "20260929T085959Z",
          },
          {
            url: "https://example.test/undated",
            title: "Manchester United undated",
          },
          {
            url: "http://unsafe.test/item",
            title: "Manchester United unsafe",
            seendate: "20260929T100000Z",
          },
          {
            url: "https://user:password@example.test/credentialed",
            title: "Manchester United credentialed",
            seendate: "20260929T100000Z",
          },
        ],
      }));
    },
    now: () => new Date("2026-09-29T12:01:00.000Z"),
  });
  const result = await provider.discover(query);
  const url = new URL(requested);
  assertEquals(url.origin, "https://api.gdeltproject.org");
  assertEquals(url.pathname, "/api/v2/doc/doc");
  assertEquals(url.searchParams.get("mode"), "artlist");
  assertEquals(url.searchParams.get("format"), "json");
  assertEquals(url.searchParams.get("maxrecords"), "20");
  assertEquals(url.searchParams.get("startdatetime"), "20260929090000");
  assertEquals(url.searchParams.get("enddatetime"), "20260929120000");
  assertEquals(result.map((item) => item.canonicalUrl), [
    "https://example.test/inside",
    "https://example.test/undated",
  ]);
  assertEquals(result[0].publishedAt, "2026-09-29T12:00:00.000Z");
  assertEquals(result[1].publishedAt, null);
  assertEquals(result[0].providerId, "gdelt-doc");
  assertEquals(result[0].sourceRole, "DISCOVERY_COMMUNITY");
  assertEquals(result[0].platform, "WEB");
  assertEquals(result[0].metadata, {
    domain: "example.test",
    language: "English",
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
  const gdelt = createGdeltDiscoveryProvider({
    maxItems: 2,
    fetch: () =>
      Promise.resolve(
        Response.json({
          articles: [1, 2, 3].map((id) => ({
            url: `https://example.test/${id}`,
            title: `Manchester United ${id}`,
          })),
        }),
      ),
  });
  assertEquals((await gdelt.discover(query)).length, 2);
});

Deno.test("search providers isolate 429, 5xx, redirects, and timeout failures", async () => {
  for (
    const create of [
      createGoogleNewsDiscoveryProvider,
      createGdeltDiscoveryProvider,
    ]
  ) {
    for (const status of [429, 503, 302]) {
      const provider = create({
        fetch: () => Promise.resolve(new Response("unavailable", { status })),
      });
      assertEquals(await provider.discover(query), []);
    }
    const provider = create({
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
  }
});

Deno.test("invalid query bounds never trigger provider fetch", async () => {
  let calls = 0;
  const provider = createGdeltDiscoveryProvider({
    fetch: () => {
      calls++;
      return Promise.resolve(Response.json({ articles: [] }));
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
