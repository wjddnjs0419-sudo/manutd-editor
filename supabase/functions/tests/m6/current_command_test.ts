import { assert, assertEquals } from "jsr:@std/assert@1";
import { formatCurrentReply } from "../../telegram-agent/current.ts";

Deno.test("current command reports live candidate state and positions", () => {
  const result = formatCurrentReply({
    briefingDate: "2026-09-21",
    readiness: "READY_WITH_CANDIDATES",
    candidateCount: 17,
    items: [
      { position: 1, candidateId: "candidate-1", priorityScore: 20, username: "utdreport" },
      { position: 2, candidateId: "candidate-2", priorityScore: 18, username: "utddistrict" },
    ],
  });

  assert(result.includes("2026-09-21"));
  assert(result.includes("현재 후보 17건"));
  assert(result.includes("/open 1"));
  assert(result.includes("@utdreport"));
});

Deno.test("current command reports readiness blockers without pretending candidates exist", () => {
  assertEquals(formatCurrentReply({ briefingDate: "2026-09-21", readiness: "NOT_READY", candidateCount: 0, items: [] }), "2026-09-21 현재 Intelligence가 아직 준비되지 않았습니다.");
  assertEquals(formatCurrentReply({ briefingDate: "2026-09-21", readiness: "DEGRADED", candidateCount: 0, items: [] }), "2026-09-21 현재 Intelligence 상태와 후보 수가 일치하지 않습니다.");
});
