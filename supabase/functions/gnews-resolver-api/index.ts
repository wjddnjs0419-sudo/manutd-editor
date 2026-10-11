import { resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createGnewsResolverApiHandler } from "./handler.ts";

const readEnv = (name: string) => Deno.env.get(name);
const handler = createGnewsResolverApiHandler({
  supabaseUrl: readEnv("SUPABASE_URL") ?? "",
  serviceRoleKey: resolveSupabaseSecretKey(readEnv),
  workerToken: readEnv("GNEWS_RESOLVER_WORKER_TOKEN") ?? "",
  enabled: readEnv("GNEWS_RESOLVER_ENABLED")?.trim().toLowerCase() === "true",
});

Deno.serve(handler);
