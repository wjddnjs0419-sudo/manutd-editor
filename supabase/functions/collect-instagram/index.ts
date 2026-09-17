import { collectInstagram } from "./collector.ts";
import { requiredEnv, resolveSupabaseSecretKey } from "./config.ts";
import { createHandler } from "./handler.ts";
import { createMetaClient } from "./meta_client.ts";
import { createIngestRepository } from "./repository.ts";

const username = "utdreport";
const readEnv = (name: string) => Deno.env.get(name);
const metaClient = createMetaClient({
  accessToken: requiredEnv(readEnv, "META_ACCESS_TOKEN"),
  businessAccountId: requiredEnv(readEnv, "META_BUSINESS_ACCOUNT_ID"),
  apiVersion: requiredEnv(readEnv, "META_API_VERSION"),
  mediaLimit: 25,
});
const repository = createIngestRepository({
  supabaseUrl: requiredEnv(readEnv, "SUPABASE_URL"),
  secretKey: resolveSupabaseSecretKey(readEnv),
});
const handler = createHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  collect: (collectedAt) =>
    collectInstagram({
      username,
      collectedAt,
      metaClient,
      repository,
    }),
});

Deno.serve(handler);
