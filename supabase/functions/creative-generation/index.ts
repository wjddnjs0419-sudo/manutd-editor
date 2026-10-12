import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createOpenAIProvider } from "./provider.ts";
import { createRestGenerationRepository } from "./repository.ts";
import { createCreativeGenerationHandler } from "./handler.ts";
import { runCreativeGeneration } from "./orchestrator.ts";
import { readExplorationConfig } from "./exploration.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceKey = resolveSupabaseSecretKey(readEnv);
const openAiApiKey = requiredEnv(readEnv, "OPENAI_API_KEY");
const explorationConfig = readExplorationConfig(readEnv);
const repository = createRestGenerationRepository({ supabaseUrl, serviceKey });

const handler = createCreativeGenerationHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (trigger) => runCreativeGeneration(trigger, {
    repository,
    provider: createOpenAIProvider({ apiKey: openAiApiKey }),
    workerId: crypto.randomUUID(),
    explorationConfig,
  }),
});

Deno.serve(handler);
