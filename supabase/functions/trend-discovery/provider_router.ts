import type { DiscoveryProvider } from "./types.ts";

export interface RoutedDiscoveryProviderOptions {
  readonly trustedProviders?: readonly DiscoveryProvider[];
  readonly googleNewsProvider?: DiscoveryProvider;
  readonly readEnv?: (name: string) => string | undefined;
}

export function createRoutedDiscoveryProviders(
  options: RoutedDiscoveryProviderOptions,
): readonly DiscoveryProvider[] {
  const readEnv = options.readEnv ?? ((name: string) => Deno.env.get(name));
  const providers: DiscoveryProvider[] = [...(options.trustedProviders ?? [])];
  const googleNewsEnabled = readEnv("DISCOVERY_GOOGLE_NEWS_ENABLED")?.trim().toLowerCase() === "true";
  if (options.googleNewsProvider && googleNewsEnabled) providers.push(options.googleNewsProvider);
  return providers;
}
