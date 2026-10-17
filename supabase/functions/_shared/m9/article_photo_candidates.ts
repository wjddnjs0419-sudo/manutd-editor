
/**
 * M9.1: discover REAL photos from a publisher's original news article, plus
 * official club article URLs supplied by the caller. Never generates images.
 * Discovery is NOT a grant of permission to republish the discovered photos.
 */
import { fetchBoundedText } from "../../trend-discovery/search_provider_http.ts";
import { extractResponsivePublisherPhotos } from "./responsive_media.ts";
import { safePublisherUrl } from "../../trend-discovery/google_news_resolution.ts";

export type PhotoOrigin = "ARTICLE" | "OFFICIAL_CLUB";
export type PhotoMethod = "JSON_LD" | "OG_IMAGE" | "TWITTER_IMAGE" | "FIGURE" | "RESPONSIVE_SRCSET";
export interface PhotoCandidate {
  readonly image_url: string;
  readonly article_url: string;
  readonly origin: PhotoOrigin;
  readonly discovery_method: PhotoMethod;
  readonly width: number | null;
  readonly height: number | null;
  readonly caption: string | null;
  readonly credit: string | null;
  readonly article_published_at: string | null;
  readonly image_created_at: string | null;
  readonly rights_status: "UNVERIFIED";
  readonly score: number;
}
export interface PhotoSourcePage {
  readonly url: string;
  readonly origin: PhotoOrigin;
}
type RawPhoto = { url: string; method: PhotoMethod; width?: unknown; height?: unknown; caption?: unknown; credit?: unknown; created?: unknown };

