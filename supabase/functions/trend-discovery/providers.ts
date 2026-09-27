import { parseFeedDocument } from "../source-discovery/feed_parser.ts";
import type { SourceFeed } from "../source-discovery/types.ts";
import type { DiscoveryObservation, DiscoveryProvider, DiscoveryQuery } from "./types.ts";
import { normalizeDiscoveryObservation } from "./normalization.ts";

interface FeedProviderOptions {
  readonly providerId: string;
  readonly sourceRole: DiscoveryProvider["sourceRole"];
  readonly platform: DiscoveryProvider["platform"];
  readonly feed: SourceFeed;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxItems?: number;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const body = await response.arrayBuffer();
  if (body.byteLength > maxBytes) throw new Error("BODY_TOO_LARGE");
  return new TextDecoder().decode(body);
}

export function createFeedDiscoveryProvider(options: FeedProviderOptions): DiscoveryProvider {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxBytes = options.maxBytes ?? 200_000;
  const maxItems = options.maxItems ?? 20;
  return {
    providerId: options.providerId,
    sourceRole: options.sourceRole,
    platform: options.platform,
    async discover(query: DiscoveryQuery): Promise<readonly DiscoveryObservation[]> {
      const url = options.feed.url.includes("{query}") ? options.feed.url.replaceAll("{query}", encodeURIComponent(query.text)) : options.feed.url;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "GET", headers: { accept: "application/rss+xml, application/atom+xml, text/xml, text/html" }, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP_${Math.floor(response.status / 100)}XX`);
        const document = await readBounded(response, maxBytes);
        const parsed = await parseFeedDocument(document, { ...options.feed, editorialRole: options.sourceRole }, { maxItems, maxExcerptChars: 600 });
        const result: DiscoveryObservation[] = [];
        for (const item of parsed) {
          const normalized = await normalizeDiscoveryObservation(item, { provider: options, query, observedAt: new Date().toISOString() });
          if (normalized) result.push(normalized);
        }
        return result;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
