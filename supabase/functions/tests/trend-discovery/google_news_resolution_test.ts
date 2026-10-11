import assert from "node:assert/strict";
import { isGoogleNewsArticleUrl, resolveGoogleNewsArticleUrl, safePublisherUrl } from "../../trend-discovery/google_news_resolution.ts";
import { createArticleEnricher } from "../../trend-discovery/article_enrichment.ts";
import type { DiscoveryObservation } from "../../trend-discovery/types.ts";

const googleUrl = "https://news.google.com/rss/articles/CBMiOpaqueNewsToken2026?oc=5";
const publisher = "https://www.bbc.com/sport/football/articles/example-2026";

function successRpc(): string {
  const nested = JSON.stringify(["garturlres", publisher]);
  return `)]}'\n\n129\n${JSON.stringify([["wrb.fr", "Fbv4je", nested, null, null, null, "generic"]])}\n`;
}

function example(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    providerId: "google-news",
    sourceCanonicalName: "BBC Sport",
    sourceRole: "DISCOVERY_COMMUNITY",
    externalId: googleUrl,
    canonicalUrl: googleUrl,
    title: "Bruno Fernandes Manchester United training update",
    excerpt: "Bruno Fernandes is back in training.",
    publishedAt: "2026-10-11T00:00:00Z",
    observedAt: "2026-10-11T01:00:00Z",
    platform: "RSS",
    engagement: {},
    engagementAvailable: false,
    discoveryQueryId: "query-1",
    contentFingerprint: "fingerprint",
    metadata: { publisher_name: "BBC Sport" },
    ...overrides,
  };
}

Deno.test("accepts only the Google News article wrapper and safe external publisher URLs", () => {
  assert.equal(isGoogleNewsArticleUrl(googleUrl), true);
  assert.equal(isGoogleNewsArticleUrl("https://news.google.com.evil.com/rss/articles/CBMiOpaqueNewsToken2026"), false);
  assert.equal(isGoogleNewsArticleUrl("https://news.google.com/search?q=football"), false);
  assert.equal(safePublisherUrl("https://127.0.0.1/private"), null);
  assert.equal(safePublisherUrl("https://localhost/secret"), null);
  assert.equal(safePublisherUrl("https://internal.local/page"), null);
  assert.equal(safePublisherUrl("http://www.bbc.com/sport"), null);
  assert.equal(safePublisherUrl(publisher), publisher);
});

Deno.test("resolves an opaque Google News RSS link through the signed endpoint", async () => {
  const calls: Array<{ url: string; method: string; redirect: RequestRedirect }> = [];
  const url = await resolveGoogleNewsArticleUrl(googleUrl, {
    fetch: async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", redirect: init?.redirect ?? "follow" });
      if (calls.length === 1) return new Response('<html><div data-n-a-sg="signature-123" data-n-a-ts="1791700000"></div></html>');
      if (calls.length === 2) {
        const body = new URLSearchParams(String(init?.body));
        const envelope = JSON.parse(body.get("f.req") ?? "null");
        assert.equal(envelope[0][0][0], "Fbv4je");
        assert.equal(JSON.parse(envelope[0][0][1])[2], "CBMiOpaqueNewsToken2026");
        return new Response(successRpc());
      }
      throw new Error("Unexpected HTTP request");
    },
  });
  assert.equal(url, publisher);
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST"]);
  assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
  assert.equal(calls[1]?.url, "https://news.google.com/_/DotsSplashUi/data/batchexecute");
});

Deno.test("follows one same-host Google locale redirect and accepts a bounded large signature page", async () => {
  const calls: string[] = [];
  const largeGooglePage = `<html><div data-n-a-sg="signature-123" data-n-a-ts="1791700000"></div>${"x".repeat(900_000)}</html>`;
  const url = await resolveGoogleNewsArticleUrl(googleUrl, {
    fetch: async (input) => {
      const requestUrl = String(input);
      calls.push(requestUrl);
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://news.google.com/articles/CBMiOpaqueNewsToken2026?hl=en-US&gl=US&ceid=US:en" },
        });
      }
      if (calls.length === 2) return new Response(largeGooglePage);
      if (calls.length === 3) return new Response(successRpc());
      throw new Error("Unexpected HTTP request");
    },
  });
  assert.equal(url, publisher);
  assert.equal(calls.length, 3);
  assert.match(calls[1] ?? "", /^https:\/\/news\.google\.com\/articles\//u);
});

Deno.test("does not follow a Google signature redirect to another host", async () => {
  let calls = 0;
  const url = await resolveGoogleNewsArticleUrl(googleUrl, {
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/collect" } });
    },
  });
  assert.equal(url, null);
  assert.equal(calls, 1);
});

Deno.test("rejects invalid signatures, unsafe returned URLs and unavailable Google endpoints", async () => {
  const unreadable = await resolveGoogleNewsArticleUrl(googleUrl, { fetch: async () => new Response("consent", { status: 429 }) });
  assert.equal(unreadable, null);
  const missingSignature = await resolveGoogleNewsArticleUrl(googleUrl, { fetch: async () => new Response("<html>No signature</html>") });
  assert.equal(missingSignature, null);
  const unsafe = await resolveGoogleNewsArticleUrl(googleUrl, {
    fetch: async (input) => String(input).includes("batchexecute")
      ? new Response(JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", "https://127.0.0.1/private"])]]))
      : new Response('<div data-n-a-sg="sig" data-n-a-ts="1791700000"></div>'),
  });
  assert.equal(unsafe, null);
});

Deno.test("Google News observations are left for the external resolver worker", async () => {
  const urls: string[] = [];
  const enrich = createArticleEnricher({
    fetch: async (input) => { urls.push(String(input)); return new Response("unexpected"); },
  });
  const source = example();
  const result = await enrich(source);
  assert.deepEqual(result, source);
  assert.equal(urls.length, 0);
});

Deno.test("failed Google resolution retains the original headline and RSS link", async () => {
  const source = example();
  const enrich = createArticleEnricher({ fetch: async () => new Response("unavailable", { status: 503 }) });
  assert.deepEqual(await enrich(source), source);
});

Deno.test("Google News resolution failures never trigger a publisher fetch in the Edge runtime", async () => {
  const urls: string[] = [];
  const enrich = createArticleEnricher({
    fetch: async (input) => { urls.push(String(input)); return new Response("paywalled", { status: 403 }); },
  });
  const result = await enrich(example());
  assert.equal(result.canonicalUrl, googleUrl);
  assert.equal(result.excerpt, "Bruno Fernandes is back in training.");
  assert.equal(urls.length, 0);
});
