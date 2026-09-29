import { dispatchPendingAlerts, type PendingAlert } from "../_shared/m6/alerts.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createTelegramAlertsHandler } from "./handler.ts";
import { materializeEditorialJobDeadAlerts } from "./dead_alerts.ts";
import { materializeEditorialStoryAlerts, type EditorialStoryAlertRepository, type EditorialStoryAlertRow, type StoryAlertStateRecord } from "./editorial_alerts.ts";

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

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];
}

async function createEditorialStoryAlertRepository(now: Date): Promise<EditorialStoryAlertRepository> {
  const cutoff = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const storiesValue = await rest(`/rest/v1/story_clusters?select=id,canonical_title,summary,first_seen_at,last_seen_at,signature_json&status=neq.ARCHIVED&last_seen_at=gte.${encodeURIComponent(cutoff)}&limit=500`);
  const snapshotsValue = await rest(`/rest/v1/trend_snapshots?select=story_cluster_id,snapshot_at,trend_score,trend_state,manutd_relevance_score,source_count,input_snapshot&snapshot_at=gte.${encodeURIComponent(cutoff)}&order=snapshot_at.desc&limit=2000`, { headers: { "accept-profile": "app_private" } });
  const rankingsValue = await rest(`/rest/v1/editorial_rankings?select=story_cluster_id,ranking_version,grounding_status,news_eligible&ranking_date=eq.${encodeURIComponent(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now))}&order=calculated_at.desc&limit=1000`, { headers: { "accept-profile": "app_private" } });
  const snapshots = Array.isArray(snapshotsValue) ? snapshotsValue.filter((value) => typeof value === "object" && value !== null).map((value) => value as Record<string, unknown>) : [];
  const rankings = Array.isArray(rankingsValue) ? rankingsValue.filter((value) => typeof value === "object" && value !== null).map((value) => value as Record<string, unknown>) : [];
  const rankingByStory = new Map<string, Record<string, unknown>>();
  for (const ranking of rankings) {
    const storyId = text(ranking.story_cluster_id);
    if (storyId && !rankingByStory.has(storyId)) rankingByStory.set(storyId, ranking);
  }
  const storyRows: EditorialStoryAlertRow[] = [];
  for (const value of Array.isArray(storiesValue) ? storiesValue : []) {
    const story = object(value);
    const storyId = text(story.id);
    const firstSeenAt = text(story.first_seen_at);
    const lastSeenAt = text(story.last_seen_at);
    const title = text(story.canonical_title);
    if (!storyId || !firstSeenAt || !lastSeenAt || !title) continue;
    const signature = object(story.signature_json);
    const fingerprints = new Set(stringList(signature.content_fingerprints));
    const snapshot = snapshots.find((candidate) => {
      if (text(candidate.story_cluster_id) === storyId) return true;
      const input = object(candidate.input_snapshot);
      return stringList(input.content_fingerprints).some((fingerprint) => fingerprints.has(fingerprint));
    });
    if (!snapshot) continue;
    const ranking = rankingByStory.get(storyId);
    storyRows.push({
      storyId,
      title,
      summary: story.summary === null ? null : text(story.summary),
      trendState: text(snapshot.trend_state),
      trendScore: finiteNumber(snapshot.trend_score),
      relevanceScore: finiteNumber(snapshot.manutd_relevance_score),
      sourceCount: finiteNumber(snapshot.source_count) ?? 0,
      firstSeenAt,
      lastSeenAt,
      groundingStatus: text(ranking?.grounding_status) ?? "DISCOVERY_ONLY",
      newsEligible: ranking?.news_eligible === true,
      rankingVersion: text(ranking?.ranking_version),
    });
  }
  return {
    threadId: ownerThreadId,
    async listStories() { return storyRows; },
    async getState(storyId) {
      const rows = await rest(`/rest/v1/telegram_story_alert_state?select=story_cluster_id,observed_state,last_alerted_state,last_alerted_at,verified_notified&story_cluster_id=eq.${encodeURIComponent(storyId)}&limit=1`, { headers: { "accept-profile": "app_private" } });
      const value = Array.isArray(rows) ? object(rows[0]) : {};
      return text(value.story_cluster_id) ? {
        storyId: text(value.story_cluster_id)!,
        observedState: value.observed_state === "RISING" || value.observed_state === "BREAKING" ? value.observed_state : null,
        lastAlertedState: value.last_alerted_state === "RISING" || value.last_alerted_state === "BREAKING" ? value.last_alerted_state : null,
        lastAlertedAt: value.last_alerted_at === null ? null : text(value.last_alerted_at),
        verifiedNotified: value.verified_notified === true,
      } satisfies StoryAlertStateRecord : null;
    },
    async saveState(state) {
      await rest("/rest/v1/telegram_story_alert_state?on_conflict=story_cluster_id", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal", "content-profile": "app_private" }, body: JSON.stringify({ story_cluster_id: state.storyId, observed_state: state.observedState, last_alerted_state: state.lastAlertedState, last_alerted_at: state.lastAlertedAt, verified_notified: state.verifiedNotified }) });
    },
    async insertEvent(event) {
      const inserted = await rest("/rest/v1/telegram_alert_events?on_conflict=event_fingerprint", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation", "content-profile": "app_private" }, body: JSON.stringify({ thread_id: event.threadId, story_cluster_id: event.storyId, event_type: event.eventType, event_fingerprint: event.eventFingerprint, payload: event.payload, status: "PENDING" }) });
      return Array.isArray(inserted) && inserted.length > 0;
    },
  };
}

async function runAlerts() {
  await materializeEditorialJobDeadAlerts({ supabaseUrl, serviceKey: serviceRoleKey, threadId: ownerThreadId });
  if (ownerThreadId) {
    try {
      const alertRepository = await createEditorialStoryAlertRepository(new Date());
      await materializeEditorialStoryAlerts(new Date(), alertRepository);
    } catch {
      // Real-time alert materialization is non-critical to pending alert delivery.
    }
  }
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
