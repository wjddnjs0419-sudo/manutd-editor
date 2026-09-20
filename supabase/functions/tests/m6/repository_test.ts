import { assertEquals } from "jsr:@std/assert@1.0.8";
import { createM6Repository } from "../../_shared/m6/repository.ts";

Deno.test("M6 repository marks JSON writes with the JSON content type", async () => {
  let capturedHeaders: Headers | undefined;
  const repository = createM6Repository({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role-key",
    fetch: async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(null, { status: 204 });
    },
  });

  await repository.saveFixtureSyncState({
    provider: "espn",
    last_full_sync_at: null,
    last_attempt_at: "2026-09-20T00:00:00.000Z",
    last_success_at: null,
    last_error_category: null,
  });

  assertEquals(capturedHeaders?.get("content-type"), "application/json");
});
