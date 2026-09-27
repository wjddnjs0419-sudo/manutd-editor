import { assertEquals } from "jsr:@std/assert@1.0.8";
import { displayStoryTitle } from "../../_shared/m8/story_display.ts";

Deno.test("formats internal entity tokens into a compact editorial title", () => {
  assertEquals(
    displayStoryTitle("sir_alex_ferguson pep_guardiola manchester_united manchester_city premier_league the_guardian talksport"),
    "퍼거슨 · 과르디올라 · 맨유 · 맨시티 · PL · 가디언 · 토크스포츠 관련 소재",
  );
});

Deno.test("preserves already readable story titles", () => {
  assertEquals(displayStoryTitle("산초, 3개월째 FA"), "산초, 3개월째 FA");
});
