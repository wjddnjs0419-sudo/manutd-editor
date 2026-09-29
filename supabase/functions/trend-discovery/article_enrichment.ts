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
  const maxExcerptChars = options.maxExcerptChars ?? 2_400;
  return async (observation) => {
    const canonicalUrl = safeHttpsUrl(observation.canonicalUrl);
    if (!canonicalUrl) return observation;
    const body = await fetchBoundedText(new URL(canonicalUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
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
