import type {
  DiscoveryObservation,
  DiscoveryProvider,
  DiscoveryQuery,
} from "./types.ts";

export interface RoutedDiscoveryProviderOptions {
  readonly searchProfile: "FAST" | "PLAYER_SWEEP" | "MANUAL";
  readonly trustedProviders?: readonly DiscoveryProvider[];
  readonly googleNewsProvider?: DiscoveryProvider;
  readonly gdeltProvider?: DiscoveryProvider;
  readonly readEnv?: (name: string) => string | undefined;
}

function enabled(
  readEnv: (name: string) => string | undefined,
  name: string,
): boolean {
  const value = readEnv(name);
  return value === undefined ||
    !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

function isEntityQuery(query: DiscoveryQuery): boolean {
  return query.family === "PLAYER" || query.family === "ENTITY";
}

function shouldRun(
  providerId: string,
  query: DiscoveryQuery,
  profile: RoutedDiscoveryProviderOptions["searchProfile"],
): boolean {
  if (profile === "PLAYER_SWEEP") {
    if (providerId === "google-news") return true;
    return providerId === "gdelt-doc" &&
      (query.window === "HOT" || query.window === "BREAKING");
  }
  if (profile === "FAST") {
    if (!isEntityQuery(query)) return true;
    return providerId === "google-news" || query.window === "HOT" ||
      query.window === "BREAKING";
  }
  return true;
}

function route(
  provider: DiscoveryProvider,
  profile: RoutedDiscoveryProviderOptions["searchProfile"],
): DiscoveryProvider {
  return {
    providerId: provider.providerId,
    sourceRole: provider.sourceRole,
    platform: provider.platform,
    async discover(
      query: DiscoveryQuery,
    ): Promise<readonly DiscoveryObservation[]> {
      if (!shouldRun(provider.providerId, query, profile)) return [];
      return await provider.discover(query);
    },
  };
}

export function createRoutedDiscoveryProviders(
  options: RoutedDiscoveryProviderOptions,
): readonly DiscoveryProvider[] {
  const readEnv = options.readEnv ?? ((name: string) => Deno.env.get(name));
  const providers: DiscoveryProvider[] = [...(options.trustedProviders ?? [])];
  if (
    options.googleNewsProvider &&
    enabled(readEnv, "DISCOVERY_GOOGLE_NEWS_ENABLED")
  ) providers.push(options.googleNewsProvider);
  if (options.gdeltProvider && enabled(readEnv, "DISCOVERY_GDELT_ENABLED")) {
    providers.push(options.gdeltProvider);
  }
  return providers.map((provider) =>
    provider.providerId === "google-news" || provider.providerId === "gdelt-doc"
      ? route(provider, options.searchProfile)
      : provider
  );
}
