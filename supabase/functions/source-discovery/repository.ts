import type { SourceDiscoveryRepository, SourceFeed, SourceObservationInput } from "./types.ts";

interface RepositoryOptions {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly request?: typeof fetch;
}

function roleReliability(role: SourceFeed["editorialRole"]): number {
  if (role === "FACT_PRIMARY") return 10;
  if (role === "FACT_INDEPENDENT") return 8;
  return 0;
}

export function createSourceDiscoveryRepository(options: RepositoryOptions): SourceDiscoveryRepository {
  if (!options.supabaseUrl.trim() || !options.serviceRoleKey.trim()) throw new Error("Database configuration is required");
  const baseUrl = options.supabaseUrl.replace(/\/$/u, "");
  const fetchImpl = options.request ?? fetch;

  async function request(path: string, init: RequestInit, profile?: string): Promise<Response> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        apikey: options.serviceRoleKey,
        ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("DATABASE_HTTP_ERROR");
    }
    return response;
  }

  return {
    async ensureSource(feed) {
      const query = new URLSearchParams({ select: "id", canonical_name: `eq.${feed.canonicalName}`, limit: "1" });
      const existing = await request(`/rest/v1/information_sources?${query}`, { method: "GET" });
      const rows = await existing.json() as unknown;
      if (Array.isArray(rows) && rows[0] && typeof rows[0] === "object" && typeof (rows[0] as Record<string, unknown>).id === "string") return (rows[0] as Record<string, string>).id;
      const inserted = await request("/rest/v1/information_sources?on_conflict=canonical_name", {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify({
          canonical_name: feed.canonicalName,
          entity_type: feed.entityType,
          aliases: [],
          website_url: feed.url,
          reliability_score: roleReliability(feed.editorialRole),
          reliability_rationale: `${feed.editorialRole} source registry entry`,
          editorial_role: feed.editorialRole,
          active: true,
        }),
      });
      const result = await inserted.json() as unknown;
      if (Array.isArray(result) && result[0] && typeof result[0] === "object" && typeof (result[0] as Record<string, unknown>).id === "string") return (result[0] as Record<string, string>).id;
      const retry = await request(`/rest/v1/information_sources?${query}`, { method: "GET" });
      const retryRows = await retry.json() as unknown;
      if (!Array.isArray(retryRows) || !retryRows[0] || typeof retryRows[0] !== "object" || typeof (retryRows[0] as Record<string, unknown>).id !== "string") throw new Error("SOURCE_REGISTRY_ERROR");
      return (retryRows[0] as Record<string, string>).id;
    },
    async saveObservation(observation: SourceObservationInput & { readonly informationSourceId: string }): Promise<boolean> {
      const response = await request("/rest/v1/source_observations?on_conflict=information_source_id%2Cexternal_id", {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation" },
        body: JSON.stringify({
          information_source_id: observation.informationSourceId,
          editorial_role: observation.editorialRole,
          external_id: observation.externalId,
          canonical_url: observation.canonicalUrl,
          title: observation.title,
          excerpt: observation.excerpt,
          published_at: observation.publishedAt,
          observed_at: observation.observedAt,
          discovery_signal: observation.discoverySignal,
          content_fingerprint: observation.contentFingerprint,
          metadata: observation.metadata,
        }),
      });
      const result = await response.json() as unknown;
      return Array.isArray(result) && result.length > 0;
    },
  };
}
