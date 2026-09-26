import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createOpenAIProvider } from "./provider.ts";
import { createRestGenerationRepository } from "./repository.ts";
import { createCreativeGenerationHandler } from "./handler.ts";
import { runCreativeGeneration } from "./orchestrator.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceKey = resolveSupabaseSecretKey(readEnv);
const provider = createOpenAIProvider({ apiKey: requiredEnv(readEnv, "OPENAI_API_KEY") });
const repository = createRestGenerationRepository({ supabaseUrl, serviceKey });

const handler = createCreativeGenerationHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (trigger) => runCreativeGeneration(trigger, {
    repository,
    provider,
    workerId: crypto.randomUUID(),
  }),
});

Deno.serve(handler);
