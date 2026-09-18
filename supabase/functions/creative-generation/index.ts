import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createOpenAIProvider } from "./provider.ts";
import { createRestGenerationRepository } from "./repository.ts";
import { createCreativeGenerationHandler } from "./handler.ts";
import { projectCreativeBriefToContentPipeline, dailyIntelligenceCreativeProperties } from "./notion_projection.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";
import { runCreativeGeneration } from "./orchestrator.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceKey = resolveSupabaseSecretKey(readEnv);
const provider = createOpenAIProvider({ apiKey: requiredEnv(readEnv, "OPENAI_API_KEY") });
const repository = createRestGenerationRepository({ supabaseUrl, serviceKey });
const contentPipelineNotion = createNotionClient({
  token: requiredEnv(readEnv, "NOTION_TOKEN"),
  databaseId: requiredEnv(readEnv, "NOTION_CONTENT_PIPELINE_DATABASE_ID"),
});
const workerId = crypto.randomUUID();

const handler = createCreativeGenerationHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (trigger) => runCreativeGeneration(trigger, {
    repository,
    provider,
    workerId,
    projectReady: async (brief) => {
      const existing = await repository.getPipelineState?.(brief.candidate_id) ?? null;
      const projection = await projectCreativeBriefToContentPipeline(brief, existing, contentPipelineNotion);
      await repository.savePipelineState?.({
        candidate_id: brief.candidate_id,
        creative_brief_id: brief.id,
        revision: projection.revision,
        notion_page_id: projection.notion_page_id,
        sync_hash: brief.input_fingerprint,
        production_status: "EDITABLE",
      });
      const dailyPageId = await repository.getDailyIntelligencePageId?.(brief.candidate_id);
      if (dailyPageId) await contentPipelineNotion.updatePage(dailyPageId, { properties: dailyIntelligenceCreativeProperties({ status: brief.status, revision: brief.version, contentPipelineUrl: projection.url }) });
    },
  }),
});

Deno.serve(handler);
