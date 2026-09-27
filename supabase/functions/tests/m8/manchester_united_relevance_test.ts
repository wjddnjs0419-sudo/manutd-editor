import { assert, assertFalse, assertEquals } from "jsr:@std/assert@1.0.8";
import {
  isManchesterUnitedFocusedSource,
  isManchesterUnitedRelevant,
} from "../../_shared/m8/manchester_united_relevance.ts";

Deno.test("accepts explicit Manchester United signals", () => {
  assert(isManchesterUnitedRelevant({ canonicalTitle: "맨유 떠난 가르나초의 현재" }));
  assert(isManchesterUnitedRelevant({ signature: { entities: ["manchester_united"] } }));
  assert(isManchesterUnitedRelevant({ canonicalTitle: "산초, 3개월째 FA" }));
});

Deno.test("accepts a story from a focused United source", () => {
  assert(isManchesterUnitedFocusedSource("utdreport"));
  assert(isManchesterUnitedRelevant({ canonicalTitle: "새로운 훈련 소식", sourceUsernames: ["utdreport"] }));
});

Deno.test("rejects unrelated football and Manchester City-only stories", () => {
  assertFalse(isManchesterUnitedRelevant({ canonicalTitle: "손흥민 대표팀 부상 소식" }));
  assertFalse(isManchesterUnitedRelevant({ canonicalTitle: "맨시티 재정 규정 위반 혐의" }));
  assertFalse(isManchesterUnitedRelevant({ signature: { entities: ["italy_national_football_team"] } }));
  assertEquals(isManchesterUnitedFocusedSource("todayfootball"), false);
});
