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
    const googleWrapper = isGoogleNewsArticleUrl(originalUrl);
    const publisherUrl = googleWrapper
      ? await resolveGoogleNewsArticleUrl(originalUrl, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      })
      : originalUrl;
    // A Google News HTML shell is not an article. Keep the RSS synopsis
    // rather than extracting arbitrary Google navigation paragraphs.
    if (!publisherUrl) return observation;
    const resolved = googleWrapper
      ? {
        ...observation,
        canonicalUrl: publisherUrl,
        metadata: {
          ...observation.metadata,
          google_news_url: originalUrl,
          publisher_url_resolved: true,
        },
      }
      : observation;
    const body = await fetchBoundedText(new URL(publisherUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      accept: "text/html,application/xhtml+xml",
    });
    // Publisher URL is useful even if the body is blocked by a paywall.
    if (!body) return resolved;
    const articleExcerpt = extractArticleExcerpt(body, maxExcerptChars);
    if (!articleExcerpt || (!googleWrapper && articleExcerpt.length <= (observation.excerpt?.length ?? 0))) return resolved;
    return {
      ...resolved,
      excerpt: articleExcerpt,
      metadata: {
        ...resolved.metadata,
        article_enrichment: "EXTRACTED",
        article_excerpt_chars: articleExcerpt.length,
      },
    };
  };
}
