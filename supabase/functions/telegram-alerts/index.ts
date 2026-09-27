import { dispatchPendingAlerts, type PendingAlert } from "../_shared/m6/alerts.ts";
import { businessDate } from "../_shared/m6/business_date.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createTelegramAlertsHandler } from "./handler.ts";
import { materializeEditorialJobDeadAlerts } from "./dead_alerts.ts";
import { materializeIntelligenceCompleteAlert } from "./intelligence_summary.ts";

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
  const rankingDate = businessDate(new Date(), "Asia/Seoul");
  await materializeIntelligenceCompleteAlert({ businessDate: rankingDate, threadId: ownerThreadId, repository: {
    intelligenceSucceeded: async (date) => {
      const readiness = await rest(`/rest/v1/intelligence_readiness?select=status&ranking_date=eq.${encodeURIComponent(date)}&status=eq.SUCCEEDED&order=completed_at.desc&limit=1`, { headers: { "accept-profile": "app_private" } });
      return Array.isArray(readiness) && readiness.length > 0;
    },
    listRankings: async (date) => {
      const rows = await rest(`/rest/v1/editorial_rankings?select=story_cluster_id,ranking_version,rank,editorial_score,information_gap_score,discovery_audience_signal_score,grounding_status,news_eligible&ranking_date=eq.${encodeURIComponent(date)}&order=rank.asc.nullslast,editorial_score.desc`, { headers: { "accept-profile": "app_private" } });
      return Array.isArray(rows) ? rows.flatMap((value) => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).story_cluster_id === "string" && typeof (value as Record<string, unknown>).ranking_version === "string" && typeof (value as Record<string, unknown>).editorial_score === "number" && typeof (value as Record<string, unknown>).information_gap_score === "number" && typeof (value as Record<string, unknown>).discovery_audience_signal_score === "number" && typeof (value as Record<string, unknown>).grounding_status === "string" ? [value as never] : []) : [];
    },
    listClusters: async (ids) => {
      const rows = await rest(`/rest/v1/story_clusters?select=id,canonical_title,summary,signature_json&id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})`);
      return Array.isArray(rows) ? rows.flatMap((value) => typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).id === "string" && typeof (value as Record<string, unknown>).canonical_title === "string" ? [value as never] : []) : [];
    },
    insertEvent: async (event) => {
      const inserted = await rest("/rest/v1/telegram_alert_events?on_conflict=event_fingerprint", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation", "content-profile": "app_private" }, body: JSON.stringify(event) });
      return Array.isArray(inserted) && inserted.length > 0;
    },
  } });
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
