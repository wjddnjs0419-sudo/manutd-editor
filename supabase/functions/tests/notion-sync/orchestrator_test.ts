import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1.0.8";
import type { CandidateProjectionInput } from "../../notion-sync/mapper.ts";
import {
  runNotionSync,
  type NotionSyncClientLike,
  type NotionSyncRepository,
  type SyncState,
} from "../../notion-sync/orchestrator.ts";

const clusterId = "22222222-2222-2222-2222-222222222222";
const candidateId = "11111111-1111-1111-1111-111111111111";
const rankingDate = "2026-09-18";

function candidate(overrides: Partial<CandidateProjectionInput["candidate"]> = {}): CandidateProjectionInput {
  return {
    candidate: {
      id: candidateId,
      story_cluster_id: clusterId,
      ranking_date: rankingDate,
      rank: 1,
      priority_score: 72,
      data_confidence: 90,
      first_mover_flag: false,
      must_cover_flag: false,
      korea_coverage_status: "KNOWN",
      global_spread_score: 10,
      engagement_outperformance_score: 8,
      engagement_velocity_score: 7,
      velocity_acceleration_score: 3,
      korea_gap_score: 12,
      first_mover_score: 6,
      korean_saturation_score: 2,
      reliability_score: 9,
      source_diversity_score: 3,
      freshness_score: 4,
      score_inputs: { global_coverage: 0.8, korean_coverage: 0.1 },
      calculated_at: "2026-09-18T03:00:00.000Z",
      ...overrides,
    },
    cluster: {
      id: clusterId,
      canonical_title: "Test story",
      status: "ACTIVE",
      first_seen_at: "2026-09-18T01:00:00.000Z",
      last_seen_at: "2026-09-18T03:00:00.000Z",
    },
    references: [{ username: "utdreport", region: "GLOBAL", permalink: "https://example.com/story" }],
  };
}

function state(overrides: Partial<SyncState> = {}): SyncState {
  return {
    sync_identity: `${clusterId}:${rankingDate}`,
    candidate_id: candidateId,
    story_cluster_id: clusterId,
    ranking_date: rankingDate,
    notion_page_id: "notion-page-1",
    last_synced_hash: "old-hash",
    last_synced_at: "2026-09-18T02:00:00.000Z",
    sync_status: "CURRENT",
    last_error_category: null,
    ...overrides,
  };
}

function repository(
  candidates: CandidateProjectionInput[],
  states: SyncState[] = [],
): NotionSyncRepository & { saved: SyncState[] } {
  const saved: SyncState[] = [];
  return {
    saved,
    async listCandidates() {
      return candidates;
    },
    async listStates() {
      return states;
    },
    async saveState(value) {
      saved.push(value);
    },
  };
}

function notion(overrides: Partial<NotionSyncClientLike> = {}): NotionSyncClientLike & {
  created: string[];
  updated: Array<{ id: string; properties: Record<string, unknown> }>;
} {
  const created: string[] = [];
  const updated: Array<{ id: string; properties: Record<string, unknown> }> = [];
  return {
    created,
    updated,
    async createPage() {
      created.push("created");
      return { id: "new-page-1" };
    },
    async updatePage(id, payload) {
      updated.push({ id, properties: payload.properties });
      return { id };
    },
    async retrievePage(id) {
      return { id };
    },
    ...overrides,
  };
}

Deno.test("syncs curated candidates and transitions stale projections without human fields", async () => {
  const lowRank = candidate({
    id: "low-rank",
    story_cluster_id: "55555555-5555-5555-5555-555555555555",
    rank: 11,
    must_cover_flag: true,
  });
  const dropped = candidate({
    id: "dropped",
    story_cluster_id: "66666666-6666-6666-6666-666666666666",
    rank: 12,
  });
  const expired = candidate({
    id: "expired",
    story_cluster_id: "33333333-3333-3333-3333-333333333333",
    ranking_date: "2026-09-17",
  });
  const repo = repository(
    [candidate(), lowRank, dropped, expired],
    [
      state(),
      state({ sync_identity: `${dropped.candidate.story_cluster_id}:${rankingDate}`, candidate_id: "dropped", notion_page_id: "dropped-page", sync_status: "CURRENT" }),
      state({ sync_identity: `${expired.candidate.story_cluster_id}:2026-09-17`, candidate_id: "expired", notion_page_id: "expired-page", ranking_date: "2026-09-17", sync_status: "CURRENT" }),
    ],
  );
  const api = notion();

  const result = await runNotionSync({
    repository: repo,
    notion: api,
    now: () => new Date("2026-09-18T04:00:00.000Z"),
  });

  assertEquals(result.created, 1);
  assertEquals(result.updated, 3);
  assertEquals(result.failed, 0);
  assertEquals(repo.saved.map((item) => [item.sync_identity, item.sync_status]), [
    [`${clusterId}:${rankingDate}`, "CURRENT"],
    [`${lowRank.candidate.story_cluster_id}:${rankingDate}`, "CURRENT"],
    [`${dropped.candidate.story_cluster_id}:${rankingDate}`, "DROPPED"],
    [`${expired.candidate.story_cluster_id}:2026-09-17`, "EXPIRED"],
  ]);
  assertFalse(JSON.stringify(api.updated).includes("Editorial Status"));
  assertEquals(api.updated.map((item) => item.properties["Sync Lifecycle"]), [
    { select: { name: "CURRENT" } },
    { select: { name: "DROPPED" } },
    { select: { name: "EXPIRED" } },
  ]);
});

Deno.test("skips a current page when the deterministic projection hash is unchanged", async () => {
  const projection = candidate();
  const repo = repository([projection], [state({ last_synced_hash: "placeholder" })]);
  const api = notion();
  const first = await runNotionSync({ repository: repo, notion: api, now: () => new Date("2026-09-18T04:00:00.000Z") });
  const savedHash = repo.saved[0]?.last_synced_hash;
  assert(savedHash);

  const secondRepo = repository([projection], [state({ last_synced_hash: savedHash })]);
  const secondApi = notion();
  const second = await runNotionSync({ repository: secondRepo, notion: secondApi, now: () => new Date("2026-09-18T04:00:00.000Z") });

  assertEquals(first.updated, 1);
  assertEquals(second.updated, 0);
  assertEquals(second.skipped, 1);
  assertEquals(secondApi.updated, []);
});

Deno.test("isolates a Notion failure to one candidate and records a safe category", async () => {
  const first = candidate();
  const second = candidate({ id: "second", story_cluster_id: "44444444-4444-4444-4444-444444444444", rank: 2 });
  const repo = repository([first, second]);
  const api = notion({
    async createPage(payload) {
      if (payload.properties["Candidate ID"] && JSON.stringify(payload).includes(candidateId)) {
        throw new Error("token=must-not-leak");
      }
      return { id: "second-page" };
    },
  });

  const result = await runNotionSync({ repository: repo, notion: api, now: () => new Date("2026-09-18T04:00:00.000Z") });

  assertEquals(result.created, 1);
  assertEquals(result.failed, 1);
  assertEquals(repo.saved.find((item) => item.candidate_id === candidateId)?.sync_status, "FAILED");
  assertEquals(repo.saved.find((item) => item.candidate_id === candidateId)?.last_error_category, "UNKNOWN");
  assertStringIncludes(JSON.stringify(repo.saved), "FAILED");
  assertFalse(JSON.stringify(repo.saved).includes("must-not-leak"));
});