function attr(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gu)) {
    out[(match[1] ?? "").toLowerCase()] = (match[2] ?? match[3] ?? match[4] ?? "").replace(/&amp;/giu, "&").replace(/&quot;/giu,'"');
  }
  return out;
}
function meta(html: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const tag of (html.match(/<meta\b[^>]*>/giu) ?? []).slice(0, 120)) {
    const a = attr(tag), key = (a.property ?? a.name ?? "").toLowerCase();
    if (key && a.content && !found.has(key)) found.set(key, a.content);
  }
  return found;
}
function dimension(x: unknown): number | null {
  const n = typeof x === "string" && /^\d{1,5}$/u.test(x) ? Number(x) : typeof x === "number" ? x : NaN;
  return Number.isInteger(n) && n > 0 && n < 20000 ? n : null;
}
function date(x: unknown): string | null {
  if (typeof x !== "string" || x.length > 100) return null;
  const n = Date.parse(x);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
function string(x: unknown): string | null {
  return typeof x === "string" && x.trim() ? x.trim().slice(0,240) : null;
}
function imageUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
      url.href.length > 2500 || !host.includes(".") || host.includes(":") ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(host) ||
      /(?:^|\.)(?:local|localhost|internal|invalid|test)$/u.test(host) ||
      /\.(?:svg|gif)(?:[?#]|$)/iu.test(url.href)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}
function jsonPhotos(image: unknown): RawPhoto[] {
  if (typeof image === "string") return [{ url:image, method:"JSON_LD" }];
  if (Array.isArray(image)) return image.slice(0,12).flatMap(jsonPhotos);
  if (!image || typeof image !== "object") return [];
  const v = image as Record<string,unknown>;
  const url = v.contentUrl ?? v.url;
  if (typeof url !== "string") return [];
  return [{ url, method:"JSON_LD", width:v.width, height:v.height, credit:v.creditText ?? v.copyrightHolder, caption:v.caption, created:v.dateCreated }];
}
function jsonLdPhotos(html: string): RawPhoto[] {
  const all: RawPhoto[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
    if (!m[1] || m[1].length > 100000) continue;
    let root: unknown;
    try { root = JSON.parse(m[1]); } catch { continue; }
    const stack: unknown[] = [root];
    let visited = 0;
    while (stack.length && ++visited < 45) {
      const node = stack.pop();
      if (Array.isArray(node)) { stack.push(...node.slice(0,12)); continue; }
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      const types = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      if (types.includes("NewsArticle") || types.includes("Article") || types.includes("BlogPosting")) all.push(...jsonPhotos(obj.image));
      if (Array.isArray(obj["@graph"])) stack.push(...obj["@graph"].slice(0,20));
    }
  }
  return all;
}
function figurePhotos(html: string): RawPhoto[] {
  const all: RawPhoto[] = [];
  for (const m of html.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/giu)) {
    if (all.length >= 5) break;
    const section = (m[1] ?? "").slice(0,6000);
    const tag = section.match(/<img\b[^>]*>/iu)?.[0];
    if (!tag) continue;
    const a = attr(tag), image = a["data-src"] ?? a.src ?? a["data-original"];
    if (!image) continue;
    const figcaption = section.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/iu)?.[1]?.replace(/<[^>]+>/gu," ").replace(/\s+/gu," ").trim();
    all.push({url:image,method:"FIGURE",width:a.width,height:a.height,caption:a.alt,credit:figcaption});
  }
  return all;
}
/** Pure, bounded candidate extractor. Image bytes are not downloaded here. */
export function extractPublisherImages(html: string, articleUrl: string, origin: PhotoOrigin = "ARTICLE"): PhotoCandidate[] {
  const article = safePublisherUrl(articleUrl);
  if (!article) return [];
  const tags = meta(html.slice(0,200000));
  const photos = jsonLdPhotos(html.slice(0,400000));
  for (const [key, method] of [
    ["og:image:secure_url","OG_IMAGE"],["og:image","OG_IMAGE"],
    ["twitter:image","TWITTER_IMAGE"],["twitter:image:src","TWITTER_IMAGE"],
  ] as const) {
    const url = tags.get(key);
    if (url) photos.push({ url, method, width:tags.get("og:image:width"), height:tags.get("og:image:height"),
      caption: tags.get("og:image:alt") ?? tags.get("twitter:image:alt"), credit:tags.get("image:credit") });
  }
  photos.push(...figurePhotos(html.slice(0,450000)));
  photos.push(...extractResponsivePublisherPhotos(html).map(p=>({
    url:p.url,method:"RESPONSIVE_SRCSET" as const,width:p.width,
    caption:p.caption,credit:p.credit,
  })));
  const unique = new Map<string, PhotoCandidate>();
  const publication = date(tags.get("article:published_time"));
  for (const photo of photos) {
    const url = imageUrl(photo.url,article);
    if (!url) continue;
    const width=dimension(photo.width), height=dimension(photo.height);
    const rank=photo.method==="RESPONSIVE_SRCSET"?100:photo.method==="JSON_LD"?90:photo.method==="OG_IMAGE"?80:photo.method==="TWITTER_IMAGE"?60:50;
    const score=rank+(width && height && width*height>=810000?10:0)+(string(photo.caption)?3:0);
    const item:PhotoCandidate = {
      image_url:url,article_url:article,origin,discovery_method:photo.method,
      width,height,caption:string(photo.caption),credit:string(photo.credit),
      article_published_at:publication,image_created_at:date(photo.created),
      rights_status:"UNVERIFIED",score,
    };
    const existing=unique.get(url);
    if (!existing || item.score>existing.score) unique.set(url,item);
  }
  return [...unique.values()].sort((a,b)=>b.score-a.score || a.image_url.localeCompare(b.image_url)).slice(0,8);
}
/** News sources first; supplemental official club article pages second. */
export async function collectPublisherImages(
  sources: readonly PhotoSourcePage[],
  options: {fetch?:typeof fetch;timeoutMs?:number;maxPages?:number} = {},
): Promise<PhotoCandidate[]> {
  const fetchImpl=options.fetch ?? fetch;
  const output: PhotoCandidate[]=[];
  const seen=new Set<string>();
  for (const source of sources.slice(0,Math.min(6,Math.max(1,options.maxPages??6)))) {
    const url=safePublisherUrl(source.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const html=await fetchBoundedText(new URL(url),{
      fetch:fetchImpl,timeoutMs:options.timeoutMs??5500,maxBytes:650000,
      accept:"text/html,application/xhtml+xml",
    });
    if (html) output.push(...extractPublisherImages(html,url,source.origin));
  }
  return output.sort((a,b)=>(a.origin===b.origin?0:a.origin==="ARTICLE"?-1:1)||b.score-a.score).slice(0,20);
}
