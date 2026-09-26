import { assertEquals } from "jsr:@std/assert@1.0.8";
import { materializeEditorialJobDeadAlerts } from "../../telegram-alerts/dead_alerts.ts";

Deno.test("materializes dead-alert outbox through the service-role RPC", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const count = await materializeEditorialJobDeadAlerts({
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-role-secret",
    threadId: "thread-1",
    request: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response("1", { status: 200 });
    },
  });

  assertEquals(count, 1);
  assertEquals(calls[0]?.url, "https://supabase.test/rest/v1/rpc/materialize_editorial_job_dead_alerts");
  assertEquals(JSON.parse(String(calls[0]?.init.body)), { p_thread_id: "thread-1" });
});

Deno.test("does not call the RPC until an owner thread is configured", async () => {
  let calls = 0;
  const count = await materializeEditorialJobDeadAlerts({
    supabaseUrl: "https://supabase.test",
    serviceKey: "service-role-secret",
    threadId: "",
    request: async () => { calls += 1; return new Response("1"); },
  });

  assertEquals(count, 0);
  assertEquals(calls, 0);
});
