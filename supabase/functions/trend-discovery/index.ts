import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { resolveSourceDiscoveryConfig } from "../source-discovery/config.ts";
import { createTrendDiscoveryHandler } from "./handler.ts";
import { runTrendDiscovery } from "./orchestrator.ts";
import { createArticleEnricher } from "./article_enrichment.ts";
import { createTrendDiscoveryRepository } from "./repository.ts";
import { createFeedDiscoveryProvider } from "./providers.ts";
import { createGoogleNewsDiscoveryProvider } from "./google_news_provider.ts";
import { createGdeltDiscoveryProvider } from "./gdelt_provider.ts";
import { createRoutedDiscoveryProviders } from "./provider_router.ts";
import { createSupabaseEntityContextDataSource, EntityContextResolver } from "./entity_context.ts";
import type { DiscoveryProvider } from "./types.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const collectorSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const sourceConfig = resolveSourceDiscoveryConfig(readEnv);
const repository = createTrendDiscoveryRepository({ supabaseUrl, serviceRoleKey });
const enrichObservation = createArticleEnricher();
const entityContextResolver = new EntityContextResolver(createSupabaseEntityContextDataSource({ supabaseUrl, serviceRoleKey }));
function isLiveRole(role: string): role is DiscoveryProvider["sourceRole"] {
  return ["FACT_PRIMARY", "FACT_INDEPENDENT", "DISCOVERY_COMPETITOR", "DISCOVERY_COMMUNITY", "DISCOVERY_VIDEO"].includes(role as DiscoveryProvider["sourceRole"]);
}
const trustedProviders = sourceConfig.feeds.flatMap((feed, index) => {
  if (!isLiveRole(feed.editorialRole)) return [];
  const platform = feed.editorialRole === "DISCOVERY_COMMUNITY" ? "REDDIT" : feed.editorialRole === "DISCOVERY_VIDEO" ? "YOUTUBE" : feed.format === "ATOM" ? "ATOM" : feed.format === "RSS" ? "RSS" : "WEB";
  return [createFeedDiscoveryProvider({ providerId: `feed-${index + 1}-${feed.canonicalName.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}`, sourceRole: feed.editorialRole, platform, feed })];
});

const handler = createTrendDiscoveryHandler({
  collectorSecret,
  defaultMaxQueries: 24,
  run: (input) => {
    const searchProfile = input.searchProfile ?? "MANUAL";
    const providers = createRoutedDiscoveryProviders({
      searchProfile,
      trustedProviders,
      googleNewsProvider: createGoogleNewsDiscoveryProvider(),
      gdeltProvider: createGdeltDiscoveryProvider(),
      readEnv,
    });
    return runTrendDiscovery({ ...input, searchProfile, providers, repository, enrichObservation, resolveEntityContext: (asOf) => entityContextResolver.resolve(asOf) });
  },
});

Deno.serve(handler);
