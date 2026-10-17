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
    : label,
  sourceRole: "DISCOVERY_COMMUNITY",
  platform: "RSS",
  discover: async (query) => {
    calls.push(`${label}:${query.queryId}`);
    return [];
  },
});

Deno.test("FAST sends team and HOT entities to Google News and preserves feeds", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    trustedProviders: [fake("trusted", calls)],
    googleNewsProvider: fake("google", calls),
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
    "trusted:hot",
    "google:hot",
    "trusted:cold",
    "google:cold",
  ]);
});

Deno.test("PLAYER_SWEEP uses Google News for each search query", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    googleNewsProvider: fake("google", calls),
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
    "google:breaking",
  ]);
});

Deno.test("provider env switches disable search without disabling trusted feeds", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    trustedProviders: [fake("trusted", calls)],
    googleNewsProvider: fake("google", calls),
    readEnv: (name) => name === "DISCOVERY_GOOGLE_NEWS_ENABLED" ? "false" : "0",
  });
  for (const provider of providers) await provider.discover(base);
  assertEquals(calls, ["trusted:team"]);
});

Deno.test("Google News search defaults off while trusted feeds remain enabled", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    trustedProviders: [fake("trusted", calls)],
    googleNewsProvider: fake("google", calls),
    readEnv: () => undefined,
  });

  for (const provider of providers) await provider.discover(base);

  assertEquals(calls, ["trusted:team"]);
});

Deno.test("Google News search only enables for an explicit true flag", async () => {
  const calls: string[] = [];
  const providers = createRoutedDiscoveryProviders({
    googleNewsProvider: fake("google", calls),
    readEnv: () => "enabled",
  });
  for (const provider of providers) await provider.discover(base);
  assertEquals(calls, []);
});
