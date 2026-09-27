import assert from "node:assert/strict";
import { parseFeedDocument } from "../../source-discovery/feed_parser.ts";
import type { SourceFeed } from "../../source-discovery/types.ts";

const feed: SourceFeed = {
  canonicalName: "BBC Sport",
  editorialRole: "FACT_INDEPENDENT",
  entityType: "MEDIA_OUTLET",
  url: "https://example.test/feed.xml",
};

Deno.test("parseFeedDocument extracts bounded RSS observations", async () => {
  const result = await parseFeedDocument(`<?xml version="1.0"?><rss><channel>
    <item><guid>bbc-1</guid><title>United update &amp; context</title>
      <link>https://example.test/story/1</link>
      <description><![CDATA[<p>Short report about Manchester United.</p>]]></description>
      <pubDate>Sat, 27 Sep 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`, feed, { maxItems: 5, maxExcerptChars: 200 });

  assert.equal(result.length, 1);
  assert.equal(result[0].externalId, "bbc-1");
  assert.equal(result[0].title, "United update & context");
  assert.equal(result[0].canonicalUrl, "https://example.test/story/1");
  assert(result[0].excerpt?.includes("Short report about Manchester United."));
  assert.equal(result[0].editorialRole, "FACT_INDEPENDENT");
});

Deno.test("parseFeedDocument limits broad feeds to configured Manchester United terms", async () => {
  const result = await parseFeedDocument(`<rss><channel>
    <item><guid>mu-1</guid><title>Manchester United team news</title><link>https://example.test/mu</link></item>
    <item><guid>other-1</guid><title>Another club makes a signing</title><link>https://example.test/other</link></item>
  </channel></rss>`, { ...feed, includeTerms: ["Manchester United", "Old Trafford"] }, { maxItems: 5, maxExcerptChars: 200 });

  assert.equal(result.length, 1);
  assert.equal(result[0].externalId, "mu-1");
});

Deno.test("parseFeedDocument handles Atom entries and bounds text", async () => {
  const result = await parseFeedDocument(`<feed>
    <entry><id>tag:example.test,2026:2</id><title>Atom item</title>
      <link href="https://example.test/atom/2" />
      <summary>${"x".repeat(100)}</summary><updated>2026-09-27T01:00:00Z</updated>
    </entry></feed>`, feed, { maxItems: 5, maxExcerptChars: 20 });

  assert.equal(result.length, 1);
  assert.equal(result[0].externalId, "tag:example.test,2026:2");
  assert.equal(result[0].excerpt?.length, 20);
});

Deno.test("parseFeedDocument extracts bounded official Manchester United HTML cards", async () => {
  const result = await parseFeedDocument(`<main>
    <a data-testid="article-card__floating-link" href="/en/news/team-news"><span>Team news: United v City</span></a>
    <a data-testid="article-card__floating-link" href="/en/news/team-news"><span>Team news: United v City</span></a>
    <a data-testid="article-card__floating-link" href="/en/news/press-conference"><span>Carrick: We are ready</span></a>
  </main>`, { ...feed, canonicalName: "Manchester United", editorialRole: "FACT_PRIMARY", entityType: "CLUB", url: "https://www.manutd.com/en/news/category/news", format: "HTML" }, { maxItems: 5, maxExcerptChars: 200 });

  assert.equal(result.length, 2);
  assert.equal(result[0].title, "Team news: United v City");
  assert.equal(result[0].canonicalUrl, "https://www.manutd.com/en/news/team-news");
  assert.equal(result[0].metadata.format, "HTML");
  assert.equal(result[0].editorialRole, "FACT_PRIMARY");
});

Deno.test("parseFeedDocument rejects unsafe feed URLs and malformed entries", async () => {
  await assertRejects(() => parseFeedDocument("<rss><item><title>x</title></item></rss>", { ...feed, url: "http://127.0.0.1/feed" }, { maxItems: 5, maxExcerptChars: 20 }), "INVALID_FEED_URL");
  const result = await parseFeedDocument("<rss><item><title>missing identity</title></item></rss>", feed, { maxItems: 5, maxExcerptChars: 20 });
  assert.deepEqual(result, []);
});

async function assertRejects(operation: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await operation();
    throw new Error("expected rejection");
  } catch (error) {
    assert.equal(error instanceof Error ? error.message : String(error), message);
  }
}
