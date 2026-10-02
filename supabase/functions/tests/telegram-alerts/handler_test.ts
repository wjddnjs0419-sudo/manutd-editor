import assert from "node:assert/strict";
import { createTelegramAlertsHandler } from "../../telegram-alerts/handler.ts";

function request(body?: unknown): Request {
  return new Request("https://example.test/functions/v1/telegram-alerts", {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

Deno.test("accepts a bounded hourly digest window and rejects malformed windows", async () => {
  let input: unknown;
  const handler = createTelegramAlertsHandler({ invokeSecret: "secret", run: async (value) => { input = value; return { attempted: 0, sent: 0, failed: 0 }; } });
  const valid = { mode: "HOURLY_DIGEST", window_start: "2026-10-02T04:00:00Z", window_end: "2026-10-02T05:00:00Z" };
  assert.equal((await handler(request(valid))).status, 200);
  assert.deepEqual(input, valid);
  assert.equal((await handler(request({ ...valid, window_end: "2026-10-02T03:00:00Z" }))).status, 400);
  assert.equal((await handler(request({ ...valid, mode: "ARBITRARY" }))).status, 400);
});
