import { createClient } from "npm:@supabase/supabase-js@2.116.0";

import {
  requiredEnv,
  resolveSupabaseSecretKey,
} from "../collect-instagram/config.ts";
import { createStoryClassifier } from "./ai_classifier.ts";
import { resolveIntelligenceConfig } from "./config.ts";
import { createIntelligenceHandler } from "./handler.ts";
import { runIntelligence } from "./orchestrator.ts";
import { createIntelligenceRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const config = resolveIntelligenceConfig(readEnv);

// The repository uses the service-role REST boundary; create the client here so
// the function has the same Supabase initialization contract as the collector.
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
void supabase;

const repository = createIntelligenceRepository({
  supabaseUrl,
  serviceRoleKey,
});
const classifier = createStoryClassifier({
  config,
  apiKey: readEnv("OPENAI_API_KEY"),
  saveEvaluation: repository.saveEvaluation,
});
const handler = createIntelligenceHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (runAt) => runIntelligence({
    repository,
    classifier,
    config,
    runAt,
  }),
});

Deno.serve(handler);
