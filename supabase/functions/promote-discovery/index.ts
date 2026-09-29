import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createPromoteDiscoveryHandler } from "./handler.ts";
import { promoteDiscovery } from "./orchestrator.ts";
import { createDiscoveryPromotionRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const invokeSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const repository = createDiscoveryPromotionRepository({ supabaseUrl, serviceRoleKey });

Deno.serve(createPromoteDiscoveryHandler({
  invokeSecret,
  run: (input) => promoteDiscovery({ ...input, repository }),
}));
