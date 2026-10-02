import { assertEquals } from "jsr:@std/assert@1.0.8";
import { runMatchCalendarBackfill } from "../../_shared/m6/match_calendar_backfill.ts";
import { projectMatchToCalendarBestEffort } from "../../_shared/m6/match_assistant.ts";
import type { StoredMatch } from "../../_shared/m6/fixture_types.ts";

const match: StoredMatch = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  provider: "espn",
  external_match_id: "123",
  competition: "Premier League",
  season: "2026",
  home_team: "Manchester United",
  away_team: "Arsenal",
  opponent: "Arsenal",
  is_home: true,
  kickoff_at: "2026-10-10T16:30:00.000Z",
  venue: "Old Trafford",
  status: "SCHEDULED",
  home_score: null,
  away_score: null,
  provider_payload: {},
  provider_updated_at: null,
};

function makeBackfill(options: {
  initialPages?: Array<{ id: string; properties: Record<string, unknown> }>;
  initialState?: {
    match_id: string;
    notion_page_id: string | null;
    last_synced_hash: string | null;
  } | null;
} = {}) {
  const pages = [...(options.initialPages ?? [])];
  let state = options.initialState ?? null;
  let created = 0;
  let updated = 0;
  const project = (
    value: StoredMatch,
    mode:
      | "NORMAL_DAY"
      | "MATCH_DAY_PRE"
      | "MATCH_EVE"
      | "MATCH_LIVE"
      | "MATCH_POST",
    syncedAt: Date,
  ) =>
    projectMatchToCalendarBestEffort({
      match: value,
      mode,
      configured: true,
      notion: {
        async createPage(payload) {
          created += 1;
          const page = {
            id: `page-${created}`,
            properties: payload.properties,
          };
          pages.push(page);
          return { id: page.id };
        },
        async updatePage(pageId, payload) {
          updated += 1;
          const page = pages.find((candidate) => candidate.id === pageId);
          if (!page) throw new Error("page not found");
          page.properties = payload.properties;
          return { id: pageId };
        },
        async queryDatabase() {
          return pages;
        },
      },
      async getState() {
        return state;
      },
      async saveState(value) {
        state = value;
      },
      syncedAt,
    });
  return {
    pages,
    get created() {
      return created;
    },
    get updated() {
      return updated;
    },
    get state() {
      return state;
    },
    run(now = new Date("2026-10-09T15:00:00.000Z")) {
      return runMatchCalendarBackfill({
        configured: true,
        now,
        async listMatches() {
          return [match];
        },
        project,
      });
    },
  };
}

Deno.test("backfill creates missing pages and reruns update the saved page without duplicates", async () => {
  const backfill = makeBackfill();
  const first = await backfill.run();
  const second = await backfill.run(new Date("2026-10-09T15:15:00.000Z"));
  assertEquals(first.matches_synced, 1);
  assertEquals(second.matches_synced, 1);
  assertEquals(backfill.created, 1);
  assertEquals(backfill.updated, 1);
  assertEquals(backfill.pages.length, 1);
  assertEquals(backfill.state?.notion_page_id, "page-1");
});

Deno.test("backfill finds and updates an existing Notion page by Match ID", async () => {
  const backfill = makeBackfill({
    initialPages: [{
      id: "existing-page",
      properties: { "Match ID": { rich_text: [{ plain_text: match.id }] } },
    }],
  });
  const result = await backfill.run();
  assertEquals(result.matches_synced, 1);
  assertEquals(backfill.created, 0);
  assertEquals(backfill.updated, 1);
  assertEquals(backfill.pages.length, 1);
  assertEquals(backfill.state?.notion_page_id, "existing-page");
});

Deno.test("backfill returns an explicit configuration skip", async () => {
  let listed = false;
  const result = await runMatchCalendarBackfill({
    configured: false,
    now: new Date("2026-10-09T15:00:00.000Z"),
    async listMatches() {
      listed = true;
      return [match];
    },
    async project() {
      throw new Error("must not project");
    },
  });
  assertEquals(result.status, "SKIPPED_CONFIGURATION");
  assertEquals(listed, false);
});
