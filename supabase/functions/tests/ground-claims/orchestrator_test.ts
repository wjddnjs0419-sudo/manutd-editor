import assert from "node:assert/strict";
import { runClaimGrounding } from "../../ground-claims/orchestrator.ts";
import type { GroundingClaim, GroundingRepository } from "../../ground-claims/types.ts";

Deno.test("claim grounding persists one role-aware result per claim", async () => {
  const claims: GroundingClaim[] = [{ storyClusterId: "cluster-1", rawPostId: "post-1", claimFingerprint: "claim-1", subject: "United", predicate: "signed", object: "Player", claimText: "United signed Player", origin: "caption", extractionConfidence: 0.9 }];
  const saved: string[] = [];
  const repository: GroundingRepository = {
    listClaims: async () => ({ claims, hasMore: false, nextCursor: null }) as never,
    listObservations: async () => [{ id: "fact-1", editorialRole: "FACT_INDEPENDENT", canonicalName: "BBC Sport", title: "United signed Player", excerpt: "United signed Player", relation: "SUPPORTS" }],
    upsertClaim: async (claim) => { saved.push(`${claim.claimFingerprint}:${claim.status}`); return "stored-claim"; },
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async () => undefined,
  };
  const result = await runClaimGrounding({ repository, version: "m8-b-v1" });
  assert.deepEqual(result, { status: "COMPLETED", claimsProcessed: 1, verified: 1, discoveryOnly: 0, contradicted: 0, insufficient: 0, hasMore: false, nextCursor: null });
  assert.deepEqual(saved, ["claim-1:VERIFIED"]);
});

function claim(index: number): GroundingClaim {
  return { storyClusterId: "cluster-1", rawPostId: `post-${index}`, claimFingerprint: `claim-${index}`, subject: "United", predicate: "signed", object: "Player", claimText: "United signed Player", origin: "caption", extractionConfidence: 0.9 };
}

Deno.test("claim grounding honors the configured page limit and continuation status", async () => {
  const saved: string[] = [];
  const optionsSeen: unknown[] = [];
  const repository: GroundingRepository = {
    listClaims: async (options) => {
      optionsSeen.push(options);
      return { claims: Array.from({ length: 26 }, (_, index) => claim(index)), hasMore: true, nextCursor: "a:post-24:claim-24" } as never;
    },
    listObservations: async () => [],
    upsertClaim: async (value) => { saved.push(value.claimFingerprint); return value.claimFingerprint; },
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async () => undefined,
  };
  const result = await runClaimGrounding({ repository, limit: 25, storyClusterIds: ["cluster-1"] } as Parameters<typeof runClaimGrounding>[0]) as unknown as { claimsProcessed: number; status: string; hasMore: boolean; nextCursor: string | null };
  assert.equal((optionsSeen[0] as { limit: number }).limit, 25);
  assert.equal(saved.length, 25);
  assert.equal(result.claimsProcessed, 25);
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, "a:post-24:claim-24");
});

Deno.test("claim grounding completes a final page with null cursor", async () => {
  const repository: GroundingRepository = {
    listClaims: async () => ({ claims: [claim(1)], hasMore: false, nextCursor: null }) as never,
    listObservations: async () => [],
    upsertClaim: async () => "stored-1",
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async () => undefined,
  };
  const result = await runClaimGrounding({ repository, limit: 25 } as Parameters<typeof runClaimGrounding>[0]) as unknown as { status: string; hasMore: boolean; nextCursor: string | null };
  assert.deepEqual({ status: result.status, hasMore: result.hasMore, nextCursor: result.nextCursor }, { status: "COMPLETED", hasMore: false, nextCursor: null });
});

