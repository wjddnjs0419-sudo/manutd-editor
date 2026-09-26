import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("M7 architecture documents Supabase ownership and n8n legacy status", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const legacyReadme = await readFile(new URL("n8n/README.md", root), "utf8");

  assert.match(readme, /Supabase is the canonical database, orchestration layer, scheduler, and Edge Function runtime/u);
  assert.match(readme, /Telegram uses the direct `telegram-agent` webhook/u);
  assert.match(readme, /n8n is legacy and not required for production/u);
  assert.doesNotMatch(readme, /n8n Schedule.*collect-instagram.*intelligence.*sync-notion-intelligence/su);
  assert.match(legacyReadme, /^# LEGACY —/u);
  assert.match(legacyReadme, /replaced/iu);
  assert.match(legacyReadme, /rollback/iu);
  assert.match(legacyReadme, /PROJECT_NOTION/iu);
});

test("required M7 smoke path does not validate or require n8n", async () => {
  const smoke = await readFile(new URL("scripts/run-milestone-7-smoke.sh", root), "utf8");
  assert.doesNotMatch(smoke, /validate-n8n-workflow/u);
  assert.doesNotMatch(smoke, /n8n\/workflows/u);
  assert.match(smoke, /milestone_7_phase_3_parity_test/u);
});
