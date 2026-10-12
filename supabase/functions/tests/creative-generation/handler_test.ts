import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createCreativeGenerationHandler } from "../../creative-generation/handler.ts";

function request(method: string, body?: unknown, secret = "secret") {
  return new Request("http://localhost/functions/v1/creative-generation", {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

Deno.test("requires invoke secret and accepts one generation trigger", async () => {
  const calls: unknown[] = [];
  const handler = createCreativeGenerationHandler({
    collectorSecret: "secret",
    run: async (trigger) => { calls.push(trigger); return { status: "READY", candidate_id: "candidate-1", revision: 1 }; },
    requestId: () => "request-1",
  });
  const response = await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }));
  assertEquals(response.status, 200);
  assertEquals((await response.json()).status, "READY");
  assertEquals(calls.length, 1);
  assertEquals(calls[0], { candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" });
});

Deno.test("accepts only the explicit Exploration intent and keeps the trigger contract", async () => {
  const calls: unknown[] = [];
  const handler = createCreativeGenerationHandler({ collectorSecret: "secret", run: async (trigger) => { calls.push(trigger); return { status: "DRAFT", candidate_id: trigger.candidate_id }; } });
  const response = await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" }));
  assertEquals(response.status, 200);
  assertEquals(calls[0], { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION" });
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "BYPASS" }))).status, 400);

  const override = await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION", content_mode_override: "ANALYSIS_CONTEXT" }));
  assertEquals(override.status, 200);
  assertEquals(calls[1], { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION", content_mode_override: "ANALYSIS_CONTEXT" });
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY", generation_intent: "EXPLORATION", content_mode_override: "ANALYSIS_CONTEXT" }))).status, 400);
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", generation_intent: "EXPLORATION", content_mode_override: "NEWS_UPDATE" }))).status, 400);
});

Deno.test("rejects invalid bodies and unauthorized callers", async () => {
  const handler = createCreativeGenerationHandler({ collectorSecret: "secret", run: async () => ({ status: "READY", candidate_id: "candidate-1" }) });
  assertEquals((await handler(request("POST", {}))).status, 400);
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, "wrong"))).status, 401);
  assertEquals((await handler(request("GET", undefined))).status, 405);
});
