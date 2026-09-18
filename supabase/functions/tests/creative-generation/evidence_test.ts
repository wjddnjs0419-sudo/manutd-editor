import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.8";
import { buildEvidenceSnapshot } from "../../creative-generation/evidence.ts";
import type { CandidateEvidenceInput } from "../../creative-generation/types.ts";

function input(overrides: Partial<CandidateEvidenceInput> = {}): CandidateEvidenceInput {
  return {
    candidate: {
      id: "candidate-1",
      story_cluster_id: "cluster-1",
      ranking_date: "2026-09-18",
      rank: 1,
      priority_score: 80,
      data_confidence: 92,
      first_mover_flag: true,
      must_cover_flag: false,
      korea_coverage_status: "KNOWN",
      score_version: "v1",
      score_inputs: { global_coverage: 0.8, korean_coverage: 0.1 },
    },
    story: {
      id: "cluster-1",
      canonical_title: "United confirm a late winner",
      status: "ACTIVE",
      first_seen_at: "2026-09-18T08:00:00Z",
      last_seen_at: "2026-09-18T09:00:00Z",
    },
    posts: [
      {
        raw_post_id: "post-2",
        source_account_id: "account-2",
        account_username: "utddistrict",
        region: "GLOBAL",
        caption: "United win late.",
        permalink: "https://instagram.test/post-2",
        published_at: "2026-09-18T09:00:00Z",
        media_type: "IMAGE",
      },
      {
        raw_post_id: "post-1",
        source_account_id: "account-1",
        account_username: "utdreport",
        region: "GLOBAL",
        caption: "Full time: United 2-1 Arsenal",
        permalink: "https://instagram.test/post-1",
        published_at: "2026-09-18T08:30:00Z",
        media_type: "IMAGE",
      },
    ],
    sources: [
      {
        source_id: "source-1",
        canonical_name: "Manchester United",
        entity_type: "CLUB",
        reliability_score: 10,
        evidence_text: "Official club source",
        first_cited_post_id: "post-1",
        citation_count: 1,
      },
    ],
    ...overrides,
  };
}

Deno.test("builds stable evidence IDs and ordering", () => {
  const snapshot = buildEvidenceSnapshot(input());
  assertEquals(snapshot.posts.map((post) => post.evidence_id), ["post:post-1", "post:post-2"]);
  assertEquals(snapshot.sources[0]?.evidence_id, "source:source-1");
  assertEquals(snapshot.evidence_ids, [
    "post:post-1",
    "post:post-2",
    "score:global_coverage",
    "score:korean_coverage",
    "source:source-1",
  ]);
});

Deno.test("excludes unsupported evidence without IDs", () => {
  const snapshot = buildEvidenceSnapshot(input({
    posts: [{ ...input().posts[0], raw_post_id: "" }],
    sources: [{ ...input().sources[0], source_id: "" }],
  }));
  assertEquals(snapshot.posts.length, 0);
  assertEquals(snapshot.sources.length, 0);
  assertEquals(snapshot.evidence_ids, ["score:global_coverage", "score:korean_coverage"]);
});

Deno.test("does not include media binaries in a snapshot", () => {
  const snapshot = buildEvidenceSnapshot(input());
  assertEquals("media_url" in snapshot, false);
  assertEquals("raw_payload" in snapshot.posts[0]!, false);
});

