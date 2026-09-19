import { assertEquals } from "jsr:@std/assert@1";
import { applyCandidateAlertTransition, type CandidateAlertState } from "../../_shared/m6/alerts.ts";

Deno.test("candidate alert transitions only emit on false to true", () => {
  let state: CandidateAlertState = { first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 0 };
  let result = applyCandidateAlertTransition(state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events, [{ type: "FIRST_MOVER", transition: 1, fingerprint: "FIRST_MOVER:candidate-1:1" }]);
  state = result.state;
  result = applyCandidateAlertTransition(state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events, []);
  state = result.state;
  result = applyCandidateAlertTransition(state, { first_mover_flag: false, must_cover_flag: false });
  assertEquals(result.events, []);
  result = applyCandidateAlertTransition(result.state, { first_mover_flag: true, must_cover_flag: false });
  assertEquals(result.events[0]?.fingerprint, "FIRST_MOVER:candidate-1:2");
});

Deno.test("MUST_COVER transition has independent counter", () => {
  const result = applyCandidateAlertTransition(
    { first_mover_flag: false, must_cover_flag: false, first_mover_transition: 0, must_cover_transition: 3 },
    { first_mover_flag: false, must_cover_flag: true },
    "candidate-2",
  );
  assertEquals(result.events[0]?.fingerprint, "MUST_COVER:candidate-2:4");
});
