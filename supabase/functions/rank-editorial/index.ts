import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createRankEditorialHandler } from "./handler.ts";
import { runEditorialRanking } from "./orchestrator.ts";
import { createEditorialRankingRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const collectorSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const repository = createEditorialRankingRepository({ supabaseUrl, serviceRoleKey, log: (entry) => console.log(JSON.stringify(entry)) });
console.log(JSON.stringify({ event: "rank_editorial_startup_ready", stage: "startup" }));
Deno.serve(createRankEditorialHandler({ collectorSecret, run: (input, requestId) => runEditorialRanking({ repository, ...input, requestId }) }));
