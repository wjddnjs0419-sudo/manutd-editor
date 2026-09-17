import { createClient } from "@supabase/supabase-js";
import { collectInstagram } from "./collector.ts";
import {
  integerEnv,
  requiredEnv,
  resolveMediaConfig,
  resolveSupabaseSecretKey,
} from "./config.ts";
import { createHandler } from "./handler.ts";
import {
  createMediaStorage,
  storageClientFromSupabase,
} from "./media_storage.ts";
import { createMetaClient } from "./meta_client.ts";
import { runInstagramCollection } from "./orchestrator.ts";
import { createIngestRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const secretKey = resolveSupabaseSecretKey(readEnv);
const mediaConfig = resolveMediaConfig(readEnv);
const concurrency = integerEnv(
  readEnv,
  "COLLECTOR_CONCURRENCY",
  1,
  3,
  2,
);
const accountBudgetMs = integerEnv(
  readEnv,
  "COLLECTOR_ACCOUNT_BUDGET_MS",
  1,
  120_000,
  20_000,
);
const runBudgetMs = integerEnv(
  readEnv,
  "COLLECTOR_RUN_BUDGET_MS",
  1,
  120_000,
  100_000,
);
const metaClient = createMetaClient({
  accessToken: requiredEnv(readEnv, "META_ACCESS_TOKEN"),
  businessAccountId: requiredEnv(readEnv, "META_BUSINESS_ACCOUNT_ID"),
  apiVersion: requiredEnv(readEnv, "META_API_VERSION"),
  mediaLimit: 25,
});
const repository = createIngestRepository({
  supabaseUrl,
  secretKey,
});
const supabase = createClient(supabaseUrl, secretKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
const mediaStorage = createMediaStorage({
  bucket: mediaConfig.bucket,
  maxBytes: mediaConfig.maxBytes,
  storageClient: storageClientFromSupabase(supabase),
});
const handler = createHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  collect: (collectedAt, requestedSourceAccountIds) =>
    runInstagramCollection({
      requestedSourceAccountIds,
      collectedAt,
      concurrency,
      runBudgetMs,
      accountBudgetMs,
      accountRepository: repository,
      mediaRepository: repository,
      mediaStorage,
      mediaConcurrency: mediaConfig.concurrency,
      mediaLimitPerRun: mediaConfig.assetsPerRun,
      collectAccount: (sourceAccount, accountCollectedAt, signal) =>
        collectInstagram({
          sourceAccount,
          collectedAt: accountCollectedAt,
          signal,
          metaClient,
          repository,
        }),
    }),
});

Deno.serve(handler);
