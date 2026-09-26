import {
  integerEnv,
  requiredEnv,
  resolveSupabaseSecretKey,
} from "../collect-instagram/config.ts";
import { createBoundaryInvoker } from "./boundary_client.ts";
import { createOrchestrationHandler } from "./handler.ts";
import { createEditorialJobQueue } from "./queue_client.ts";
import { createOrchestrationWorker } from "./worker.ts";

const readEnv = (name: string) => Deno.env.get(name);
const supabaseUrl = requiredEnv(readEnv, "SUPABASE_URL");
const serviceKey = resolveSupabaseSecretKey(readEnv);
const functionsUrl = `${supabaseUrl.replace(/\/$/u, "")}/functions/v1`;
const batchSize = integerEnv(readEnv, "ORCHESTRATION_BATCH_SIZE", 1, 20, 5);
const leaseSeconds = integerEnv(readEnv, "ORCHESTRATION_LEASE_SECONDS", 30, 1800, 300);
const queue = createEditorialJobQueue({ supabaseUrl, serviceKey });
const invoker = createBoundaryInvoker({
  functionsUrl,
  collectorSecret: requiredEnv(readEnv, "COLLECTOR_INVOKE_SECRET"),
  telegramSecret: requiredEnv(readEnv, "TELEGRAM_AGENT_INVOKE_SECRET"),
});
const workerSecret = requiredEnv(readEnv, "ORCHESTRATION_WORKER_INVOKE_SECRET");
const workerInstance = Deno.env.get("ORCHESTRATION_WORKER_ID") ?? crypto.randomUUID();

Deno.serve(createOrchestrationHandler({
  workerSecret,
  defaultLimit: batchSize,
  run: (limit) => createOrchestrationWorker({
    queue,
    invoker,
    workerId: `${workerInstance}:${crypto.randomUUID()}`,
    batchSize: limit,
    leaseSeconds,
  }).processBatch(),
}));

