function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&#x27;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}

function plainText(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const boundary = value.slice(0, maxChars + 1).lastIndexOf(" ");
  return `${value.slice(0, boundary > 0 ? boundary : maxChars).trim()}…`;
}

/** Extracts a small, bounded evidence excerpt from an article HTML page. */
export function extractArticleExcerpt(html: string, maxChars: number): string | null {
  if (!Number.isFinite(maxChars) || maxChars < 1) return null;
  const withoutNoise = html.replace(/<(script|style|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/giu, " ");
  const paragraphs = [...withoutNoise.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/giu)]
    .map((match) => plainText(match[1] ?? ""))
    .filter((paragraph) => paragraph.length >= 40);
  const unique = [...new Set(paragraphs)];
  if (unique.length === 0) return null;
  return truncate(unique.join(" "), Math.floor(maxChars));
}
