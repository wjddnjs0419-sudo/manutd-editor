import { dispatchPendingAlerts, type PendingAlert } from "../_shared/m6/alerts.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createEditorialConsoleRepository } from "../_shared/m6/editorial_console.ts";
import { createTelegramAlertsHandler } from "./handler.ts";
import { materializeEditorialJobDeadAlerts } from "./dead_alerts.ts";
import { hasCanonicalGrounding, materializeEditorialStoryAlerts, selectPrimaryEditorialEvidence, type CanonicalEditorialEvidence, type EditorialStoryAlertRepository, type EditorialStoryAlertRow, type StoryAlertStateRecord } from "./editorial_alerts.ts";

const secret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ownerThreadId = Deno.env.get("TELEGRAM_OWNER_THREAD_ID") ?? "";
const baseUrl = supabaseUrl.replace(/\/$/u, "");
const headers = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, accept: "application/json" };

async function rest(path: string, init: RequestInit = {}, profile?: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...(profile ? { "accept-profile": profile, "content-profile": profile } : {}), ...(init.headers ?? {}) } });
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
  const rankingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
  const storiesValue = await rest(`/rest/v1/story_clusters?select=id,canonical_title,summary,first_seen_at,last_seen_at,signature_json&status=neq.ARCHIVED&last_seen_at=gte.${encodeURIComponent(cutoff)}&limit=500`);
  const snapshotsValue = await rest(`/rest/v1/trend_snapshots?select=story_cluster_id,snapshot_at,trend_score,trend_state,manutd_relevance_score,source_count,input_snapshot&snapshot_at=gte.${encodeURIComponent(cutoff)}&order=snapshot_at.desc&limit=2000`, { headers: { "accept-profile": "app_private" } });
  const rankingsValue = await rest(`/rest/v1/editorial_rankings?select=story_cluster_id,ranking_version,grounding_status,news_eligible&ranking_date=eq.${encodeURIComponent(rankingDate)}&order=calculated_at.desc&limit=1000`, { headers: { "accept-profile": "app_private" } });
  const [canonicalStories, claimsValue, claimEvidenceValue, observationsValue, informationSourcesValue] = await Promise.all([
    createEditorialConsoleRepository({ supabaseUrl, serviceRoleKey }).listCanonicalStories(rankingDate),
    rest("/rest/v1/story_claims?select=id,story_cluster_id,claim_text,grounding_status&limit=5000", { headers: { "accept-profile": "app_private" } }),
    rest("/rest/v1/claim_evidence?select=claim_id,source_observation_id,editorial_role,evidence_text,is_grounding&limit=10000", { headers: { "accept-profile": "app_private" } }),
    rest("/rest/v1/source_observations?select=id,information_source_id,canonical_url,title,editorial_role&limit=10000", { headers: { "accept-profile": "app_private" } }),
    rest("/rest/v1/information_sources?select=id,canonical_name&limit=1000"),
  ]);
  const snapshots = Array.isArray(snapshotsValue) ? snapshotsValue.filter((value) => typeof value === "object" && value !== null).map((value) => value as Record<string, unknown>) : [];
  const rankings = Array.isArray(rankingsValue) ? rankingsValue.filter((value) => typeof value === "object" && value !== null).map((value) => value as Record<string, unknown>) : [];
  const canonicalByStory = new Map(canonicalStories.map((story) => [story.id, story]));
  const claimById = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(claimsValue) ? claimsValue : []) {
    const claim = object(value);
    if (text(claim.id) && text(claim.story_cluster_id)) claimById.set(text(claim.id)!, claim);
  }
  const evidenceByClaim = new Map<string, Record<string, unknown>[]>();
  for (const value of Array.isArray(claimEvidenceValue) ? claimEvidenceValue : []) {
    const evidence = object(value);
    const claimId = text(evidence.claim_id);
    if (claimId) evidenceByClaim.set(claimId, [...(evidenceByClaim.get(claimId) ?? []), evidence]);
  }
  const observationById = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(observationsValue) ? observationsValue : []) {
    const observation = object(value);
    if (text(observation.id)) observationById.set(text(observation.id)!, observation);
  }
  const sourceNameById = new Map<string, string>();
  for (const value of Array.isArray(informationSourcesValue) ? informationSourcesValue : []) {
    const source = object(value);
    if (text(source.id) && text(source.canonical_name)) sourceNameById.set(text(source.id)!, text(source.canonical_name)!);
  }
  function evidenceForStory(storyId: string): CanonicalEditorialEvidence[] {
    const rows: CanonicalEditorialEvidence[] = [];
    for (const claim of claimById.values()) {
      if (text(claim.story_cluster_id) !== storyId || !text(claim.id)) continue;
      for (const relation of evidenceByClaim.get(text(claim.id)!) ?? []) {
        const observation = text(relation.source_observation_id) ? observationById.get(text(relation.source_observation_id)!) : undefined;
        if (!observation) continue;
        rows.push({
          claim_id: text(claim.id),
          source_observation_id: text(observation.id),
          source_name: text(observation.information_source_id) ? sourceNameById.get(text(observation.information_source_id)!) ?? text(observation.title) : text(observation.title),
          canonical_url: text(observation.canonical_url),
          editorial_role: text(relation.editorial_role) ?? text(observation.editorial_role),
          is_grounding: relation.is_grounding === true,
          claim_text: text(claim.claim_text),
        });
      }
    }
    return rows;
  }
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
    const canonical = canonicalByStory.get(storyId);
    if (!canonical) continue;
    const evidence = evidenceForStory(storyId);
    const grounded = hasCanonicalGrounding(evidence);
    const primary = selectPrimaryEditorialEvidence(evidence);
    storyRows.push({
      storyId,
      title: canonical.title || title,
      summary: story.summary === null ? null : text(story.summary),
      trendState: text(snapshot.trend_state),
      trendScore: finiteNumber(snapshot.trend_score),
      relevanceScore: finiteNumber(snapshot.manutd_relevance_score),
      sourceCount: finiteNumber(snapshot.source_count) ?? 0,
      firstSeenAt,
      lastSeenAt,
      groundingStatus: canonical.grounding_status === "VERIFIED" && grounded ? "VERIFIED" : canonical.grounding_status === "VERIFIED" ? "INSUFFICIENT" : canonical.grounding_status,
      newsEligible: canonical.news_eligible === true && grounded,
      rankingVersion: text(ranking?.ranking_version),
      candidateId: canonical.candidate_id,
      primarySourceName: primary?.source_name ?? null,
      primarySourceUrl: primary?.canonical_url ?? null,
      primarySourceObservationId: primary?.source_observation_id ?? null,
      primaryClaimId: primary?.claim_id ?? null,
      groundingEvidenceAvailable: grounded,
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
      const inserted = await rest("/rest/v1/telegram_alert_events?on_conflict=event_fingerprint", { method: "POST", headers: { "content-type": "application/json", prefer: "resolution=ignore-duplicates,return=representation", "content-profile": "app_private" }, body: JSON.stringify({ thread_id: event.threadId, story_cluster_id: event.storyId, candidate_id: event.candidateId ?? null, event_type: event.eventType, event_fingerprint: event.eventFingerprint, payload: event.payload, status: "PENDING" }) });
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
  const rows = await rest("/rest/v1/telegram_alert_events?select=id,event_type,payload,thread_id,story_cluster_id,candidate_id&status=eq.PENDING&order=created_at.asc&limit=50", { headers: { "accept-profile": "app_private" } });
  const pending = Array.isArray(rows) ? rows as PendingAlert[] : [];
  const client = createTelegramClient({ token: botToken });
  return dispatchPendingAlerts({
    listPending: async () => pending,
    resolveChatId: async () => Deno.env.get("TELEGRAM_CHAT_ID") ?? "",
    client,
    markSent: async (id, sentAt) => { await rest(`/rest/v1/telegram_alert_events?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal", "content-profile": "app_private" }, body: JSON.stringify({ status: "SENT", sent_at: sentAt }) }); },
    markFailed: async (id, message) => { await rest(`/rest/v1/telegram_alert_events?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json", prefer: "return=minimal", "content-profile": "app_private" }, body: JSON.stringify({ status: "FAILED", last_error: message.slice(0, 120) }) }); },
    persistSentMessage: async (alert, telegramMessageId, rendered) => {
      const threadId = alert.thread_id ?? ownerThreadId;
      if (!threadId) return;
      const payload = object(alert.payload);
      const storyClusterId = text(payload.story_cluster_id) ?? text(payload.story_id);
      const candidateId = text(payload.candidate_id);
      await rest("/rest/v1/telegram_messages", {
        method: "POST",
        headers: { "content-type": "application/json", prefer: "return=minimal" },
        body: JSON.stringify({
          thread_id: threadId,
          telegram_message_id: telegramMessageId,
          telegram_update_id: null,
          role: "ASSISTANT",
          message_type: "ALERT",
          content: rendered.text,
          metadata: {
            message_kind: "EDITORIAL_STORY_ALERT",
            story_cluster_id: storyClusterId,
            candidate_id: candidateId,
            primary_source_observation_id: text(payload.primary_source_observation_id),
            event_type: alert.event_type,
            evidence_ids: [],
          },
        }),
      }, "app_private");
    },
  });
}

Deno.serve(createTelegramAlertsHandler({ invokeSecret: secret, run: runAlerts }));
