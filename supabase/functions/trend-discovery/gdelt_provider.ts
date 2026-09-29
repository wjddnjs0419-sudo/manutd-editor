import type {
  DiscoveryObservation,
  DiscoveryProvider,
  DiscoveryQuery,
} from "./types.ts";
import { normalizeDiscoveryObservation } from "./normalization.ts";
import {
  asGdeltTimestamp,
  boundedItemCount,
  fetchBoundedText,
  inWindow,
  parseGdeltDate,
  safeHttpsUrl,
  safeText,
  validWindow,
} from "./search_provider_http.ts";

export interface GdeltProviderOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxItems?: number;
  readonly now?: () => Date;
}

const provider = {
  providerId: "gdelt-doc",
  sourceRole: "DISCOVERY_COMMUNITY",
  platform: "WEB",
} as const;

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function articleMetadata(
  article: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const result: Record<string, string> = {};
  for (const key of ["domain", "language"] as const) {
    const value = safeText(article[key], 100);
    if (value) result[key] = value;
  }
  return result;
}

export function createGdeltDiscoveryProvider(
  options: GdeltProviderOptions = {},
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
      const url = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
      url.searchParams.set("query", text);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", String(maxItems));
      url.searchParams.set("sort", "datedesc");
      url.searchParams.set("startdatetime", asGdeltTimestamp(window.start));
      url.searchParams.set("enddatetime", asGdeltTimestamp(window.end));
      const body = await fetchBoundedText(url, options);
      if (body === null) return [];
      let articles: unknown[];
      try {
        const parsed: unknown = JSON.parse(body);
        const items = object(parsed).articles;
        if (!Array.isArray(items)) return [];
        articles = items.slice(0, maxItems);
      } catch {
        return [];
      }
      const observedAt = (options.now?.() ?? new Date()).toISOString();
      const result: DiscoveryObservation[] = [];
      for (const value of articles) {
        const article = object(value);
        const canonicalUrl = safeText(article.url, 2_000);
        const title = safeText(article.title, 500);
        if (!canonicalUrl || !safeHttpsUrl(canonicalUrl) || !title) continue;
        const publishedAt = parseGdeltDate(article.seendate);
        const normalized = await normalizeDiscoveryObservation({
          externalId: canonicalUrl,
          canonicalUrl,
          title,
          excerpt: null,
          publishedAt,
          sourceCanonicalName: "GDELT",
          metadata: articleMetadata(article),
        }, { provider, query, observedAt });
        if (normalized && inWindow(normalized.publishedAt, window)) {
          result.push(normalized);
        }
      }
      return result;
    },
  };
}
