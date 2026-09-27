import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { resolveSourceDiscoveryConfig } from "./config.ts";
import { createSourceDiscoveryHandler } from "./handler.ts";
import { runSourceDiscovery } from "./orchestrator.ts";
import { createSourceDiscoveryRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const collectorSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const config = resolveSourceDiscoveryConfig(readEnv);
const repository = createSourceDiscoveryRepository({ supabaseUrl, serviceRoleKey });

const handler = createSourceDiscoveryHandler({
  collectorSecret,
  defaultLimit: config.maxItems,
  run: (input) => runSourceDiscovery({
    ...input,
    repository,
    feeds: config.feeds,
    fetch,
    now: () => new Date(),
    maxItems: config.maxItems,
    maxBytes: config.maxBytes,
    maxExcerptChars: config.maxExcerptChars,
    timeoutMs: config.timeoutMs,
  }),
});

Deno.serve(handler);
