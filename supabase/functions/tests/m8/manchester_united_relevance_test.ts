import { assert, assertFalse, assertEquals } from "jsr:@std/assert@1.0.8";
import {
  classifyManchesterUnitedRelevance,
  isManchesterUnitedFocusedSource,
  isManchesterUnitedRelevant,
} from "../../_shared/m8/manchester_united_relevance.ts";

Deno.test("classifies United centered story", () => {
  assertEquals(classifyManchesterUnitedRelevance({ title: "Manchester United confirm Bruno Fernandes injury", body: "The club confirmed its captain will miss the next match.", entities: ["Manchester United", "Bruno Fernandes"], topic: "INJURY" }).classification, "UNITED_PRIMARY");
});

Deno.test("classifies opponent article with United fixture context", () => {
  const result = classifyManchesterUnitedRelevance({ title: "Everton prepare for Manchester United clash", body: "The sides meet at Old Trafford on Saturday.", entities: ["Everton", "Manchester United"], topic: "MATCH_PREVIEW" });
  assertEquals(result.classification, "OPPONENT_MATCH_CONTEXT");
  assertEquals(result.autoEligible, true);
});

Deno.test("rejects fleeting United mention", () => {
  const result = classifyManchesterUnitedRelevance({ title: "Chelsea confirm midfielder signing", body: "Chelsea say the player joins this week. Manchester United were mentioned in a comparison last season.", entities: ["Chelsea", "Manchester United"], topic: "TRANSFER" });
  assertEquals(result.classification, "INCIDENTAL_MENTION");
  assertEquals(result.autoEligible, false);
});

Deno.test("rejects another sport despite a United keyword", () => {
  const result = classifyManchesterUnitedRelevance({ title: "Jaguars sign a new running back", body: "The NFL side made the move today. A player briefly mentioned Manchester United in an interview.", entities: ["Jacksonville Jaguars"], topic: "NFL" });
  assertEquals(result.classification, "OTHER_SPORT");
  assertEquals(result.autoEligible, false);
});

Deno.test("rejects multi club transfer rumor roundup", () => {
  const result = classifyManchesterUnitedRelevance({ title: "Sancho transfer rumors: United, Chelsea, Arsenal and Spurs linked", body: "The roundup lists several clubs as possible destinations without a confirmed bid.", entities: ["Jadon Sancho", "Manchester United", "Chelsea", "Arsenal", "Tottenham"], topic: "TRANSFER_RUMOR_ROUNDUP" });
  assertEquals(result.classification, "TRANSFER_ROUNDUP");
  assertEquals(result.autoEligible, false);
});

Deno.test("rejects real transfer news list headlines when United is one club in the roundup", () => {
  const standard = classifyManchesterUnitedRelevance({
    title: "Transfer news LIVE: Arsenal triple deal close, Haaland twist; Man Utd windfall; Chelsea, Liverpool latest",
    body: "Arsenal, Chelsea, Manchester United, Liverpool and Tottenham are all back on the hunt for statement new signings.",
    entities: ["Arsenal", "Manchester United", "Chelsea", "Liverpool", "Tottenham"],
    topic: "TRANSFER",
  });
  const espn = classifyManchesterUnitedRelevance({
    title: "Transfer rumors, news: Man City, Man Utd, Spurs eye Atlético's Simeone",
    body: "Manchester City, Manchester United and Tottenham are all looking at bringing Atlético Madrid's manager.",
    entities: ["Manchester City", "Manchester United", "Tottenham", "Atlético Madrid"],
    topic: "TRANSFER_RUMOR_ROUNDUP",
  });
  assertEquals(standard.classification, "TRANSFER_ROUNDUP");
  assertEquals(standard.autoEligible, false);
  assertEquals(espn.classification, "TRANSFER_ROUNDUP");
  assertEquals(espn.autoEligible, false);
});

Deno.test("title body entity topic disagreement cannot auto qualify", () => {
  const result = classifyManchesterUnitedRelevance({ title: "Jacksonville Jaguars injury update", body: "Manchester United appear once in a comparison.", entities: ["Manchester United"], topic: "NFL" });
  assertEquals(result.autoEligible, false);
});

Deno.test("focused source usernames are normalized but cannot override contradiction", () => {
  assertEquals(classifyManchesterUnitedRelevance({ title: "Jaguars injury report", topic: "NFL", sourceUsernames: ["@UtdReport"] }).autoEligible, false);
});

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
