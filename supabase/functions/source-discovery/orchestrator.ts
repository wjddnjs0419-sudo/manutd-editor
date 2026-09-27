import { parseFeedDocument } from "./feed_parser.ts";
import { extractArticleExcerpt } from "./article_extractor.ts";
import type { SourceDiscoveryRepository, SourceDiscoveryRunInput, SourceDiscoverySummary, SourceFeed } from "./types.ts";

interface RunSourceDiscoveryOptions extends SourceDiscoveryRunInput {
  readonly repository: SourceDiscoveryRepository;
  readonly feeds: readonly SourceFeed[];
  readonly fetch: typeof fetch;
  readonly now: () => Date;
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly maxExcerptChars?: number;
  readonly timeoutMs: number;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function safeCategory(error: unknown): string {
  if (error instanceof Error && ["BODY_TOO_LARGE", "INVALID_FEED_URL"].includes(error.message)) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") return "UPSTREAM_TIMEOUT";
  return "FEED_UNAVAILABLE";
}

function isFactRole(feed: SourceFeed): boolean {
  return feed.editorialRole === "FACT_PRIMARY" || feed.editorialRole === "FACT_INDEPENDENT";
}

async function articleExcerpt(
  options: RunSourceDiscoveryOptions,
  feed: SourceFeed,
  url: string,
): Promise<string | null> {
  if (!isFactRole(feed)) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetch(url, {
      method: "GET",
      headers: { accept: "text/html,application/xhtml+xml" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const html = await readBounded(response, options.maxBytes);
    return extractArticleExcerpt(html, options.maxExcerptChars ?? 600);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runSourceDiscovery(options: RunSourceDiscoveryOptions): Promise<SourceDiscoverySummary> {
  if (options.feeds.length === 0) return { status: "NOOP", observed: 0, duplicates: 0, failedFeeds: 0, feedCount: 0 };
  const limit = options.limit ?? options.maxItems;
  let observed = 0;
  let duplicates = 0;
  let failedFeeds = 0;
  for (const feed of options.feeds) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetch(feed.url, { method: "GET", headers: { accept: "application/rss+xml, application/atom+xml, text/xml, text/html" }, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP_${Math.floor(response.status / 100)}XX`);
      const xml = await readBounded(response, options.maxBytes);
      const sourceId = await options.repository.ensureSource(feed);
      const items = await parseFeedDocument(xml, feed, { maxItems: Math.min(options.maxItems, limit), maxExcerptChars: options.maxExcerptChars ?? 600 });
      for (const item of items) {
        if (options.asOf && item.publishedAt && new Date(item.publishedAt).getTime() > options.asOf.getTime()) continue;
        const fetchedExcerpt = await articleExcerpt(options, feed, item.canonicalUrl);
        const enrichedItem = fetchedExcerpt && fetchedExcerpt.length > (item.excerpt?.length ?? 0)
          ? { ...item, excerpt: fetchedExcerpt }
          : item;
        const inserted = await options.repository.saveObservation({ ...enrichedItem, informationSourceId: sourceId, observedAt: options.now().toISOString() });
        if (inserted) observed += 1;
        else duplicates += 1;
      }
    } catch (error) {
      failedFeeds += 1;
      void safeCategory(error);
    } finally {
      clearTimeout(timeout);
    }
  }
  return { status: "COMPLETED", observed, duplicates, failedFeeds, feedCount: options.feeds.length };
}
