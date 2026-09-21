import { assertEquals } from "jsr:@std/assert@1";
import { classifyReadiness, type IntelligenceReadinessRecord } from "../../_shared/m6/readiness.ts";

const ready = (status: IntelligenceReadinessRecord["status"], candidate_count: number, ranking_date = "2026-09-21"): IntelligenceReadinessRecord => ({
  ranking_date,
  status,
  candidate_count,
  started_at: "2026-09-21T00:00:00Z",
  completed_at: status === "SUCCEEDED" ? "2026-09-21T00:30:00Z" : null,
  error_category: status === "FAILED" ? "DATABASE_HTTP_ERROR" : null,
});

Deno.test("readiness distinguishes incomplete, failed, empty, and populated intelligence", () => {
  assertEquals(classifyReadiness(null, "2026-09-21", 0), "NOT_READY");
  assertEquals(classifyReadiness(ready("RUNNING", 0), "2026-09-21", 0), "NOT_READY");
  assertEquals(classifyReadiness(ready("FAILED", 0), "2026-09-21", 0), "DEGRADED");
  assertEquals(classifyReadiness(ready("SUCCEEDED", 0), "2026-09-21", 0), "READY_EMPTY");
  assertEquals(classifyReadiness(ready("SUCCEEDED", 2), "2026-09-21", 2), "READY_WITH_CANDIDATES");
});

Deno.test("readiness rejects a ranking-date or candidate-count mismatch", () => {
  assertEquals(classifyReadiness(ready("SUCCEEDED", 2, "2026-09-20"), "2026-09-21", 2), "NOT_READY");
  assertEquals(classifyReadiness(ready("SUCCEEDED", 2), "2026-09-21", 0), "DEGRADED");
});
