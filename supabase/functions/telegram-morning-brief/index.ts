import { createApiFootballProvider } from "../_shared/m6/api_football_provider.ts";
import { buildMorningBriefingSnapshot } from "../_shared/m6/briefing.ts";
import { runFixtureSync } from "../_shared/m6/fixture_service.ts";
import { createM6Repository } from "../_shared/m6/repository.ts";
import { createReferenceSignedUrl, selectRepresentativeReference } from "../_shared/m6/reference_media.ts";
import { createTelegramClient } from "../_shared/m6/telegram_client.ts";
import { createOpenAIGenerator, phraseMorningBrief, renderMorningBrief } from "../_shared/m6/openai.ts";
import { createMorningBriefHandler, type MorningBriefResult } from "./handler.ts";

const secret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ownerThreadId = Deno.env.get("TELEGRAM_OWNER_THREAD_ID") ?? "";
const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const repository = createM6Repository({ supabaseUrl, serviceRoleKey });
const provider = createApiFootballProvider({ apiKey: Deno.env.get("FOOTBALL_API_KEY") ?? "", teamId: Number(Deno.env.get("FOOTBALL_TEAM_ID") ?? "33") });

interface RestOptions { profile?: string; method?: string; body?: unknown; prefer?: string; }
async function rest(path: string, options: RestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, accept: "application/json" };
  if (options.profile) { headers["accept-profile"] = options.profile; headers["content-profile"] = options.profile; }
  if (options.body !== undefined) { headers["content-type"] = "application/json"; headers.prefer = options.prefer ?? "return=representation"; }
  const response = await fetch(`${supabaseUrl.replace(/\/$/u, "")}${path}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (!response.ok) throw new Error("STORAGE_REQUEST_FAILED");
  const text = await response.text();
  return text.trim() ? JSON.parse(text) : null;
}

async function signedUrl(path: string): Promise<string | null> {
  return createReferenceSignedUrl({ id: "asset", storage_path: path }, { from: () => ({ createSignedUrl: async (storagePath, expiresIn) => {
    try {
      const response = await fetch(`${supabaseUrl.replace(/\/$/u, "")}/storage/v1/object/sign/instagram-analysis`, { method: "POST", headers: { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, "content-type": "application/json" }, body: JSON.stringify({ path: storagePath, expiresIn }) });
      if (!response.ok) return { data: null, error: true };
      const body = await response.json() as { signedURL?: string; signedUrl?: string };
      const value = body.signedURL ?? body.signedUrl;
      return { data: value ? { signedUrl: `${supabaseUrl.replace(/\/$/u, "")}/storage/v1${value.startsWith("/") ? value : `/${value}`}` } : null, error: value ? null : true };
    } catch { return { data: null, error: true }; }
  } }) }, 600);
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function runMorningBrief(): Promise<MorningBriefResult> {
  if (!ownerThreadId || !botToken) throw new Error("TELEGRAM_OWNER_CONFIGURATION_MISSING");
  const configRows = await rest("/rest/v1/telegram_agent_configs?select=*&is_active=eq.true&limit=1");
  const config = Array.isArray(configRows) ? configRows[0] as Record<string, unknown> | undefined : undefined;
  if (!config) throw new Error("ACTIVE_AGENT_CONFIG_MISSING");
  const timezone = typeof config.timezone === "string" ? config.timezone : "Asia/Seoul";
  const now = new Date();
  const briefingDate = localDate(now, timezone);
  const existing = await rest(`/rest/v1/telegram_briefings?select=briefing_date,sent_at&thread_id=eq.${encodeURIComponent(ownerThreadId)}&briefing_date=eq.${briefingDate}&limit=1`, { profile: "app_private" });
  if (Array.isArray(existing) && existing.length > 0) return { status: "ALREADY_SENT", briefing_date: briefingDate, messages_sent: 0, render_mode: "FALLBACK_TEMPLATE" };

  const fixtureResult = await runFixtureSync({ mode: "FORCE", now }, { provider, repository, alertThreadId: ownerThreadId });
  const rows = await repository.listBriefingCandidates(briefingDate);
  const candidates = rows.slice(0, Number(config.briefing_top_n ?? 3)).map((row) => ({
    candidate_id: row.candidate_id,
    priority_score: row.priority_score,
    first_mover_flag: row.first_mover_flag,
    must_cover_flag: row.must_cover_flag,
    creative_status: row.creative_status,
    representative: selectRepresentativeReference(row.reference_posts),
  }));
  const snapshot = buildMorningBriefingSnapshot({ briefing_date: briefingDate, timezone, match_day_mode: fixtureResult.match_day_mode, match_context: {}, overnight_counts: { candidates: rows.length }, candidates, blocked_failed: fixtureResult.status === "FAILED" ? [{ type: "FIXTURE_SYNC", error_category: fixtureResult.error_category ?? "UNKNOWN" }] : [] });
  const signedItems = await Promise.all(snapshot.items.map(async (item) => ({ ...item, reference_media_url: null as string | null })));
  for (let index = 0; index < snapshot.items.length; index += 1) {
    const path = candidates[index]?.representative?.media_storage_path;
    signedItems[index].reference_media_url = path ? await signedUrl(path) : null;
  }
  const renderSnapshot = { ...snapshot, items: signedItems };
  const modelConfig = typeof config.model_config === "object" && config.model_config !== null ? config.model_config as Record<string, unknown> : {};
  const phrasing = await phraseMorningBrief(renderSnapshot, { generate: Deno.env.get("OPENAI_API_KEY") ? createOpenAIGenerator({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "", model: typeof modelConfig.model === "string" ? modelConfig.model : undefined }) : undefined, maxNoteChars: 140 });
  const plans = renderMorningBrief(renderSnapshot, phrasing);
  const rendered = plans.map((plan) => plan.text).join("\n\n");
  const briefingInsert = await rest("/rest/v1/telegram_briefings", { profile: "app_private", method: "POST", body: { briefing_date: briefingDate, thread_id: ownerThreadId, match_context: {}, candidate_snapshot: snapshot, rendered_message: rendered, generation_metadata: { render_mode: phrasing.render_mode ?? "FALLBACK_TEMPLATE", fixture_sync_status: fixtureResult.status } }, prefer: "resolution=ignore-duplicates,return=representation" });
  if (!Array.isArray(briefingInsert) || !briefingInsert[0]) return { status: "ALREADY_SENT", briefing_date: briefingDate, messages_sent: 0, render_mode: phrasing.render_mode ?? "FALLBACK_TEMPLATE" };
  const client = createTelegramClient({ token: botToken });
  let sent = 0;
  for (const plan of plans) {
    const result = plan.kind === "photo" && plan.photo_url ? await client.sendPhoto(Deno.env.get("TELEGRAM_CHAT_ID") ?? "", plan.photo_url, plan.text) : await client.sendText(Deno.env.get("TELEGRAM_CHAT_ID") ?? "", plan.text);
    await rest("/rest/v1/telegram_messages", { profile: "app_private", method: "POST", body: { thread_id: ownerThreadId, telegram_message_id: result.message_id, role: "ASSISTANT", message_type: "BRIEFING", content: plan.text, metadata: { briefing_date: briefingDate } }, prefer: "return=minimal" });
    sent += 1;
  }
  await rest(`/rest/v1/telegram_briefings?thread_id=eq.${encodeURIComponent(ownerThreadId)}&briefing_date=eq.${briefingDate}`, { profile: "app_private", method: "PATCH", body: { sent_at: new Date().toISOString() }, prefer: "return=minimal" });
  return { status: "SENT", briefing_date: briefingDate, messages_sent: sent, render_mode: phrasing.render_mode ?? "FALLBACK_TEMPLATE", warning: fixtureResult.status === "FAILED" ? "Fixture refresh failed; briefing used last canonical fixture state." : undefined };
}

Deno.serve(createMorningBriefHandler({ invokeSecret: secret, run: async () => runMorningBrief() }));
