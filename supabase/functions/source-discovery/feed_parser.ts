import type { ParsedFeedObservation, SourceFeed } from "./types.ts";

export interface FeedParserOptions {
  readonly maxItems: number;
  readonly maxExcerptChars: number;
}

function text(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&#x27;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function field(block: string, tag: string): string {
  const match = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "iu"));
  return match?.[1] ?? "";
}

function atomLink(block: string): string {
  return block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>(?:<\/link>)?/iu)?.[1] ?? "";
}

function link(block: string): string {
  const value = atomLink(block) || field(block, "link");
  return text(value);
}

function parseDate(value: string): string | null {
  const parsed = new Date(text(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function blocks(xml: string): string[] {
  return [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/giu)].map((match) => match[2]);
}

export async function parseFeedDocument(
  xml: string,
  feed: SourceFeed,
  options: FeedParserOptions,
): Promise<readonly ParsedFeedObservation[]> {
  const url = new URL(feed.url);
  if (url.protocol !== "https:") throw new Error("INVALID_FEED_URL");
  const result: ParsedFeedObservation[] = [];
  for (const block of blocks(xml).slice(0, options.maxItems)) {
    const externalId = text(field(block, "guid") || field(block, "id"));
    const title = text(field(block, "title"));
    const canonicalUrl = link(block);
    if (!externalId || !title || !canonicalUrl) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(canonicalUrl, feed.url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== "https:") continue;
    const excerptValue = text(field(block, "description") || field(block, "summary") || field(block, "content"));
    const excerpt = excerptValue ? excerptValue.slice(0, options.maxExcerptChars) : null;
    const publishedAt = parseDate(field(block, "pubDate") || field(block, "published") || field(block, "updated"));
    const normalizedUrl = parsedUrl.toString();
    result.push({
      sourceCanonicalName: feed.canonicalName,
      editorialRole: feed.editorialRole,
      externalId: externalId.slice(0, 320),
      canonicalUrl: normalizedUrl.slice(0, 2_000),
      title: title.slice(0, 500),
      excerpt,
      publishedAt,
      discoverySignal: feed.editorialRole.startsWith("DISCOVERY_") ? 0.7 : 0.5,
      contentFingerprint: await fingerprint(`${externalId}\u0000${title}\u0000${excerpt ?? ""}\u0000${normalizedUrl}`),
      metadata: { feed_url: feed.url, format: xml.includes("<entry") ? "ATOM" : "RSS" },
    });
  }
  return result;
}
