import { assertEquals } from "jsr:@std/assert@1";
import { retrieveHistoricalContext, shouldRetrieveHistory } from "../../_shared/m6/retrieval.ts";

Deno.test("history retrieval requires explicit history language", () => {
  assertEquals(shouldRetrieveHistory("지난 경기에서 뭐가 중요했어?"), true);
  assertEquals(shouldRetrieveHistory("last match summary"), true);
  assertEquals(shouldRetrieveHistory("왜 이게 88점이야?"), false);
  assertEquals(shouldRetrieveHistory("이 근거가 뭐야?"), false);
  assertEquals(shouldRetrieveHistory("오늘 경기 관련 뭐가 중요해?"), false);
});

Deno.test("retrieval uses structured last-match context before bounded text search", async () => {
  const calls: string[] = [];
  const result = await retrieveHistoricalContext("지난 경기에서 언급된 수비", { active_candidate_id: null, active_brief_id: null, active_match_id: null }, {
    findLastFinishedMatch: async () => { calls.push("match"); return { id: "match-1", status: "FINISHED", opponent: "Liverpool" }; },
    findByMatch: async (match) => { calls.push(`match:${match.id}`); return [{ kind: "brief", id: "brief-1", text: "match context" }]; },
    searchText: async () => { calls.push("text"); return [{ kind: "message", id: "message-1", text: "ignored due to cap" }]; },
  });
  assertEquals(calls, ["match", "match:match-1"]);
  assertEquals(result, [{ kind: "brief", id: "brief-1", text: "match context" }]);
});
