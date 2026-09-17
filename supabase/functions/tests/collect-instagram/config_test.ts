import assert from "node:assert/strict";

import {
  integerEnv,
  resolveSupabaseSecretKey,
} from "../../collect-instagram/config.ts";

Deno.test("selects the default key from the hosted SUPABASE_SECRET_KEYS dictionary", () => {
  const key = resolveSupabaseSecretKey((name) =>
    name === "SUPABASE_SECRET_KEYS"
      ? JSON.stringify({ default: "sb_secret_hosted" })
      : undefined
  );

  assert.equal(key, "sb_secret_hosted");
});

Deno.test("reads bounded integer configuration and uses its default", () => {
  assert.equal(
    integerEnv(() => "2", "COLLECTOR_CONCURRENCY", 1, 3, 2),
    2,
  );
  assert.equal(
    integerEnv(
      () => undefined,
      "COLLECTOR_ACCOUNT_BUDGET_MS",
      1,
      120_000,
      20_000,
    ),
    20_000,
  );
});

Deno.test("rejects invalid integer configuration without echoing values", () => {
  for (const invalid of ["0", "-1", "1.5", "no-secret-42", "4"]) {
    assert.throws(
      () => integerEnv(() => invalid, "COLLECTOR_CONCURRENCY", 1, 3, 2),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /COLLECTOR_CONCURRENCY/);
        assert.doesNotMatch(
          error.message,
          new RegExp(invalid.replace("-", "\\-")),
        );
        return true;
      },
    );
  }
});

Deno.test("supports a singular secret key for local and CI environments", () => {
  const key = resolveSupabaseSecretKey((name) =>
    name === "SUPABASE_SECRET_KEY" ? "sb_secret_local" : undefined
  );

  assert.equal(key, "sb_secret_local");
});

Deno.test("rejects malformed secret key configuration without echoing it", () => {
  const malformed = "not-json-sensitive-value";

  assert.throws(
    () =>
      resolveSupabaseSecretKey((name) =>
        name === "SUPABASE_SECRET_KEYS" ? malformed : undefined
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /SUPABASE_SECRET_KEYS/);
      assert.doesNotMatch(error.message, new RegExp(malformed));
      return true;
    },
  );
});
