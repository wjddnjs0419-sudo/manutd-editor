import { createEspnFixtureProvider } from "../_shared/m6/espn_fixture_provider.ts";
import { createM6Repository } from "../_shared/m6/repository.ts";
import { runFixtureSync } from "../_shared/m6/fixture_service.ts";
import { buildMatchContext, decideMatchD1BriefingEvent, projectMatchToCalendarBestEffort } from "../_shared/m6/match_assistant.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";
import { createFixtureSyncHandler } from "./handler.ts";

const secret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? Deno.env.get("COLLECTOR_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const repository = createM6Repository({ supabaseUrl, serviceRoleKey });
const provider = createEspnFixtureProvider();
const alertThreadId = Deno.env.get("TELEGRAM_OWNER_THREAD_ID") ?? "00000000-0000-0000-0000-000000000000";
const notionToken = Deno.env.get("NOTION_TOKEN") ?? Deno.env.get("NOTION_API_KEY") ?? "";
const notionDatabaseId = Deno.env.get("NOTION_MATCH_CALENDAR_DATABASE_ID") ?? "";
const notion = notionToken && notionDatabaseId ? createNotionClient({ token: notionToken, databaseId: notionDatabaseId }) : null;

interface CalendarStateRow {
  match_id: string;
  notion_page_id: string | null;
  last_synced_hash: string | null;
  last_synced_at?: string | null;
}

async function rest(path: string, init: RequestInit = {}): Promise<unknown> {
  const base = supabaseUrl.replace(/\/$/u, "");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      accept: "application/json",
      "accept-profile": "app_private",
      "content-profile": "app_private",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error("FIXTURE_RUNTIME_STORAGE_FAILED");
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function projectCalendar(match: Parameters<NonNullable<Parameters<typeof runFixtureSync>[1]["onMatchSynced"]>>[0], mode: Parameters<NonNullable<Parameters<typeof runFixtureSync>[1]["onMatchSynced"]>>[1], syncedAt: Date): Promise<void> {
  await projectMatchToCalendarBestEffort({
    match,
    mode,
    configured: Boolean(notion),
    notion,
    async getState(matchId) {
      const rows = await rest(`/rest/v1/match_calendar_sync_state?select=match_id,notion_page_id,last_synced_hash,last_synced_at&match_id=eq.${encodeURIComponent(matchId)}&limit=1`);
      const value = Array.isArray(rows) ? rows[0] as CalendarStateRow | undefined : undefined;
      return value?.match_id ? value : null;
    },
    async saveState(state) {
      await rest("/rest/v1/match_calendar_sync_state?on_conflict=match_id", { method: "POST", headers: { prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(state) });
    },
    syncedAt,
  });
}

async function onMatchSynced(match: Parameters<NonNullable<Parameters<typeof runFixtureSync>[1]["onMatchSynced"]>>[0], mode: Parameters<NonNullable<Parameters<typeof runFixtureSync>[1]["onMatchSynced"]>>[1], syncedAt: Date): Promise<number> {
  let alertsCreated = 0;
  const d1 = decideMatchD1BriefingEvent(match, syncedAt);
  if (d1) {
    const inserted = await repository.insertAlertEventIfAbsent({
      thread_id: alertThreadId,
      event_type: d1.event_type,
      match_id: match.id,
      event_fingerprint: d1.event_fingerprint,
      payload: {
        match_id: match.id,
        opponent: match.opponent,
        kickoff_at: match.kickoff_at,
        kickoff_display: buildMatchContext(match, syncedAt).kickoff_display,
        competition: match.competition,
        home_away: match.is_home ? "HOME" : "AWAY",
        venue: match.venue,
        status: match.status,
      },
      status: "PENDING",
    });
    if (inserted) alertsCreated += 1;
  }
  await projectCalendar(match, mode, syncedAt);
  return alertsCreated;
}

const handler = createFixtureSyncHandler({
  invokeSecret: secret,
  run: ({ mode }) => runFixtureSync({ mode, now: new Date() }, {
    provider,
    repository,
    alertThreadId,
    onMatchSynced,
  }),
});

Deno.serve(handler);
