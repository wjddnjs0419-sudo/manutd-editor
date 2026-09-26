interface DeadAlertMaterializerOptions {
  readonly supabaseUrl: string;
  readonly serviceKey: string;
  readonly threadId: string;
  readonly request?: typeof fetch;
}

function responseCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  if (Array.isArray(value) && value.length > 0) return responseCount(value[0]);
  if (value && typeof value === "object" && "materialize_editorial_job_dead_alerts" in value) return responseCount((value as { materialize_editorial_job_dead_alerts?: unknown }).materialize_editorial_job_dead_alerts);
  return 0;
}

export async function materializeEditorialJobDeadAlerts(options: DeadAlertMaterializerOptions): Promise<number> {
  if (!options.threadId.trim()) return 0;
  const fetchImpl = options.request ?? fetch;
  const response = await fetchImpl(`${options.supabaseUrl.replace(/\/$/u, "")}/rest/v1/rpc/materialize_editorial_job_dead_alerts`, {
    method: "POST",
    headers: {
      apikey: options.serviceKey,
      authorization: `Bearer ${options.serviceKey}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ p_thread_id: options.threadId }),
  });
  if (!response.ok) throw new Error("DEAD_ALERT_MATERIALIZATION_FAILED");
  const text = await response.text();
  return responseCount(text.trim() ? JSON.parse(text) : 0);
}
