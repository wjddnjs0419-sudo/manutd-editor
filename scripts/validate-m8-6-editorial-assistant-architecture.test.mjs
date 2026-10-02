import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

test("M8.6 monitor pool preserves official and historical account contracts", async () => {
  const migration = await text("supabase/migrations/20260929115351_m8_6_instagram_monitoring.sql");
  const seed = await text("supabase/seed.sql");
  assert.match(migration, /source_account_monitor_role/u);
  assert.match(migration, /set active = false[\s\S]*utdreport[\s\S]*footballoop\.mag/u);
  assert.match(migration, /\('manutd', 'GLOBAL', 'OFFICIAL', true\)/u);
  assert.match(migration, /\('mufc_gossip_', 'KR', 'COMPETITOR', true\)/u);
  assert.match(seed, /\('manutd', 'GLOBAL', 'OFFICIAL'/u);
  assert.match(seed, /monitor_role/u);
  assert.match(seed, /instagram_username[\s\S]*'manutd'/u);
  const collector = await text("supabase/functions/collect-instagram/repository.ts");
  assert.match(collector, /api_supported:\s*"not\.is\.false"/u);
});

test("M8.6 entity context and scheduled profiles are bounded and deterministic", async () => {
  const entities = await text("supabase/functions/trend-discovery/entity_context.ts");
  const queryExpansion = await text("supabase/functions/trend-discovery/query_expansion.ts");
  const handler = await text("supabase/functions/trend-discovery/handler.ts");
  const telegram = await text("supabase/functions/telegram-agent/index.ts");
  const migration = await text("supabase/migrations/20260929140000_m8_6_discovery_promotion.sql");
  assert.match(entities, /EntityContextResolver/u);
  assert.match(queryExpansion, /PLAYER_SWEEP/u);
  assert.match(queryExpansion, /FAST/u);
  assert.match(handler, /search_profile/u);
  assert.match(telegram, /search_profile:\s*"MANUAL"/u);
  assert.match(migration, /enqueue_scheduled_discovery_job/u);
  assert.match(migration, /\*\/10 \* \* \* \*/u);
  assert.match(migration, /0 \* \* \* \*/u);
});

test("M8.6 promotion is an idempotent canonical bridge without discovery verification", async () => {
  const migration = await text("supabase/migrations/20260929140000_m8_6_discovery_promotion.sql");
  const orchestrator = await text("supabase/functions/promote-discovery/orchestrator.ts");
  const repository = await text("supabase/functions/promote-discovery/repository.ts");
  const worker = await text("supabase/functions/orchestration-worker/worker.ts");
  assert.match(migration, /discovery_promotion_key/u);
  assert.match(migration, /raw_post_id drop not null/u);
  assert.match(migration, /discovery_observation_id/u);
  assert.match(migration, /PROMOTE_DISCOVERY/u);
  assert.match(orchestrator, /listFreshUnassigned/u);
  assert.match(orchestrator, /ensureDiscoveryClaim/u);
  assert.match(orchestrator, /DISCOVERY_ONLY/u);
  assert.doesNotMatch(orchestrator, /groundingStatus.*VERIFIED/u);
  assert.match(repository, /ensureEditorialCandidate/u);
  assert.match(worker, /DISCOVER_TRENDS: "PROMOTE_DISCOVERY"/u);
});

test("M8.6 proactive alerts use transition state, cooldown, and grounded console actions", async () => {
  const alerts = await text("supabase/functions/telegram-alerts/editorial_alerts.ts");
  const migration = await text("supabase/migrations/20260929143000_m8_6_editorial_alerts.sql");
  const renderer = await text("supabase/functions/_shared/m6/alerts.ts");
  const index = await text("supabase/functions/telegram-alerts/index.ts");
  assert.match(alerts, /BREAKING_STORY/u);
  assert.match(alerts, /RISING_STORY/u);
  assert.match(alerts, /VERIFIED_STORY/u);
  assert.match(alerts, /COOLDOWN_MS/u);
  assert.match(alerts, /newsEligible/u);
  assert.match(alerts, /검증된 근거가 부족/u);
  assert.match(migration, /telegram_story_alert_state/u);
  assert.match(migration, /BREAKING_STORY/u);
  assert.match(migration, /RISING_STORY/u);
  assert.match(migration, /VERIFIED_STORY/u);
  assert.match(renderer, /renderEditorialStoryAlert/u);
  assert.match(index, /materializeHourlyEditorialDigest/u);
  assert.match(index, /EDITORIAL_DIGEST/u);
  assert.doesNotMatch(index, /materializeIntelligenceCompleteAlert\(/u);
});

test("M8.6 match assistant keeps Supabase canonical and Notion optional", async () => {
  const assistant = await text("supabase/functions/_shared/m6/match_assistant.ts");
  const fixture = await text("supabase/functions/_shared/m6/fixture_service.ts");
  const morning = await text("supabase/functions/telegram-morning-brief/index.ts");
  const fixtureRuntime = await text("supabase/functions/fixture-sync/index.ts");
  const renderer = await text("supabase/functions/_shared/m6/openai.ts");
  assert.match(assistant, /buildMatchContext/u);
  assert.match(assistant, /D_MINUS_1/u);
  assert.match(assistant, /projectMatchToCalendarBestEffort/u);
  assert.match(fixture, /onMatchSynced/u);
  assert.match(morning, /match_context: matchContext/u);
  assert.match(fixtureRuntime, /NOTION_MATCH_CALENDAR_DATABASE_ID/u);
  assert.match(fixtureRuntime, /projectMatchToCalendarBestEffort/u);
  assert.match(renderer, /Manchester United vs/u);
  assert.doesNotMatch(fixtureRuntime, /published_posts|instagram\.com\/[^\s]+\/publish/iu);
});

test("M8.6 local smoke is deterministic and external-provider free", async () => {
  const smoke = await text("scripts/run-milestone-8-6-smoke.sh");
  assert.match(smoke, /deno test/u);
  assert.match(smoke, /validate-m8-6-editorial-assistant-architecture/u);
  assert.match(smoke, /diff --check/u);
  assert.doesNotMatch(smoke, /telegram\.org|api\.notion\.com|api\.openai\.com|googleapis|gdeltproject|SUPABASE_SECRET_KEY='[A-Za-z0-9]/iu);
});
