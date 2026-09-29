import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createRoutedDiscoveryProviders } from "../../trend-discovery/provider_router.ts";
import type {
  DiscoveryProvider,
  DiscoveryQuery,
} from "../../trend-discovery/types.ts";

const base: DiscoveryQuery = {
  queryId: "team",
  text: "Manchester United latest",
  family: "LATEST",
  mode: "GENERAL",
  window: "CURRENT",
  windowStart: "2026-09-29T00:00:00Z",
  windowEnd: "2026-09-29T12:00:00Z",
  priority: 100,
};
const fake = (label: string, calls: string[]): DiscoveryProvider => ({
  providerId: label === "google"
    ? "google-news"
    : label === "gdelt"
    ? "gdelt-doc"
    : label,
  sourceRole: "DISCOVERY_COMMUNITY",
  platform: "RSS",
  discover: async (query) => {
    calls.push(`${label}:${query.queryId}`);
    return [];
  },
});

Deno.test("FAST sends team and HOT entities to both search providers and preserves feeds", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    searchProfile: "FAST",
    trustedProviders: [fake("trusted", calls)],
    googleNewsProvider: fake("google", calls),
    gdeltProvider: fake("gdelt", calls),
    readEnv: () => "true",
  });
  for (
    const query of [base, {
      ...base,
      queryId: "hot",
      family: "ENTITY" as const,
      window: "HOT" as const,
    }, { ...base, queryId: "cold", family: "PLAYER" as const }]
  ) {
    for (const provider of providers) await provider.discover(query);
  }
  assertEquals(calls, [
    "trusted:team",
    "google:team",
    "gdelt:team",
    "trusted:hot",
    "google:hot",
    "gdelt:hot",
    "trusted:cold",
    "google:cold",
  ]);
});

Deno.test("PLAYER_SWEEP uses Google except HOT or BREAKING follow-up", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    searchProfile: "PLAYER_SWEEP",
    googleNewsProvider: fake("google", calls),
    gdeltProvider: fake("gdelt", calls),
    readEnv: () => "true",
  });
  for (
    const query of [{ ...base, family: "PLAYER" as const }, {
      ...base,
      queryId: "hot",
      family: "PLAYER" as const,
      window: "HOT" as const,
    }, {
      ...base,
      queryId: "breaking",
      family: "PLAYER" as const,
      window: "BREAKING" as const,
    }]
  ) {
    for (const provider of providers) await provider.discover(query);
  }
  assertEquals(calls, [
    "google:team",
    "google:hot",
    "gdelt:hot",
    "google:breaking",
    "gdelt:breaking",
  ]);
});

Deno.test("provider env switches disable search without disabling trusted feeds", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    searchProfile: "FAST",
    trustedProviders: [fake("trusted", calls)],
    googleNewsProvider: fake("google", calls),
    gdeltProvider: fake("gdelt", calls),
    readEnv: (name) => name === "DISCOVERY_GOOGLE_NEWS_ENABLED" ? "false" : "0",
  });
  for (const provider of providers) await provider.discover(base);
  assertEquals(calls, ["trusted:team"]);
});
