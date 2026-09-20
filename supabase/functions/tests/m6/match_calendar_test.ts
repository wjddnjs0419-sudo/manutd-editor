import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMatchCalendarProperties,
  projectMatchToCalendar,
} from "../../_shared/m6/match_calendar.ts";
import type { StoredMatch } from "../../_shared/m6/fixture_types.ts";

const match = (overrides: Partial<StoredMatch> = {}): StoredMatch => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  provider: "espn",
  external_match_id: "123",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Arsenal",
  opponent: "Arsenal",
  is_home: true,
  kickoff_at: "2026-09-20T11:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null,
  provider_payload: {},
  provider_updated_at: null,
  ...overrides,
});

test("builds system-owned Match Calendar fields without touching 콘텐츠 여부", () => {
  const payload = buildMatchCalendarProperties(match(), "MATCH_DAY_PRE");
  assert.deepEqual(payload["Match ID"], { rich_text: [{ type: "text", text: { content: match().id } }] });
  assert.deepEqual(payload["Content Phase"], { select: { name: "MATCH_DAY_PRE" } });
  assert.equal("콘텐츠 여부" in payload, false);
});

test("maps Manchester United result from home and away perspective", () => {
  assert.equal((buildMatchCalendarProperties(match({ home_score: 2, away_score: 1 }), "MATCH_POST")["결과"] as { select: { name: string } }).select.name, "승");
  assert.equal((buildMatchCalendarProperties(match({ home_score: 1, away_score: 1 }), "MATCH_POST")["결과"] as { select: { name: string } }).select.name, "무");
  assert.equal((buildMatchCalendarProperties(match({ is_home: false, home_team: "Arsenal", away_team: "Manchester United", home_score: 0, away_score: 2 }), "MATCH_POST")["결과"] as { select: { name: string } }).select.name, "승");
  assert.equal((buildMatchCalendarProperties(match(), "MATCH_DAY_PRE")["결과"] as { select: { name: string } }).select.name, "미정");
});

test("uses stable page identity and updates only system properties", async () => {
  const calls: Array<{ type: string; id?: string; payload: unknown }> = [];
  const notion = {
    async createPage(payload: unknown) { calls.push({ type: "create", payload }); return { id: "new-page" }; },
    async updatePage(id: string, payload: unknown) { calls.push({ type: "update", id, payload }); return { id }; },
  };
  const existing = { match_id: match().id, notion_page_id: "stable-page", last_synced_hash: "old" };
  const result = await projectMatchToCalendar(match(), existing, notion);
  assert.equal(result.status, "SYNCED");
  assert.equal(result.notion_page_id, "stable-page");
  assert.equal(calls[0]?.type, "update");
  assert.equal(calls[0]?.id, "stable-page");
  assert.equal("콘텐츠 여부" in ((calls[0]?.payload as { properties: Record<string, unknown> }).properties), false);
});
