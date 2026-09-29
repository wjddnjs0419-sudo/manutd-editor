import { requiredEnv, resolveSupabaseSecretKey } from "../collect-instagram/config.ts";
import { createGroundClaimsHandler } from "./handler.ts";
import { runClaimGrounding } from "./orchestrator.ts";
import { createGroundingRepository } from "./repository.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceRoleKey = resolveSupabaseSecretKey(readEnv);
const collectorSecret = requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET");
const repository = createGroundingRepository({ supabaseUrl, serviceRoleKey });
Deno.serve(createGroundClaimsHandler({ collectorSecret, run: (input, context) => runClaimGrounding({ repository, ...input, requestId: context?.requestId, log: context?.log }) }));
