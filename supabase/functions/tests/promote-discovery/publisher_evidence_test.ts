import { assertEquals } from "jsr:@std/assert@1.0.8";
import { matchReviewedPublisher, type PublisherRegistryEntry } from "../../promote-discovery/publisher_evidence.ts";

const reviewed: PublisherRegistryEntry = {
  id: "bbc-source",
  canonical_name: "BBC Sport",
  website_url: "https://www.bbc.com/sport",
  editorial_role: "FACT_INDEPENDENT",
  reliability_score: 8,
  active: true,
};

Deno.test("reviewed publisher exact host is eligible", () => {
  assertEquals(matchReviewedPublisher("https://www.bbc.com/sport/football/story?utm_source=rss#top", [reviewed]), {
    id: "bbc-source",
    canonical_name: "BBC Sport",
    website_url: "https://www.bbc.com/sport",
    editorial_role: "FACT_INDEPENDENT",
    reliability_score: 8,
    active: true,
  });
});

Deno.test("publisher trust rejects unknown inactive weak role and sibling hosts", () => {
  const cases: Array<[string, readonly PublisherRegistryEntry[]]> = [
    ["https://www.unknown.example/story", [reviewed]],
    ["https://www.bbc.com/story", [{ ...reviewed, active: false }]],
    ["https://www.bbc.com/story", [{ ...reviewed, reliability_score: 7 }]],
    ["https://www.bbc.com/story", [{ ...reviewed, editorial_role: "DISCOVERY_COMMUNITY" }]],
    ["https://sport.bbc.com/story", [reviewed]],
    ["http://www.bbc.com/story", [reviewed]],
    ["https://www.bbc.com.evil.example/story", [reviewed]],
  ];
  for (const [url, registry] of cases) assertEquals(matchReviewedPublisher(url, registry), null, url);
});
