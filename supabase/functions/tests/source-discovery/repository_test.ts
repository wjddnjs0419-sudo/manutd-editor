import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createSourceDiscoveryRepository } from "../../source-discovery/repository.ts";

Deno.test("source discovery writes observations through the app_private profile", async () => {
  const requests: Array<{ url: string; profile: string | null }> = [];
  const repository = createSourceDiscoveryRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    request: async (input, init) => {
      const headers = new Headers((init as globalThis.RequestInit | undefined)?.headers);
      requests.push({ url: String(input), profile: headers.get("content-profile") });
      if (String(input).includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1" }]), { status: 200 });
      return new Response(JSON.stringify([{ id: "observation-1" }]), { status: 200 });
    },
  });

  const sourceId = await repository.ensureSource({ canonicalName: "Manchester United", editorialRole: "FACT_PRIMARY", entityType: "CLUB", url: "https://www.manutd.com/en/news/category/news", format: "HTML" });
  const inserted = await repository.saveObservation({
    informationSourceId: sourceId,
    sourceCanonicalName: "Manchester United",
    editorialRole: "FACT_PRIMARY",
    externalId: "https://www.manutd.com/en/news/team-news",
    canonicalUrl: "https://www.manutd.com/en/news/team-news",
    title: "Team news",
    excerpt: null,
    publishedAt: null,
    observedAt: "2026-09-27T02:00:00.000Z",
    discoverySignal: 0.5,
    contentFingerprint: "fingerprint",
    metadata: { format: "HTML" },
  });

  assertEquals(sourceId, "source-1");
  assertEquals(inserted, true);
  assertEquals(requests.at(-1)?.profile, "app_private");
});

Deno.test("source discovery refreshes an existing observation after a duplicate", async () => {
  const requests: Array<{ url: string; method: string; body: string | null }> = [];
  const repository = createSourceDiscoveryRepository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    request: async (input, init) => {
      const requestInit = init as globalThis.RequestInit | undefined;
      const method = requestInit?.method ?? "GET";
      requests.push({ url: String(input), method, body: typeof requestInit?.body === "string" ? requestInit.body : null });
      if (String(input).includes("information_sources")) return new Response(JSON.stringify([{ id: "source-1" }]), { status: 200 });
      if (method === "POST") return new Response(JSON.stringify([]), { status: 200 });
      return new Response(null, { status: 204 });
    },
  });

  const inserted = await repository.saveObservation({
    informationSourceId: "source-1",
    sourceCanonicalName: "BBC Sport",
    editorialRole: "FACT_INDEPENDENT",
    externalId: "article-1",
    canonicalUrl: "https://bbc.test/article/1",
    title: "Tactical report",
    excerpt: "The article body excerpt.",
    publishedAt: "2026-09-27T00:00:00.000Z",
    observedAt: "2026-09-27T02:00:00.000Z",
    discoverySignal: 0.5,
    contentFingerprint: "fingerprint",
    metadata: { format: "RSS" },
  });

  assertEquals(inserted, false);
  assertEquals(requests.at(-1)?.method, "PATCH");
  assertEquals(JSON.parse(requests.at(-1)?.body ?? "{}").excerpt, "The article body excerpt.");
});
