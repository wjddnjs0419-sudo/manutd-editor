import assert from "node:assert/strict";

import { resolveIntelligenceConfig } from "../../intelligence/config.ts";

function env(
  values: Record<string, string>,
): (name: string) => string | undefined {
  return (name) => values[name];
}

Deno.test("parses the intelligence feature flag strictly", () => {
  assert.equal(
    resolveIntelligenceConfig(env({ STORY_CLUSTER_AI_ENABLED: "true" }))
      .aiEnabled,
    true,
  );
  assert.equal(
    resolveIntelligenceConfig(env({ STORY_CLUSTER_AI_ENABLED: "false" }))
      .aiEnabled,
    false,
  );
});

Deno.test("parses model, prompt, and dictionary versions", () => {
  const config = resolveIntelligenceConfig(env({
    STORY_CLUSTER_AI_ENABLED: "true",
    STORY_CLUSTER_AI_MODEL: "cluster-model-v2",
    STORY_CLUSTER_AI_PROMPT_VERSION: "cluster-prompt-v3",
    STORY_CLUSTER_DICTIONARY_VERSION: "entity-v7",
  }));

  assert.equal(config.aiModel, "cluster-model-v2");
  assert.equal(config.aiPromptVersion, "cluster-prompt-v3");
  assert.equal(config.dictionaryVersion, "entity-v7");
});

Deno.test("uses the approved lease and heartbeat defaults", () => {
  const config = resolveIntelligenceConfig(env({}));

  assert.equal(config.leaseSeconds, 300);
  assert.equal(config.heartbeatSeconds, 30);
});

Deno.test("enforces the lease bounds", () => {
  for (const value of ["59", "1801"]) {
    assert.throws(
      () =>
        resolveIntelligenceConfig(
          env({ STORY_INTELLIGENCE_LEASE_SECONDS: value }),
        ),
      /STORY_INTELLIGENCE_LEASE_SECONDS/,
    );
  }

  assert.equal(
    resolveIntelligenceConfig(
      env({
        STORY_INTELLIGENCE_LEASE_SECONDS: "60",
        STORY_INTELLIGENCE_HEARTBEAT_SECONDS: "10",
      }),
    ).leaseSeconds,
    60,
  );
  assert.equal(
    resolveIntelligenceConfig(
      env({ STORY_INTELLIGENCE_LEASE_SECONDS: "1800" }),
    ).leaseSeconds,
    1800,
  );
});

Deno.test("enforces heartbeat minimum and lease-half relationship", () => {
  assert.throws(
    () =>
      resolveIntelligenceConfig(
        env({ STORY_INTELLIGENCE_HEARTBEAT_SECONDS: "9" }),
      ),
    /STORY_INTELLIGENCE_HEARTBEAT_SECONDS/,
  );
  assert.throws(
    () =>
      resolveIntelligenceConfig(
        env({
          STORY_INTELLIGENCE_LEASE_SECONDS: "60",
          STORY_INTELLIGENCE_HEARTBEAT_SECONDS: "30",
        }),
      ),
    /STORY_INTELLIGENCE_HEARTBEAT_SECONDS/,
  );
  assert.equal(
    resolveIntelligenceConfig(
      env({
        STORY_INTELLIGENCE_LEASE_SECONDS: "600",
        STORY_INTELLIGENCE_HEARTBEAT_SECONDS: "10",
      }),
    ).heartbeatSeconds,
    10,
  );
});

Deno.test("rejects invalid config without echoing secret values", () => {
  const secret = "super-secret-api-key-123";

  for (
    const [name, value] of [
      ["STORY_CLUSTER_AI_ENABLED", secret],
      ["STORY_CLUSTER_AI_MODEL", `${secret} with spaces`],
      ["STORY_CLUSTER_AI_PROMPT_VERSION", `${secret} with spaces`],
      ["STORY_CLUSTER_DICTIONARY_VERSION", `${secret} with spaces`],
      ["STORY_INTELLIGENCE_LEASE_SECONDS", secret],
      ["STORY_INTELLIGENCE_HEARTBEAT_SECONDS", secret],
    ]
  ) {
    assert.throws(
      () => resolveIntelligenceConfig(env({ [name]: value })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, new RegExp(name));
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});
