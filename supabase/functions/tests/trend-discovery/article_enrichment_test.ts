import { assertStringIncludes, assertEquals } from "jsr:@std/assert@1.0.8";
import { createArticleEnricher } from "../../trend-discovery/article_enrichment.ts";
import type { DiscoveryObservation } from "../../trend-discovery/types.ts";

function observation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    providerId: "provider",
    sourceCanonicalName: "BBC Sport",
    sourceRole: "FACT_INDEPENDENT",
    externalId: "item-1",
    canonicalUrl: "https://example.test/article-1",
    title: "Latest football update",
    excerpt: "A short feed summary.",
    publishedAt: "2026-09-27T11:00:00.000Z",
    observedAt: "2026-09-27T12:00:00.000Z",
    platform: "WEB",
    engagement: {},
    engagementAvailable: false,
    discoveryQueryId: "query-1",
    contentFingerprint: "fingerprint-1",
    metadata: {},
    ...overrides,
  };
}

Deno.test("extracts bounded article evidence and keeps enrichment metadata", async () => {
  let accept = "";
  const enrich = createArticleEnricher({
    fetch: (_input, init) => {
      accept = String(init?.headers && new Headers(init.headers).get("accept"));
      return Promise.resolve(new Response(`<html><body><p>Manchester United confirmed a first-team player returned to training ahead of the weekend match.</p><script>secret_token</script><p>More context from the article confirms the injury update is being monitored.</p></body></html>`, { headers: { "content-type": "text/html" } }));
    },
    maxExcerptChars: 300,
  });

  const result = await enrich(observation());

  assertEquals(accept, "text/html,application/xhtml+xml");
  assertStringIncludes(result.excerpt ?? "", "Manchester United confirmed");
  assertEquals(result.metadata.article_enrichment, "EXTRACTED");
  assertEquals(result.metadata.article_excerpt_chars, (result.excerpt ?? "").length);
  assertEquals((result.excerpt ?? "").includes("secret_token"), false);
});

Deno.test("keeps the original observation when article fetch fails", async () => {
  const original = observation();
  const enrich = createArticleEnricher({ fetch: () => Promise.resolve(new Response("unavailable", { status: 503 })) });

  assertEquals(await enrich(original), original);
});