Deno.test("claim grounding logs ordered phases with timings and replaces evidence on reruns", async () => {
  const logs: Record<string, unknown>[] = [];
  const claims = new Map<string, string>();
  const evidence = new Set<string>();
  let claimWrites = 0;
  let evidenceWrites = 0;
  let evidenceBatchCalls = 0;
  const repository: GroundingRepository = {
    listClaims: async () => ({ claims: [claim(1)], hasMore: true, nextCursor: "a:post-1:claim-1" }) as never,
    listObservations: async () => [{ id: "observation-1", editorialRole: "FACT_PRIMARY", canonicalName: "Official", title: "United signed Player", excerpt: "United signed Player", relation: "SUPPORTS" }],
    upsertClaim: async (value, version) => { claimWrites++; const key = `${value.storyClusterId}:${value.claimFingerprint}:${version}`; claims.set(key, "stored-1"); return "stored-1"; },
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async (id, items) => { evidenceBatchCalls++; evidenceWrites += items.length; evidence.clear(); for (const item of items) evidence.add(`${id}:${item.sourceObservationId}:${item.relation}`); },
  };
  const options = { repository, limit: 1, cursor: null, storyClusterIds: ["cluster-1"], requestId: "request-1", log: (entry: Record<string, unknown>) => logs.push(entry) } as Parameters<typeof runClaimGrounding>[0];
  await runClaimGrounding(options);
  await runClaimGrounding(options);
  assert.equal(claimWrites, 2);
  assert.equal(evidenceWrites, 2);
  assert.equal(evidenceBatchCalls, 2);
  assert.equal(claims.size, 1);
  assert.equal(evidence.size, 1);
  const firstRun = logs.slice(0, 5);
  assert.deepEqual(firstRun.map((entry) => entry.event), ["ground_claims_start", "ground_claims_loaded", "ground_claims_match_complete", "ground_claims_write_complete", "ground_claims_complete"]);
  assert.equal(firstRun[0]?.as_of, null);
  assert.equal(firstRun[0]?.story_count, 1);
  assert.equal(firstRun[0]?.batch_limit, 1);
  assert.equal(firstRun[0]?.cursor_present, false);
  assert.equal(firstRun[1]?.claims_loaded, 1);
  assert.equal(firstRun[1]?.observations_loaded, 1);
  assert.equal(firstRun[2]?.claims_processed, 1);
  assert.equal(firstRun[2]?.evidence_matches, 1);
  assert.equal(firstRun[2]?.verified, 1);
  assert.equal(firstRun[2]?.discovery_only, 0);
  assert.equal(firstRun[2]?.contradicted, 0);
  assert.equal(firstRun[2]?.insufficient, 0);
  assert.equal(firstRun[3]?.claim_writes, 1);
  assert.equal(firstRun[3]?.evidence_writes, 1);
  for (const [event, timing] of [["ground_claims_loaded", "load_ms"], ["ground_claims_match_complete", "match_ms"], ["ground_claims_write_complete", "write_ms"], ["ground_claims_complete", "total_ms"]] as const) {
    const value = firstRun.find((entry) => entry.event === event)?.[timing];
    assert.equal(typeof value, "number", `${event}.${timing}`);
    assert.ok((value as number) >= 0);
  }
  assert.equal(firstRun[0]?.request_id, "request-1");
  assert.equal(JSON.stringify(logs).includes("United signed Player"), false);
});

Deno.test("claim grounding failure logs identify the phase without exposing error details", async () => {
  const logs: Record<string, unknown>[] = [];
  const repository: GroundingRepository = {
    listClaims: async () => { throw new Error("database secret"); },
    listObservations: async () => [],
    upsertClaim: async () => "unused",
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async () => undefined,
  };
  await assert.rejects(() => runClaimGrounding({ repository, requestId: "request-1", log: (entry) => logs.push(entry) }));
  const failure = logs.at(-1);
  assert.equal(failure?.event, "ground_claims_failed");
  assert.equal(typeof failure?.phase, "string");
  assert.equal(typeof failure?.error_code, "string");
  assert.equal(typeof failure?.elapsed_ms, "number");
  assert.equal(JSON.stringify(logs).includes("database secret"), false);
});

Deno.test("large mixed fixture grounds only affected stories within one bounded page", async () => {
  const allClaims = Array.from({ length: 350 }, (_, index): GroundingClaim => ({
    ...claim(index),
    storyClusterId: index % 3 === 0 ? "story-1" : index % 3 === 1 ? "story-2" : "unrelated-story",
  }));
  const saved: GroundingClaim[] = [];
  const repository: GroundingRepository = {
    listClaims: async (options) => {
      const scope = options && !(options instanceof Date) ? options.storyClusterIds : undefined;
      const scoped = allClaims.filter((item) => !scope || scope.includes(item.storyClusterId));
      const limit = options && !(options instanceof Date) && options.limit ? options.limit : 25;
      return { claims: scoped.slice(0, limit + 1), hasMore: scoped.length > limit, nextCursor: scoped.length > limit ? "a:post-24:claim-24" : null };
    },
    listObservations: async () => Array.from({ length: 120 }, (_, index) => ({ id: `observation-${index}`, editorialRole: "MATCH_CONTEXT", canonicalName: "context", title: "context", excerpt: null, relation: "SUPPORTS" as const })),
    upsertClaim: async (value) => { saved.push(value); return `stored-${saved.length}`; },
    upsertEvidence: async () => undefined,
    replaceEvidenceBatch: async () => undefined,
  };
  const result = await runClaimGrounding({ repository, storyClusterIds: ["story-1", "story-2"], limit: 25 });
  assert.equal(result.status, "PARTIAL");
  assert.equal(result.claimsProcessed, 25);
  assert.equal(result.hasMore, true);
  assert.ok(result.nextCursor);
  assert.equal(saved.length, 25);
  assert(saved.every((item) => item.storyClusterId === "story-1" || item.storyClusterId === "story-2"));
  assert.equal(saved.some((item) => item.storyClusterId === "unrelated-story"), false);
});
