import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

test("M8.5 has additive private discovery storage with idempotency and RLS", async () => {
  const migration = await text("supabase/migrations/20260927230000_m8_5_trend_discovery.sql");
  for (const table of ["discovery_runs", "discovery_queries", "discovery_observations", "trend_snapshots"]) assert.match(migration, new RegExp(`create table app_private\\.${table}`, "u"));
  assert.match(migration, /unique \(provider_id, external_id\)/u);
  assert.match(migration, /unique \(cluster_key, snapshot_at\)/u);
  assert.match(migration, /enable row level security/gu);
  assert.match(migration, /grant select, insert, update, delete on table .* to service_role/su);
  assert.match(migration, /telegram_console_state_view_check[\s\S]*TRENDING/u);
  assert.match(migration, /DISCOVER_TRENDS/u);
});

test("M8.5 keeps deterministic scoring, provider isolation, and safe normalization", async () => {
  const scoring = await text("supabase/functions/trend-discovery/scoring.ts");
  const normalization = await text("supabase/functions/trend-discovery/normalization.ts");
  const orchestrator = await text("supabase/functions/trend-discovery/orchestrator.ts");
  assert.match(scoring, /m8\.5-v1/u);
  assert.match(scoring, /velocity:\s*0\.30/u);
  assert.match(scoring, /crossSource:\s*0\.20/u);
  assert.match(scoring, /editorialScore/u);
  assert.match(normalization, /token|secret|authorization|payload/u);
  assert.match(orchestrator, /PARTIAL/u);
  assert.match(orchestrator, /isTrendRelevant/u);
});

test("M8.5 provider and Telegram boundaries are wired without publishing or footage download", async () => {
  const provider = await text("supabase/functions/trend-discovery/providers.ts");
  const handler = await text("supabase/functions/trend-discovery/handler.ts");
  const boundary = await text("supabase/functions/orchestration-worker/boundary_client.ts");
  const worker = await text("supabase/functions/orchestration-worker/worker.ts");
  const actions = await text("supabase/functions/_shared/m6/editorial_console_actions.ts");
  const consoleFile = await text("supabase/functions/_shared/m6/editorial_console.ts");
  assert.match(provider, /createFeedDiscoveryProvider/u);
  assert.match(handler, /collectorSecret/u);
  assert.match(boundary, /trend-discovery/u);
  assert.match(worker, /DISCOVER_TRENDS/u);
  assert.match(actions, /OPEN_TRENDING|DISCOVER_MORE|REFRESH_DISCOVERY/u);
  assert.match(consoleFile, /renderTrendingList/u);
  assert.doesNotMatch(provider, /download|youtube-dl|yt-dlp|instagram\.com\/[^\s]+\/publish/iu);
});
