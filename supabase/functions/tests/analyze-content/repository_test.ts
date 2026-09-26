import assert from "node:assert/strict";

import {
  createAnalysisRepository,
  type AnalysisSaveInput,
} from "../../analyze-content/repository.ts";
import { goldenAnalysisOutput } from "../fixtures/m8_phase_a.ts";

const rawPostId = "00000000-0000-4000-8000-000000000101";
const accountId = "00000000-0000-4000-8000-000000000102";
const contract = {
  analysisVersion: "m8-a-v1",
  model: "test-model",
  promptVersion: "prompt-v1",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("lists bounded candidates with ordered private asset metadata only", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const repository = createAnalysisRepository({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "sb_secret_test",
    fetch: async (input, init = {}) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/raw_posts?")) {
        return jsonResponse([{
          id: rawPostId,
          caption: "Thoughts? 👀",
          media_type: "CAROUSEL_ALBUM",
          media_product_type: null,
          created_at: "2026-09-27T00:00:00.000Z",
          media_assets: [
            {
              id: "00000000-0000-4000-8000-000000000203",
              asset_type: "CAROUSEL_CHILD",
              carousel_index: 1,
              storage_path: `instagram/${accountId}/post-1/media-2.jpg`,
              mime_type: "image/jpeg",
              sha256: "b".repeat(64),
              original_media_url: "https://private.example/never-return-this",
            },
            {
              id: "00000000-0000-4000-8000-000000000202",
              asset_type: "CAROUSEL_CHILD",
              carousel_index: 0,
              storage_path: `instagram/${accountId}/post-1/media-1.jpg`,
              mime_type: "image/jpeg",
              sha256: "a".repeat(64),
              original_media_url: "https://private.example/never-return-this",
            },
          ],
        }]);
      }
      return jsonResponse([{ raw_post_id: rawPostId, input_fingerprint: "old-fingerprint" }]);
    },
  });

  const candidates = await repository.listCandidates(new Date("2026-09-27T01:00:00.000Z"), 10, contract);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.caption, "Thoughts? 👀");
  assert.deepEqual(candidates[0]?.assets.map((asset) => asset.carouselIndex), [0, 1]);
  assert.equal(Object.hasOwn(candidates[0]?.assets[0] ?? {}, "originalMediaUrl"), false);
  assert.deepEqual(candidates[0]?.existingFingerprints, ["old-fingerprint"]);
  const rawPostHeaders = requests[0]?.init.headers as Record<string, string> | undefined;
  const analysisHeaders = requests[1]?.init.headers as Record<string, string> | undefined;
  assert.equal(rawPostHeaders?.["accept-profile"], undefined);
  assert.equal(rawPostHeaders?.["content-profile"], undefined);
  assert.equal(analysisHeaders?.["accept-profile"], "app_private");
  assert.equal(analysisHeaders?.["content-profile"], "app_private");
  assert.equal(requests[0]?.url.includes("original_media_url"), false);
});

Deno.test("upserts the exact private semantic row and does not send public media URLs", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const repository = createAnalysisRepository({
    supabaseUrl: "https://project.supabase.co/",
    serviceRoleKey: "sb_secret_test",
    fetch: async (input, init = {}) => {
      request = { url: String(input), init };
      return jsonResponse([]);
    },
  });
  const input: AnalysisSaveInput = {
    rawPostId,
    status: "SUCCEEDED",
    contract,
    inputFingerprint: "a".repeat(64),
    output: goldenAnalysisOutput,
    errorCategory: null,
    analyzedAt: "2026-09-27T01:00:00.000Z",
  };

  await repository.save(input);

  assert.match(request?.url ?? "", /content_understandings\?on_conflict=/);
  const headers = request?.init.headers as Record<string, string>;
  assert.equal(headers["accept-profile"], "app_private");
  assert.equal(headers["content-profile"], "app_private");
  const body = JSON.parse(String(request?.init.body)) as Record<string, unknown>;
  assert.equal(body.raw_post_id, rawPostId);
  assert.equal(body.input_fingerprint, "a".repeat(64));
  assert.deepEqual(body.claims, goldenAnalysisOutput.claims);
  assert.equal(JSON.stringify(body).includes("original_media_url"), false);
});
