import type { DiscoveryObservation, DiscoveryProvider, DiscoveryQuery, EngagementMetrics } from "./types.ts";

export interface DiscoveryNormalizationContext {
  readonly provider: Pick<DiscoveryProvider, "providerId" | "sourceRole" | "platform">;
  readonly query: DiscoveryQuery;
  readonly observedAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function engagement(value: unknown): EngagementMetrics {
  const input = record(value);
  return Object.fromEntries(Object.entries({
    likes: nonnegative(input.likes),
    comments: nonnegative(input.comments),
    views: nonnegative(input.views),
    upvotes: nonnegative(input.upvotes),
    replies: nonnegative(input.replies),
  }).filter(([, item]) => item !== undefined)) as EngagementMetrics;
}

function safeMetadata(value: unknown): Readonly<Record<string, unknown>> {
  const input = record(value);
  const blocked = /(key|token|secret|password|authorization|cookie|payload|body)/iu;
  return Object.fromEntries(Object.entries(input).filter(([key, item]) => !blocked.test(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean" || item === null)));
}

async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export async function normalizeDiscoveryObservation(value: unknown, context: DiscoveryNormalizationContext): Promise<DiscoveryObservation | null> {
  const input = record(value);
  const externalId = typeof input.externalId === "string" ? input.externalId.trim() : typeof input.external_id === "string" ? input.external_id.trim() : "";
  const canonicalUrlValue = typeof input.canonicalUrl === "string" ? input.canonicalUrl.trim() : typeof input.canonical_url === "string" ? input.canonical_url.trim() : "";
  const title = typeof input.title === "string" ? input.title.replace(/\s+/gu, " ").trim() : "";
  if (!externalId || !canonicalUrlValue || !title) return null;
  let url: URL;
  try {
    url = new URL(canonicalUrlValue);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const excerptValue = typeof input.excerpt === "string" ? input.excerpt.replace(/\s+/gu, " ").trim() : null;
  const metrics = engagement(input.engagement);
  const engagementAvailable = input.engagementAvailable === true || Object.keys(metrics).length > 0;
  const publishedAt = timestamp(input.publishedAt ?? input.published_at);
  const canonicalUrl = url.toString().slice(0, 2_000);
  return {
    providerId: context.provider.providerId,
    sourceCanonicalName: typeof input.sourceCanonicalName === "string" && input.sourceCanonicalName.trim() !== "" ? input.sourceCanonicalName.trim() : context.provider.providerId,
    sourceRole: context.provider.sourceRole,
    externalId: externalId.slice(0, 320),
    canonicalUrl,
    title: title.slice(0, 500),
    excerpt: excerptValue ? excerptValue.slice(0, 2_000) : null,
    publishedAt,
    observedAt: context.observedAt,
    platform: context.provider.platform,
    engagement: metrics,
    engagementAvailable,
    discoveryQueryId: context.query.queryId,
    contentFingerprint: typeof input.contentFingerprint === "string" && input.contentFingerprint.trim() !== ""
      ? input.contentFingerprint.trim()
      : await fingerprint(`${context.provider.providerId}\u0000${externalId}\u0000${title}\u0000${canonicalUrl}`),
    metadata: safeMetadata(input.metadata),
  };
}
