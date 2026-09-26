import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";
import { createRestGenerationRepository } from "../creative-generation/repository.ts";
import { createProjectNotionHandler } from "./handler.ts";
import { runProjectNotion } from "./orchestrator.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const repository = createRestGenerationRepository({ supabaseUrl, serviceKey: resolveSupabaseSecretKey(readEnv) });
const notion = createNotionClient({
  token: requiredEnv(readEnv, "NOTION_TOKEN"),
  databaseId: requiredEnv(readEnv, "NOTION_CONTENT_PIPELINE_DATABASE_ID"),
});

Deno.serve(createProjectNotionHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (creativeBriefId) => runProjectNotion(creativeBriefId, { repository, notion }),
}));
