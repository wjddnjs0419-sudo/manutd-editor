import assert from "node:assert/strict";
import { runSourceDiscovery } from "../../source-discovery/orchestrator.ts";
import type { SourceDiscoveryRepository, SourceFeed } from "../../source-discovery/types.ts";

const feeds: readonly SourceFeed[] = [
  { canonicalName: "BBC Sport", editorialRole: "FACT_INDEPENDENT", entityType: "MEDIA_OUTLET", url: "https://bbc.test/feed" },
  { canonicalName: "r/reddevils", editorialRole: "DISCOVERY_COMMUNITY", entityType: "OTHER", url: "https://reddit.test/feed" },
];

Deno.test("source discovery isolates feed failures and deduplicates observations", async () => {
  const saved: string[] = [];
  const repository: SourceDiscoveryRepository = {
    ensureSource: async (feed) => feed.canonicalName,
    saveObservation: async (observation) => {
      saved.push(observation.externalId);
      return observation.externalId !== "duplicate";
    },
  };
  const result = await runSourceDiscovery({
    repository,
    feeds,
    now: () => new Date("2026-09-27T02:00:00Z"),
    fetch: async (url) => {
      if (String(url).includes("reddit")) throw new Error("upstream body must not escape");
      return new Response(`<rss><item><guid>duplicate</guid><title>Official report</title><link>https://bbc.test/1</link></item><item><guid>new</guid><title>Second report</title><link>https://bbc.test/2</link></item></rss>`);
    },
    maxItems: 5,
    maxBytes: 10_000,
    timeoutMs: 100,
  });

  assert.equal(result.status, "COMPLETED");
  assert.equal(result.observed, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.failedFeeds, 1);
  assert(saved.includes("new"));
  assert(!JSON.stringify(result).includes("upstream body"));
});

Deno.test("missing feeds are a successful NOOP", async () => {
  const result = await runSourceDiscovery({
    repository: { ensureSource: async () => "unused", saveObservation: async () => true },
    feeds: [],
    now: () => new Date("2026-09-27T02:00:00Z"),
    fetch: fetch,
    maxItems: 5,
    maxBytes: 10_000,
    timeoutMs: 100,
  });
  assert.deepEqual(result, { status: "NOOP", observed: 0, duplicates: 0, failedFeeds: 0, feedCount: 0 });
});

Deno.test("fact feeds enrich RSS summaries with bounded article paragraphs", async () => {
  let savedExcerpt: string | null = null;
  const repository: SourceDiscoveryRepository = {
    ensureSource: async () => "bbc-source",
    saveObservation: async (observation) => {
      savedExcerpt = observation.excerpt;
      return true;
    },
  };
  const result = await runSourceDiscovery({
    repository,
    feeds: [feeds[0]],
    now: () => new Date("2026-09-27T02:00:00Z"),
    fetch: async (url) => String(url).includes("/article/")
      ? new Response("<article><p>United tried to build from the back with shorter passes.</p><p>The manager adjusted the defensive shape after the draw.</p></article>")
      : new Response("<rss><item><guid>article-1</guid><title>United tactical report</title><description>Short RSS summary.</description><link>https://bbc.test/article/1</link></item></rss>"),
    maxItems: 5,
    maxBytes: 10_000,
    maxExcerptChars: 180,
    timeoutMs: 100,
  });

  assert.equal(result.observed, 1);
  assert.equal(savedExcerpt, "United tried to build from the back with shorter passes. The manager adjusted the defensive shape after the draw.");
});
