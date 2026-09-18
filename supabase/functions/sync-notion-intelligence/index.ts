import {
  requiredEnv,
  resolveSupabaseSecretKey,
} from "../collect-instagram/config.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";
import { createNotionSyncHandler } from "../notion-sync/handler.ts";
import { runNotionSync } from "../notion-sync/orchestrator.ts";
import { createNotionSyncRepository } from "../notion-sync/repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const notionToken = requiredEnv(readEnv, "NOTION_TOKEN");
const notionDatabaseId = requiredEnv(readEnv, "NOTION_DAILY_INTELLIGENCE_DATABASE_ID");

const repository = createNotionSyncRepository({
  supabaseUrl,
  serviceRoleKey,
});
const notion = createNotionClient({
  token: notionToken,
  databaseId: notionDatabaseId,
});
const handler = createNotionSyncHandler({
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  run: (runAt) => runNotionSync({
    repository,
    notion,
    now: () => runAt,
    log: (entry) => console.log(JSON.stringify(entry)),
  }),
});

Deno.serve(handler);
