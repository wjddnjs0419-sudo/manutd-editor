import { collectInstagram } from "./collector.ts";
import { createHandler } from "./handler.ts";
import { createMetaClient } from "./meta_client.ts";
import { createIngestRepository } from "./repository.ts";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

const username = "utdreport";
const metaClient = createMetaClient({
  accessToken: requiredEnv("META_ACCESS_TOKEN"),
  businessAccountId: requiredEnv("META_BUSINESS_ACCOUNT_ID"),
  apiVersion: requiredEnv("META_API_VERSION"),
  mediaLimit: 25,
});
const repository = createIngestRepository({
  supabaseUrl: requiredEnv("SUPABASE_URL"),
  serviceRoleKey: requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
});
const handler = createHandler({
  collectorSecret: requiredEnv("COLLECTOR_INVOKE_SECRET"),
  collect: (collectedAt) =>
    collectInstagram({
      username,
      collectedAt,
      metaClient,
      repository,
    }),
});

Deno.serve(handler);
