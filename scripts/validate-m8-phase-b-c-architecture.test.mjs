import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = async (path) => readFile(new URL(path, root), "utf8");

test("M8 B/C documents the source-role policy and canonical ownership", async () => {
  const readme = await text("README.md");
  const spec = await text("docs/superpowers/specs/2026-09-27-milestone-8-phase-b-c-grounding-ranking-design.md");
  for (const phrase of ["FACT_PRIMARY", "FACT_INDEPENDENT", "DISCOVERY_COMPETITOR", "DISCOVERY_COMMUNITY", "DISCOVERY_VIDEO", "MATCH_CONTEXT", "OWN_PERFORMANCE"]) {
    assert.match(spec, new RegExp(phrase));
  }
  assert.match(spec, /Discovery sources may create a lead/u);
  assert.match(spec, /can never make a claim `VERIFIED`/u);
  assert.match(spec, /published_posts.*performance_metrics/su);
  assert.match(readme, /Phase B\/C/u);
  assert.match(readme, /09:00 Asia\/Seoul/u);
  assert.match(readme, /Supabase is the canonical database, orchestration layer, scheduler, and Edge Function runtime/u);
});

test("M8 B/C preserves its grounding/ranking chain after additive M8.5 discovery", async () => {
  const types = await text("supabase/functions/orchestration-worker/types.ts");
  const worker = await text("supabase/functions/orchestration-worker/worker.ts");
  const schedule = await text("supabase/migrations/20260926151957_milestone_7_phase_2_scheduling.sql");
  assert.match(types, /"DISCOVER_SOURCES"/u);
  assert.match(types, /"GROUND_CLAIMS"/u);
  assert.match(types, /"RANK_EDITORIAL"/u);
  assert.match(worker, /RUN_INTELLIGENCE: "DISCOVER_SOURCES"/u);
  assert.match(worker, /DISCOVER_SOURCES: "DISCOVER_TRENDS"/u);
  assert.match(worker, /DISCOVER_TRENDS: "GROUND_CLAIMS"/u);
  assert.match(worker, /GROUND_CLAIMS: "RANK_EDITORIAL"/u);
  assert.match(worker, /RANK_EDITORIAL: "GENERATE_PRIORITY"/u);
  assert.match(schedule, /m7-morning-brief-0900-asia-seoul/u);
  assert.match(schedule, /0 0 \* \* \*/u);
});

test("grounding and ranking production code cannot read own-performance tables", async () => {
  for (const directory of ["supabase/functions/ground-claims", "supabase/functions/rank-editorial"]) {
    for (const name of await readdir(new URL(`../${directory}/`, import.meta.url))) {
      if (!name.endsWith(".ts")) continue;
      const source = await text(`${directory}/${name}`);
      assert.doesNotMatch(source, /published_posts|performance_metrics/u, `${directory}/${name}`);
    }
  }
});

test("local smoke and feed configuration are production-safe by default", async () => {
  const smoke = await text("scripts/run-milestone-8-phase-b-c-smoke.sh");
  const env = await text(".env.example");
  assert.match(smoke, /M8 Phase B\/C smoke only accepts a local SUPABASE_URL/u);
  assert.match(smoke, /supabase test db --local/u);
  assert.match(smoke, /deno test/u);
  assert.match(smoke, /diff --check/u);
  assert.match(env, /SOURCE_DISCOVERY_FEEDS_JSON=/u);
  assert.match(env, /SOURCE_DISCOVERY_MAX_BYTES=/u);
  assert.doesNotMatch(env, /SOURCE_DISCOVERY_FEEDS_JSON=https?:/u);
  assert.doesNotMatch(smoke, /supabase\.co|SUPABASE_SECRET_KEY='[A-Za-z0-9]/u);
});
