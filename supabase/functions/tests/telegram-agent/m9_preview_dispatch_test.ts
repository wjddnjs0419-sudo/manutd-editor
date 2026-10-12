import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { dispatchPrivateExplorationPreview } from "../../telegram-agent/m9_preview_dispatch.ts";

const brief = {
  id: "72bf1111-ae15-45ca-a812-3c1e2ee37a10",
  status: "DRAFT",
  generation_metadata: { generation_intent: "EXPLORATION" },
};

Deno.test("DRAFT preview dispatch is explicit, private upload-only, and returns the workflow link", async () => {
  let requestBody: Record<string, unknown> | null = null;
  let endpoint = "";
  const result = await dispatchPrivateExplorationPreview(brief, {
    token: "test-token",
    repository: "wjddnjs0419-sudo/manutd-editor",
    workflowRef: "codex/gnews-resolution-pipeline",
    fetchImpl: async (input, init) => {
      endpoint = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    },
  });
  assertEquals(endpoint, "https://api.github.com/repos/wjddnjs0419-sudo/manutd-editor/actions/workflows/m9-private-preview.yml/dispatches");
  assertEquals(requestBody, { ref: "codex/gnews-resolution-pipeline", inputs: { brief_id: brief.id, brief_status: "DRAFT", mode: "upload_preview" } });
  assertEquals(result.workflow_url, "https://github.com/wjddnjs0419-sudo/manutd-editor/actions/workflows/m9-private-preview.yml");
});

Deno.test("DRAFT preview rejects READY or non-Exploration briefs without contacting GitHub", async () => {
  let calls = 0;
  const options = { token: "test-token", repository: "owner/repo", workflowRef: "main", fetchImpl: async () => { calls += 1; return new Response(null, { status: 204 }); } };
  await assertRejects(() => dispatchPrivateExplorationPreview({ ...brief, status: "READY" }, options), Error, "M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  await assertRejects(() => dispatchPrivateExplorationPreview({ ...brief, generation_metadata: {} }, options), Error, "M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  assertEquals(calls, 0);
});
