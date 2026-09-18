import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createOpenAIProvider } from "../creative-generation/provider.ts";
import { createRestGenerationRepository } from "../creative-generation/repository.ts";
import { createCreativeBatchHandler } from "../creative-generation/batch_handler.ts";
import { runPriorityCreativeGeneration } from "../creative-generation/orchestrator.ts";

const readEnv = (name: string) => Deno.env.get(name);
const repository = createRestGenerationRepository({ supabaseUrl: requiredEnv(readEnv, "SUPABASE_URL"), serviceKey: resolveSupabaseSecretKey(readEnv) });
const provider = createOpenAIProvider({ apiKey: requiredEnv(readEnv, "OPENAI_API_KEY") });
const handler = createCreativeBatchHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: async () => runPriorityCreativeGeneration({ repository, provider, workerId: crypto.randomUUID() }),
});

Deno.serve(handler);
