import { createClient } from "npm:@supabase/supabase-js@2.116.0";

import { resolveContentUnderstandingConfig } from "./config.ts";
import { createAnalyzeContentHandler } from "./handler.ts";
import { createPrivateMediaReader, type PrivateStorage } from "./media.ts";
import { runContentAnalysis } from "./orchestrator.ts";
import { createContentUnderstandingProvider } from "./provider.ts";
import { createAnalysisRepository } from "./repository.ts";
import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const collectorSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const config = resolveContentUnderstandingConfig(readEnv);
const contract = {
  analysisVersion: config.analysisVersion,
  model: config.model,
  promptVersion: config.promptVersion,
};
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const repository = createAnalysisRepository({ supabaseUrl, serviceRoleKey });
const mediaReader = createPrivateMediaReader({
  bucket: "instagram-analysis",
  maxBytes: config.maxBytes,
  storageClient: supabase.storage as unknown as PrivateStorage,
});
const provider = createContentUnderstandingProvider({
  apiKey: requiredEnv(readEnv, "OPENAI_API_KEY"),
  config,
});
const handler = createAnalyzeContentHandler({
  collectorSecret,
  defaultLimit: config.batchSize,
  run: (asOf, limit) => runContentAnalysis({
    repository,
    contract,
    batchSize: config.batchSize,
    concurrency: config.concurrency,
    asOf,
    limit,
    readMedia: (asset) => {
      if (asset.storagePath === null) return Promise.reject(new Error("MEDIA_UNAVAILABLE"));
      return mediaReader.read({ ...asset, storagePath: asset.storagePath });
    },
    analyze: (input) => provider.analyze(input),
  }),
});

void handler;
Deno.serve(handler);
