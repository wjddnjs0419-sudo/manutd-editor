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

Deno.test("keeps common English and Korean club aliases in the deterministic relevance path", () => {
  for (const alias of ["Manchester United", "Man Utd", "Man United", "MUFC", "맨유"]) {
    assert(isManchesterUnitedRelevant({ canonicalTitle: `${alias} injury update` }), alias);
  }
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

Deno.test("rejects broad-source listicles where United is only a secondary mention", () => {
  assertFalse(isManchesterUnitedRelevant({
    canonicalTitle: "토트넘 초비상 토트넘 최하위 추락, 다음 상대 맨유",
    sourceUsernames: ["footballoop.mag"],
  }));
  assertFalse(isManchesterUnitedRelevant({
    canonicalTitle: "슈퍼컴퓨터 PL 우승 확률, 아스날 맨시티 리버풀 뒤 맨유 0.9%",
    sourceUsernames: ["footballoop.mag"],
  }));
  assertFalse(isManchesterUnitedRelevant({
    canonicalTitle: "빅클럽 클럽 레코드 바르셀로나 PSG 맨유 유벤투스 리버풀",
    sourceUsernames: ["footballoop.mag"],
  }));
});

Deno.test("keeps a broad-source United-led story when United is the opening subject", () => {
  assert(isManchesterUnitedRelevant({
    canonicalTitle: "맨유 풀럼 못 이긴 이유, 원정에서 승점 1점",
    sourceUsernames: ["footballoop.mag"],
  }));
});
