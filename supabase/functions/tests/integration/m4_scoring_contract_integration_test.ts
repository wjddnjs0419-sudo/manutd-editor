import assert from "node:assert/strict";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing integration configuration: ${name}`);
  return value;
}

async function request(
  baseUrl: string,
  secretKey: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      apikey: secretKey,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Integration request failed: ${response.status}: ${body}`);
  return body.length === 0 ? null : JSON.parse(body);
}

Deno.test("M4 scoring RPC persists confidence evidence and deterministic rank", async () => {
  const baseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/u, "");
  const secretKey = requiredEnv("SUPABASE_SECRET_KEY");
  const suffix = crypto.randomUUID();
  const runAt = "2026-09-18T12:00:00.000Z";
  const rankingDate = "2026-09-18";

  const accounts = await request(
    baseUrl,
    secretKey,
    "/rest/v1/source_accounts?select=id&username=eq.utdreport&limit=1",
  ) as Array<{ id: string }>;
  const configs = await request(
    baseUrl,
    secretKey,
    "/rest/v1/scoring_configs?select=id&is_active=eq.true&limit=1",
  ) as Array<{ id: string }>;
  assert.equal(accounts.length, 1);
  assert.equal(configs.length, 1);

  let clusterId: string | undefined;
  let postId: string | undefined;
  try {
    const clusters = await request(baseUrl, secretKey, "/rest/v1/story_clusters", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        canonical_title: `M4 Deno scoring fixture ${suffix}`,
        first_seen_at: "2026-09-18T10:00:00.000Z",
        last_seen_at: "2026-09-18T10:00:00.000Z",
        global_account_count: 1,
        korean_account_count: 0,
        global_weight_coverage: 1,
        korean_weight_coverage: 0,
        independent_source_count: 1,
        highest_source_reliability: 10,
      }),
    }) as Array<{ id: string }>;
    clusterId = clusters[0]?.id;
    assert.ok(clusterId);

    const posts = await request(baseUrl, secretKey, "/rest/v1/raw_posts", {
      method: "POST",
      headers: { prefer: "return=representation" },
      body: JSON.stringify({
        source_account_id: accounts[0].id,
        external_post_id: `m4-deno-scoring-${suffix}`,
        media_type: "IMAGE",
        published_at: "2026-09-18T10:00:00.000Z",
        collected_at: "2026-09-18T11:00:00.000Z",
        like_count: 120,
        comments_count: 4,
        followers_count_at_collection: 1000,
        raw_payload: {},
      }),
    }) as Array<{ id: string }>;
    postId = posts[0]?.id;
    assert.ok(postId);

    await request(baseUrl, secretKey, "/rest/v1/story_cluster_posts", {
      method: "POST",
      body: JSON.stringify({
        story_cluster_id: clusterId,
        raw_post_id: postId,
        match_method: "SEED",
        match_confidence: 1,
      }),
    });

    await request(baseUrl, secretKey, "/rest/v1/post_metric_snapshots", {
      method: "POST",
      body: JSON.stringify([
        {
          raw_post_id: postId,
          captured_at: "2026-09-18T11:30:00.000Z",
          capture_bucket_start: "2026-09-18T11:30:00.000Z",
          followers_count: 1000,
          like_count: 120,
          comments_count: 4,
          post_age_minutes: 90,
        },
        {
          raw_post_id: postId,
          captured_at: "2026-09-18T11:00:00.000Z",
          capture_bucket_start: "2026-09-18T11:00:00.000Z",
          followers_count: 1000,
          like_count: 80,
          comments_count: 3,
          post_age_minutes: 60,
        },
        {
          raw_post_id: postId,
          captured_at: "2026-09-18T10:30:00.000Z",
          capture_bucket_start: "2026-09-18T10:30:00.000Z",
          followers_count: 1000,
          like_count: 50,
          comments_count: 2,
          post_age_minutes: 30,
        },
      ]),
    });

    await request(baseUrl, secretKey, "/rest/v1/rpc/calculate_priority_candidates", {
      method: "POST",
      body: JSON.stringify({ p_run_at: runAt, p_ranking_date: rankingDate }),
    });

    const candidates = await request(
      baseUrl,
      secretKey,
      `/rest/v1/content_candidates?select=id,rank,data_confidence,score_inputs&story_cluster_id=eq.${clusterId}&ranking_date=eq.${rankingDate}&scoring_config_id=eq.${configs[0].id}`,
    ) as Array<{ id: string; rank: number | null; data_confidence: number; score_inputs: Record<string, unknown> }>;
    assert.equal(candidates.length, 1);
    assert.ok((candidates[0].rank ?? 0) > 0);
    assert.ok(candidates[0].data_confidence > 0);
    assert.ok("data_confidence_components" in candidates[0].score_inputs);
    assert.ok("eligible_account_ids" in candidates[0].score_inputs);
  } finally {
    if (clusterId) {
      await request(baseUrl, secretKey, `/rest/v1/content_candidates?story_cluster_id=eq.${clusterId}`, { method: "DELETE" });
      await request(baseUrl, secretKey, `/rest/v1/story_cluster_posts?story_cluster_id=eq.${clusterId}`, { method: "DELETE" });
      await request(baseUrl, secretKey, `/rest/v1/story_clusters?id=eq.${clusterId}`, { method: "DELETE" });
    }
    if (postId) {
      await request(baseUrl, secretKey, `/rest/v1/raw_posts?id=eq.${postId}`, { method: "DELETE" });
    }
  }
});
