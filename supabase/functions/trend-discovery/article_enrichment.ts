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

function publisherHost(metadata: Readonly<Record<string, unknown>>): string | null {
  const value = metadata.publisher_url;
  if (typeof value !== "string") return null;
  const safe = safeHttpsUrl(value);
  return safe ? new URL(safe).hostname.toLowerCase() : null;
}

function allowedArticleHost(host: string, expectedPublisher: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === expectedPublisher || normalized.endsWith(`.${expectedPublisher}`) ||
    normalized === "google.com" || normalized.endsWith(".google.com");
}

async function resolvePublisherUrl(
  initialUrl: string,
  metadata: Readonly<Record<string, unknown>>,
  options: ArticleEnricherOptions,
): Promise<string | null> {
  const initial = safeHttpsUrl(initialUrl);
  if (!initial) return null;
  const publisher = publisherHost(metadata);
  const initialHost = new URL(initial).hostname.toLowerCase();
  if (!(initialHost === "news.google.com" || initialHost.endsWith(".news.google.com")) || !publisher) return initial;
  const fetchImpl = options.fetch ?? fetch;
  let current = initial;
  for (let hop = 0; hop < 5; hop += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: "GET",
        headers: { accept: "text/html,application/xhtml+xml" },
        signal: controller.signal,
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) {
      await response.body?.cancel();
      const finalHost = new URL(current).hostname.toLowerCase();
      const isPublisher = finalHost === publisher || finalHost.endsWith(`.${publisher}`);
      return current !== initial && isPublisher ? current : null;
    }
    await response.body?.cancel();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return null;
    }
    if (next.protocol !== "https:" || next.username || next.password || !allowedArticleHost(next.hostname, publisher)) return null;
    current = next.toString();
    if (new URL(current).hostname === publisher || new URL(current).hostname.endsWith(`.${publisher}`)) return current;
  }
  return null;
}

export function createArticleEnricher(options: ArticleEnricherOptions = {}): ArticleEnricher {
  const maxExcerptChars = options.maxExcerptChars ?? 2_400;
  return async (observation) => {
    const canonicalUrl = await resolvePublisherUrl(observation.canonicalUrl, observation.metadata, options);
    if (!canonicalUrl) return observation;
    const body = await fetchBoundedText(new URL(canonicalUrl), {
      fetch: options.fetch,
      timeoutMs: options.timeoutMs,
      maxBytes: options.maxBytes,
      accept: "text/html,application/xhtml+xml",
    });
    if (!body) return observation;
    const articleExcerpt = extractArticleExcerpt(body, maxExcerptChars);
    if (!articleExcerpt || articleExcerpt.length <= (observation.excerpt?.length ?? 0)) return observation.canonicalUrl === canonicalUrl ? observation : { ...observation, canonicalUrl };
    return {
      ...observation,
      canonicalUrl,
      excerpt: articleExcerpt,
      metadata: {
        ...observation.metadata,
        article_enrichment: "EXTRACTED",
        article_excerpt_chars: articleExcerpt.length,
      },
    };
  };
}
