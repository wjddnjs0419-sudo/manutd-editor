import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import { dispatchPrivateExplorationPreview } from "../../telegram-agent/m9_preview_dispatch.ts";

const brief = {
  id: "72bf1111-ae15-45ca-a812-3c1e2ee37a10",
  status: "DRAFT",
  generation_metadata: { generation_intent: "EXPLORATION" },
};
const EXPECTED_SHA = "a".repeat(40);

Deno.test("DRAFT preview dispatch requests the private owner-review workflow", async () => {
  let requestBody: Record<string, unknown> | null = null;
  let refEndpoint = "";
  let dispatchEndpoint = "";
  let requests = 0;
  const result = await dispatchPrivateExplorationPreview(brief, {
    token: "test-token",
    repository: "wjddnjs0419-sudo/manutd-editor",
    workflowRef: "codex/gnews-resolution-pipeline",
    fetchImpl: async (input, init) => {
      requests += 1;
      if (requests === 1) {
        refEndpoint = String(input);
        assertEquals(init?.method, "GET");
        return new Response(JSON.stringify({ object: { sha: EXPECTED_SHA } }), { status: 200 });
      }
      dispatchEndpoint = String(input);
      requestBody = JSON.parse(String(init?.body));
      assertEquals(init?.method, "POST");
      return new Response(null, { status: 204 });
    },
  });
  assertEquals(refEndpoint, "https://api.github.com/repos/wjddnjs0419-sudo/manutd-editor/git/ref/heads/codex%2Fgnews-resolution-pipeline");
  assertEquals(dispatchEndpoint, "https://api.github.com/repos/wjddnjs0419-sudo/manutd-editor/actions/workflows/m9-private-preview.yml/dispatches");
  assertEquals(requestBody, { ref: "codex/gnews-resolution-pipeline", inputs: { brief_id: brief.id, brief_status: "DRAFT", expected_sha: EXPECTED_SHA, mode: "owner_review" } });
  assertEquals(result.workflow_url, "https://github.com/wjddnjs0419-sudo/manutd-editor/actions/workflows/m9-private-preview.yml");
});

Deno.test("DRAFT preview stops before dispatch when the selected ref has no valid commit SHA", async () => {
  let requests = 0;
  const options = {
    token: "test-token",
    repository: "owner/repo",
    workflowRef: "codex/gnews-resolution-pipeline",
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ object: { sha: "not-a-commit" } }), { status: 200 });
    },
  };
  await assertRejects(() => dispatchPrivateExplorationPreview(brief, options), Error, "M9_PREVIEW_DISPATCH_FAILED");
  assertEquals(requests, 1);
});

Deno.test("DRAFT preview rejects READY or non-Exploration briefs without contacting GitHub", async () => {
  let calls = 0;
  const options = { token: "test-token", repository: "owner/repo", workflowRef: "main", fetchImpl: async () => { calls += 1; return new Response(null, { status: 204 }); } };
  await assertRejects(() => dispatchPrivateExplorationPreview({ ...brief, status: "READY" }, options), Error, "M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  await assertRejects(() => dispatchPrivateExplorationPreview({ ...brief, generation_metadata: {} }, options), Error, "M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  assertEquals(calls, 0);
});
