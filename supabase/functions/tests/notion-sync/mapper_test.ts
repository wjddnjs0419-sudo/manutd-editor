import { assert, assertEquals, assertFalse, assertNotEquals } from "jsr:@std/assert@1.0.8";
import {
  buildNotionPagePayload,
  canonicalJson,
  hashNotionPayload,
  type CandidateProjectionInput,
} from "../../notion-sync/mapper.ts";

function fixture(): CandidateProjectionInput {
  return {
    candidate: {
      id: "11111111-1111-1111-1111-111111111111",
      story_cluster_id: "22222222-2222-2222-2222-222222222222",
      ranking_date: "2026-09-18",
      rank: 1,
      priority_score: 76.25,
      data_confidence: 92.5,
      first_mover_flag: true,
      must_cover_flag: false,
      korea_coverage_status: "KNOWN",
      global_spread_score: 10,
      engagement_outperformance_score: 12,
      engagement_velocity_score: 8,
      velocity_acceleration_score: 4,
      korea_gap_score: 15,
      first_mover_score: 10,
      korean_saturation_score: 0,
      reliability_score: 9,
      source_diversity_score: 3,
      freshness_score: 5,
      score_inputs: {
        global_coverage: 0.8,
        korean_coverage: 0,
        global_outperformance_ratio: 2.3,
        global_velocity_ratio: 1.9,
        deterministic_reason: "known coverage and source evidence",
      },
      calculated_at: "2026-09-18T03:00:00.000Z",
    },
    cluster: {
      id: "22222222-2222-2222-2222-222222222222",
      canonical_title: "Bruno Fernandes injury update",
      status: "ACTIVE",
      first_seen_at: "2026-09-18T01:30:00.000Z",
      last_seen_at: "2026-09-18T03:00:00.000Z",
    },
    references: [
      {
        username: "utdreport",
        region: "GLOBAL",
        permalink: "https://www.instagram.com/p/example/",
        published_at: "2026-09-18T01:30:00.000Z",
        source_name: "Fabrizio Romano",
      },
    ],
  };
}

Deno.test("maps system-owned candidate data and excludes human-owned properties", async () => {
  const payload = buildNotionPagePayload(fixture());
  const propertyNames = Object.keys(payload.properties);

  assert(propertyNames.includes("Sync Identity"));
  assert(propertyNames.includes("Priority Score"));
  assert(propertyNames.includes("Sync Lifecycle"));
  assertFalse(propertyNames.includes("Editorial Status"));
  assertFalse(propertyNames.includes("Selected"));
  assertFalse(propertyNames.includes("Editor Headline"));
  assertFalse(propertyNames.includes("Editor Notes"));
  assertEquals(payload.properties["Sync Identity"], {
    rich_text: [{ type: "text", text: { content: "22222222-2222-2222-2222-222222222222:2026-09-18" } }],
  });
  assertEquals(payload.properties["Sync Lifecycle"], { select: { name: "CURRENT" } });
  assertEquals(payload.properties["Rank"], { number: 1 });
  assert(payload.children.length >= 3);
});

Deno.test("canonical JSON sorts object keys but preserves array order", () => {
  assertEquals(
    canonicalJson({ b: 2, a: [{ z: 1, y: 2 }] }),
    canonicalJson({ a: [{ y: 2, z: 1 }], b: 2 }),
  );
  assertNotEquals(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});

Deno.test("same semantic payload has a stable SHA-256 hash", async () => {
  const first = buildNotionPagePayload(fixture());
  const reordered = fixture();
  reordered.candidate.score_inputs = {
    deterministic_reason: "known coverage and source evidence",
    global_velocity_ratio: 1.9,
    korean_coverage: 0,
    global_coverage: 0.8,
    global_outperformance_ratio: 2.3,
  };
  const second = buildNotionPagePayload(reordered);
  assertEquals(await hashNotionPayload(first), await hashNotionPayload(second));
});

Deno.test("system-owned value changes produce a different hash", async () => {
  const first = await hashNotionPayload(buildNotionPagePayload(fixture()));
  const changed = fixture();
  changed.candidate.priority_score = 77;
  const second = await hashNotionPayload(buildNotionPagePayload(changed));
  assertNotEquals(first, second);
});
