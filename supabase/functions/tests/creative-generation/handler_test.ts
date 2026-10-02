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
});

Deno.test("rejects invalid bodies and unauthorized callers", async () => {
  const handler = createCreativeGenerationHandler({ collectorSecret: "secret", run: async () => ({ status: "READY", candidate_id: "candidate-1" }) });
  assertEquals((await handler(request("POST", {}))).status, 400);
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "AUTO_PRIORITY" }, "wrong"))).status, 401);
  assertEquals((await handler(request("GET", undefined))).status, 405);
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", trust_state: "DISCOVERY", slide_count: 6 }))).status, 400);
});

Deno.test("accepts only bounded explicit editorial trust and slide-count options", async () => {
  let trigger: unknown;
  const handler = createCreativeGenerationHandler({ collectorSecret: "secret", run: async (value) => { trigger = value; return { status: "READY", candidate_id: value.candidate_id }; } });
  assertEquals((await handler(request("POST", { candidate_id: "candidate-1", trigger_type: "MANUAL", trust_state: "REPORTED", slide_count: 3 }))).status, 200);
  assertEquals(trigger, { candidate_id: "candidate-1", trigger_type: "MANUAL", trust_state: "REPORTED", slide_count: 3 });
});
