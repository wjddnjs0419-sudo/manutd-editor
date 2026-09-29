import { assertEquals } from "jsr:@std/assert@1.0.8";
import {
  buildMatchContext,
  decideMatchD1BriefingEvent,
  getMatchBriefingPhase,
  isMaterialKickoffChange,
  projectMatchToCalendarBestEffort,
} from "../../_shared/m6/match_assistant.ts";
import type { StoredMatch } from "../../_shared/m6/fixture_types.ts";

const match = (overrides: Partial<StoredMatch> = {}): StoredMatch => ({
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  provider: "espn",
  external_match_id: "123",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Tottenham",
  opponent: "Tottenham",
  is_home: true,
  kickoff_at: "2026-10-10T16:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null,
  provider_payload: {},
  provider_updated_at: null,
  ...overrides,
});

Deno.test("match context includes canonical fixture facts and Seoul kickoff display", () => {
  const context = buildMatchContext(
    match(),
    new Date("2026-10-09T15:00:00.000Z"),
  );
  assertEquals(context, {
    match_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    opponent: "Tottenham",
    kickoff_at: "2026-10-10T16:30:00.000Z",
    kickoff_local_date: "2026-10-11",
    kickoff_local_time: "01:30",
    kickoff_display: "2026-10-11 01:30 KST",
    kickoff_timezone: "Asia/Seoul",
    competition: "Premier League",
    home_away: "HOME",
    venue: "Old Trafford",
    fixture_status: "SCHEDULED",
    current_match_phase: "MATCH_EVE",
    match_briefing_phase: "D_MINUS_1",
  });
});

Deno.test("D-1 event is offered once on the Korean calendar day before kickoff", () => {
  const scheduled = match();
  const decision = decideMatchD1BriefingEvent(
    scheduled,
    new Date("2026-10-09T15:00:00.000Z"),
  );
  assertEquals(decision, {
    event_type: "MATCH_BRIEFING_D1",
    match_id: scheduled.id,
    event_fingerprint: `MATCH_BRIEFING_D1:${scheduled.id}:2026-10-10`,
  });
  assertEquals(
    decideMatchD1BriefingEvent(
      scheduled,
      new Date("2026-10-09T15:00:00.000Z"),
      true,
    ),
    null,
  );
  assertEquals(
    decideMatchD1BriefingEvent(scheduled, new Date("2026-10-09T14:59:59.000Z")),
    null,
  );
});

Deno.test("D-DAY phase remains available for the 09:00 Seoul morning briefing", () => {
  const scheduled = match({ kickoff_at: "2026-10-11T04:30:00.000Z" });
  const morning = new Date("2026-10-11T00:00:00.000Z");
  assertEquals(getMatchBriefingPhase(scheduled, morning), "D_DAY");
  assertEquals(
    buildMatchContext(scheduled, morning).match_briefing_phase,
    "D_DAY",
  );
});

Deno.test("kickoff changes are material at 15 minutes or across Seoul dates", () => {
  assertEquals(
    isMaterialKickoffChange(
      "2026-10-10T16:30:00.000Z",
      "2026-10-10T16:44:00.000Z",
    ),
    false,
  );
  assertEquals(
    isMaterialKickoffChange(
      "2026-10-10T16:30:00.000Z",
      "2026-10-10T16:45:00.000Z",
    ),
    true,
  );
  assertEquals(
    isMaterialKickoffChange(
      "2026-10-10T14:55:00.000Z",
      "2026-10-10T15:05:00.000Z",
    ),
    true,
  );
  assertEquals(
    isMaterialKickoffChange(
      "2026-10-10T16:30:00.000Z",
      "2026-10-10T16:30:00.000Z",
    ),
    false,
  );
});

Deno.test("Notion projection failure is reported without escaping into fixture processing", async () => {
  const result = await projectMatchToCalendarBestEffort({
    match: match(),
    mode: "MATCH_EVE",
    configured: true,
    notion: {
      async createPage() {
        throw new Error("Notion unavailable");
      },
      async updatePage() {
        throw new Error("Notion unavailable");
      },
      async queryDatabase() {
        return [];
      },
    },
    async getState() {
      return null;
    },
    async saveState() {
      throw new Error("must not save a failed projection");
    },
    syncedAt: new Date("2026-10-09T15:00:00.000Z"),
  });
  assertEquals(result.status, "FAILED");
  assertEquals(result.notion_page_id, null);
});

Deno.test("Notion projection is skipped cleanly when the calendar is not configured", async () => {
  let stateReads = 0;
  const result = await projectMatchToCalendarBestEffort({
    match: match(),
    mode: "MATCH_EVE",
    configured: false,
    notion: null,
    async getState() {
      stateReads += 1;
      return null;
    },
    async saveState() {},
  });
  assertEquals(result.status, "SKIPPED");
  assertEquals(stateReads, 0);
});

Deno.test("Notion projection reuses a page found by canonical Match ID and stores only projection state", async () => {
  const updated: string[] = [];
  const saved: string[] = [];
  const result = await projectMatchToCalendarBestEffort({
    match: match(),
    mode: "MATCH_EVE",
    configured: true,
    notion: {
      async createPage() {
        throw new Error("duplicate creation");
      },
      async updatePage(pageId, payload) {
        updated.push(pageId);
        const properties =
          (payload as { properties: Record<string, unknown> }).properties;
        assertEquals("콘텐츠 여부" in properties, false);
        return { id: pageId };
      },
      async queryDatabase() {
        return [{
          id: "existing-notion-page",
          properties: {
            "Match ID": { rich_text: [{ plain_text: match().id }] },
          },
        }];
      },
    },
    async getState() {
      return null;
    },
    async saveState(state) {
      saved.push(`${state.match_id}:${state.notion_page_id}`);
    },
    syncedAt: new Date("2026-10-09T15:00:00.000Z"),
  });
  assertEquals(result.status, "SYNCED");
  assertEquals(updated, ["existing-notion-page"]);
  assertEquals(saved, [`${match().id}:existing-notion-page`]);
});
