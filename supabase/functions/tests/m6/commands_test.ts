import { assertEquals } from "jsr:@std/assert@1";
import { parseCommand, validatePendingAction } from "../../_shared/m6/commands.ts";

Deno.test("slash command parser accepts only explicit supported grammar", () => {
  assertEquals(parseCommand("/hook 3"), { type: "HOOK", hook: 3 });
  assertEquals(parseCommand("/slide 3 더 짧고 직관적으로"), { type: "SLIDE", slide: 3, instruction: "더 짧고 직관적으로" });
  assertEquals(parseCommand("/caption 덜 자극적으로"), { type: "CAPTION", instruction: "덜 자극적으로" });
  assertEquals(parseCommand("훅 3번으로"), null);
  assertEquals(parseCommand("/slide 8 too far"), null);
  assertEquals(parseCommand("/open 2"), { type: "OPEN", target: "2" });
});

Deno.test("protected confirmation revalidates expiry, brief revision, and pipeline state", () => {
  const pending = { command_event_id: "event", command_type: "SLIDE", base_brief_id: "brief-4", base_revision: 4, args: { slide: 3 }, requested_at: "2026-09-19T00:00:00Z", expires_at: "2026-09-19T00:10:00Z" };
  assertEquals(validatePendingAction(pending, { latest_brief_id: "brief-4", latest_revision: 4, production_status: "LOCKED" }, new Date("2026-09-19T00:05:00Z")), "CONFIRMABLE");
  assertEquals(validatePendingAction(pending, { latest_brief_id: "brief-5", latest_revision: 5, production_status: "LOCKED" }, new Date("2026-09-19T00:05:00Z")), "STALE_PENDING_ACTION");
  assertEquals(validatePendingAction(pending, { latest_brief_id: "brief-4", latest_revision: 4, production_status: "LOCKED" }, new Date("2026-09-19T00:11:00Z")), "PENDING_ACTION_EXPIRED");
});
