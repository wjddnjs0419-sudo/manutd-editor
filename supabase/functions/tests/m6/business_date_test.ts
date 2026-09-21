import { assertEquals } from "jsr:@std/assert@1";
import { businessDate } from "../../_shared/m6/business_date.ts";

Deno.test("businessDate uses the configured local timezone at UTC boundaries", () => {
  assertEquals(businessDate("2026-09-20T14:59:59Z", "Asia/Seoul"), "2026-09-20");
  assertEquals(businessDate("2026-09-20T15:00:00Z", "Asia/Seoul"), "2026-09-21");
  assertEquals(businessDate("2026-09-20T23:30:00Z", "Asia/Seoul"), "2026-09-21");
  assertEquals(businessDate("2026-09-20T23:59:59Z", "Asia/Seoul"), "2026-09-21");
});
