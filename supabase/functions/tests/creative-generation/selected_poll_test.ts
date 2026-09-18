import { assertEquals } from "jsr:@std/assert@1.0.8";
import { pollSelectedDailyIntelligence } from "../../creative-generation/selected_poll.ts";

Deno.test("polls only Selected Daily Intelligence pages and reuses the generation core", async () => {
  const calls: unknown[] = [];
  const result = await pollSelectedDailyIntelligence({
    queryDatabase: async () => [
      { id: "page-1", properties: { Selected: { checkbox: true }, "Candidate ID": { rich_text: [{ plain_text: "candidate-1" }] } } },
      { id: "page-2", properties: { Selected: { checkbox: false }, "Candidate ID": { rich_text: [{ plain_text: "candidate-2" }] } } },
      { id: "page-3", properties: { Selected: { checkbox: true }, "Candidate ID": { rich_text: [] } } },
    ],
  }, async (trigger) => { calls.push(trigger); return { status: "READY", candidate_id: trigger.candidate_id }; });
  assertEquals(result.selected, 1);
  assertEquals(result.triggered, 1);
  assertEquals(calls, [{ candidate_id: "candidate-1", trigger_type: "NOTION_SELECTED" }]);
});
