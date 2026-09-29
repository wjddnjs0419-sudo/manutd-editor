import { parseFeedDocument } from "../source-discovery/feed_parser.ts";
import type {
  DiscoveryObservation,
  DiscoveryProvider,
  DiscoveryQuery,
} from "./types.ts";
import { normalizeDiscoveryObservation } from "./normalization.ts";
import {
  boundedItemCount,
  fetchBoundedText,
  inWindow,
  safeHttpsUrl,
  safeText,
  validWindow,
} from "./search_provider_http.ts";

export interface GoogleNewsProviderOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxItems?: number;
  readonly now?: () => Date;
}

const provider = {
  providerId: "google-news",
  sourceRole: "DISCOVERY_COMMUNITY",
  platform: "RSS",
} as const;

export function createGoogleNewsDiscoveryProvider(
  options: GoogleNewsProviderOptions = {},
): DiscoveryProvider {
  const maxItems = boundedItemCount(options.maxItems);
  return {
    ...provider,
    async discover(
      query: DiscoveryQuery,
    ): Promise<readonly DiscoveryObservation[]> {
      const window = validWindow(query.windowStart, query.windowEnd);
      const text = safeText(query.text, 300);
      if (!window || !text) return [];
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", text);
      url.searchParams.set("hl", "en-US");
      url.searchParams.set("gl", "US");
      url.searchParams.set("ceid", "US:en");
      const document = await fetchBoundedText(url, options);
      if (document === null) return [];
      try {
        const feed = await parseFeedDocument(document, {
          canonicalName: "Google News",
          editorialRole: provider.sourceRole,
          entityType: "MEDIA_OUTLET",
          url: "https://news.google.com/rss/search",
          format: "RSS",
        }, { maxItems, maxExcerptChars: 600 });
        const observedAt = (options.now?.() ?? new Date()).toISOString();
        const result: DiscoveryObservation[] = [];
        for (const item of feed) {
          if (!safeHttpsUrl(item.canonicalUrl)) continue;
          const normalized = await normalizeDiscoveryObservation({
            ...item,
            metadata: {},
          }, { provider, query, observedAt });
          if (normalized && inWindow(normalized.publishedAt, window)) {
            result.push(normalized);
          }
        }
        return result.slice(0, maxItems);
      } catch {
        return [];
      }
    },
  };
}
