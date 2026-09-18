import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createOpenAIProvider } from "../creative-generation/provider.ts";
import { createRestGenerationRepository } from "../creative-generation/repository.ts";
import { createCreativeBatchHandler } from "../creative-generation/batch_handler.ts";
import { runCreativeGeneration } from "../creative-generation/orchestrator.ts";
import { pollSelectedDailyIntelligence } from "../creative-generation/selected_poll.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";

const readEnv = (name: string) => Deno.env.get(name);
const repository = createRestGenerationRepository({ supabaseUrl: requiredEnv(readEnv, "SUPABASE_URL"), serviceKey: resolveSupabaseSecretKey(readEnv) });
const provider = createOpenAIProvider({ apiKey: requiredEnv(readEnv, "OPENAI_API_KEY") });
const notion = createNotionClient({ token: requiredEnv(readEnv, "NOTION_TOKEN"), databaseId: requiredEnv(readEnv, "NOTION_DAILY_INTELLIGENCE_DATABASE_ID") });
const handler = createCreativeBatchHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: () => pollSelectedDailyIntelligence(notion, (trigger) => runCreativeGeneration(trigger, { repository, provider, workerId: crypto.randomUUID() })),
});

Deno.serve(handler);
