import { createEspnFixtureProvider } from "../_shared/m6/espn_fixture_provider.ts";
import { createM6Repository } from "../_shared/m6/repository.ts";
import { runFixtureSync } from "../_shared/m6/fixture_service.ts";
import { createFixtureSyncHandler } from "./handler.ts";

const secret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? Deno.env.get("COLLECTOR_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const repository = createM6Repository({ supabaseUrl, serviceRoleKey });
const provider = createEspnFixtureProvider();
const handler = createFixtureSyncHandler({
  invokeSecret: secret,
  run: ({ mode }) => runFixtureSync({ mode, now: new Date() }, {
    provider,
    repository,
    alertThreadId: Deno.env.get("TELEGRAM_OWNER_THREAD_ID") ?? "00000000-0000-0000-0000-000000000000",
  }),
});

Deno.serve(handler);
