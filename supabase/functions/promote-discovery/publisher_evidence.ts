import { safePublisherUrl } from "../trend-discovery/google_news_resolution.ts";

export interface PublisherRegistryEntry {
  readonly id: string;
  readonly canonical_name: string;
  readonly website_url: string | null;
  readonly editorial_role: string;
  readonly reliability_score: number;
  readonly active: boolean;
}

export type ReviewedPublisherMatch = PublisherRegistryEntry & {
  readonly editorial_role: "FACT_PRIMARY" | "FACT_INDEPENDENT";
};

function normalizedHost(value: string | null): string | null {
  if (!value) return null;
  const safeUrl = safePublisherUrl(value);
  if (!safeUrl) return null;
  return new URL(safeUrl).hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
}

/** Match a publisher only to an explicitly reviewed, active fact-source host. */
export function matchReviewedPublisher(
  articleUrl: string,
  registry: readonly PublisherRegistryEntry[],
): ReviewedPublisherMatch | null {
  const articleHost = normalizedHost(articleUrl);
  if (!articleHost) return null;
  for (const entry of registry) {
    if (!entry.active || entry.reliability_score < 8 ||
      (entry.editorial_role !== "FACT_PRIMARY" && entry.editorial_role !== "FACT_INDEPENDENT")) continue;
    if (normalizedHost(entry.website_url) !== articleHost) continue;
    return {
      id: entry.id,
      canonical_name: entry.canonical_name,
      website_url: entry.website_url,
      editorial_role: entry.editorial_role,
      reliability_score: entry.reliability_score,
      active: entry.active,
    };
  }
  return null;
}
