export interface DraftPreviewBrief {
  readonly id: string;
  readonly status: string;
  readonly generation_metadata: unknown;
}

export interface DraftPreviewDispatchOptions {
  readonly token: string;
  readonly repository: string;
  readonly workflowRef: string;
  readonly fetchImpl?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function dispatchPrivateExplorationPreview(
  brief: DraftPreviewBrief,
  options: DraftPreviewDispatchOptions,
): Promise<{ workflow_url: string }> {
  if (!UUID.test(brief.id) || (brief.status !== "DRAFT" && brief.status !== "SELECTED")) {
    throw new Error("M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  }
  const metadata = brief.generation_metadata && typeof brief.generation_metadata === "object" && !Array.isArray(brief.generation_metadata)
    ? brief.generation_metadata as Record<string, unknown>
    : {};
  if (metadata.generation_intent !== "EXPLORATION") throw new Error("M9_DRAFT_PREVIEW_REQUIRES_EXPLORATION");
  if (!options.token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository) ||
      !/^[A-Za-z0-9._/-]+$/u.test(options.workflowRef) || options.workflowRef.includes("..")) {
    throw new Error("M9_PREVIEW_DISPATCH_NOT_CONFIGURED");
  }
  const endpoint = `https://api.github.com/repos/${options.repository}/actions/workflows/m9-private-preview.yml/dispatches`;
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        ref: options.workflowRef,
        inputs: { brief_id: brief.id, brief_status: "DRAFT", mode: "owner_review" },
      }),
    });
  } catch {
    throw new Error("M9_PREVIEW_DISPATCH_FAILED");
  }
  if (response.status !== 204) throw new Error("M9_PREVIEW_DISPATCH_FAILED");
  return { workflow_url: `https://github.com/${options.repository}/actions/workflows/m9-private-preview.yml` };
}
