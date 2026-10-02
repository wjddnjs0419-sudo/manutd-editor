import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

test("M8 Telegram console keeps buttons and natural language on one action layer", async () => {
  const actions = await text("supabase/functions/_shared/m6/editorial_console_actions.ts");
  const agent = await text("supabase/functions/telegram-agent/index.ts");
  const generation = await text("supabase/functions/_shared/m6/console_generation.ts");
  assert.match(actions, /parseConsoleCallback/u);
  assert.match(actions, /parseConsoleIntent/u);
  assert.match(agent, /dispatchEditorialConsoleAction/u);
  assert.match(agent, /answerNaturalLanguage/u);
  assert.match(generation, /trigger_type: "MANUAL"/u);
  assert.match(agent, /telegram_console_state/u);
  assert.match(agent, /telegram_console_events/u);
});

test("M8 generation owns the ManUtd Editor style contract and public/internal boundary", async () => {
  const prompt = await text("supabase/functions/creative-generation/prompts.ts");
  const qualityGate = await text("supabase/functions/creative-generation/quality_gate.ts");
  const profile = await text("supabase/functions/_shared/editorial-style/manutd_editor.ts");
  const migration = await text("supabase/migrations/20260927223000_m8_activate_editor_style.sql");
  assert.match(prompt, /MANUTD_EDITOR_STYLE_INSTRUCTIONS/u);
  assert.match(qualityGate, /validateManutdEditorDraft/u);
  assert.match(profile, /manutd-editor-v1/u);
  assert.match(profile, /forbidden_public_phrases/u);
  assert.match(migration, /enable_style_validator/u);
  assert.match(migration, /min_slides.*3/su);
  assert.match(migration, /max_slides.*4/su);
});

test("M8 completion alerts are canonical, compact, and deduplicated", async () => {
  const alerts = await text("supabase/functions/telegram-alerts/intelligence_summary.ts");
  const renderer = await text("supabase/functions/_shared/m6/alerts.ts");
  const index = await text("supabase/functions/telegram-alerts/index.ts");
  assert.match(alerts, /INTELLIGENCE_COMPLETE/u);
  assert.match(alerts, /event_fingerprint/u);
  assert.match(renderer, /inline_keyboard/u);
  assert.match(index, /materializeHourlyEditorialDigest/u);
  assert.match(index, /buildEditorialDigest/u);
  assert.match(index, /telegram_alert_events/u);
  assert.match(renderer, /BREAKING_STORY|RISING_STORY|VERIFIED_STORY/u);
});

test("M8 console does not add publishing or Figma runtime code", async () => {
  const agent = await text("supabase/functions/telegram-agent/index.ts");
  const generation = await text("supabase/functions/creative-generation/orchestrator.ts");
  assert.doesNotMatch(agent, /published_posts|instagram\.com\/[^\s]+\/publish/u);
  assert.doesNotMatch(generation, /Figma|figma/u);
});
