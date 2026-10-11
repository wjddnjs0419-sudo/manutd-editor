import { resolveGoogleNewsArticleUrl, isGoogleNewsArticleUrl } from "./google_news_resolution.ts";
import { extractArticleExcerpt } from "../source-discovery/article_extractor.ts";
import type { DiscoveryObservation } from "./types.ts";
import { fetchBoundedText, safeHttpsUrl } from "./search_provider_http.ts";

export interface ArticleEnricherOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxExcerptChars?: number;
}

export type ArticleEnricher = (observation: DiscoveryObservation) => Promise<DiscoveryObservation>;

export function createArticleEnricher(options: ArticleEnricherOptions = {}): ArticleEnricher {
  const maxExcerptChars = options.maxExcerptChars ?? 6_000;
  return async (observation) => {
    const originalUrl = safeHttpsUrl(observation.canonicalUrl);
    if (!originalUrl) return observation;
    // Google News URL conversion and publisher fetch are handled by the
    // separately leased GitHub worker; Edge must preserve the RSS URL.
    if (isGoogleNewsArticleUrl(originalUrl)) return observation;
    const body = await fetchBoundedText(new URL(originalUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes ?? 650_000,
      accept: "text/html,application/xhtml+xml",
    });
    if (!body) return observation;
    const articleExcerpt = extractArticleExcerpt(body, maxExcerptChars);
    if (!articleExcerpt || articleExcerpt.length <= (observation.excerpt?.length ?? 0)) return observation;
    return {
      ...observation,
      excerpt: articleExcerpt,
      metadata: {
        ...observation.metadata,
        article_enrichment: "EXTRACTED",
        article_excerpt_chars: articleExcerpt.length,
      },
    };
  };
}
