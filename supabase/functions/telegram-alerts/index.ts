import { dispatchPendingAlerts, type PendingAlert } from "../_shared/m6/alerts.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createTelegramAlertsHandler } from "./handler.ts";
import { materializeEditorialJobDeadAlerts } from "./dead_alerts.ts";

const secret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ownerThreadId = Deno.env.get("TELEGRAM_OWNER_THREAD_ID") ?? "";
const baseUrl = supabaseUrl.replace(/\/$/u, "");
const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, accept: "application/json" };

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error("ALERT_REPOSITORY_FAILED");
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function runAlerts() {
  await materializeEditorialJobDeadAlerts({ supabaseUrl, serviceKey: serviceRoleKey, threadId: ownerThreadId });
  const rows = await rest("/rest/v1/telegram_alert_events?select=id,event_type,payload&status=eq.PENDING&order=created_at.asc&limit=50", { headers: { "accept-profile": "app_private" } });
  const pending = Array.isArray(rows) ? rows as PendingAlert[] : [];
  const client = createTelegramClient({ token: botToken });
  return dispatchPendingAlerts({
    listPending: async () => pending,
    resolveChatId: async () => Deno.env.get("TELEGRAM_CHAT_ID") ?? "",
    client,
    markSent: async (id, sentAt) => { await rest(`/rest/v1/telegram_alert_events?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal", "content-profile": "app_private" }, body: JSON.stringify({ status: "SENT", sent_at: sentAt }) }); },
    markFailed: async (id, message) => { await rest(`/rest/v1/telegram_alert_events?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal", "content-profile": "app_private" }, body: JSON.stringify({ status: "FAILED", last_error: message.slice(0, 120) }) }); },
  });
}

Deno.serve(createTelegramAlertsHandler({ invokeSecret: secret, run: runAlerts }));
