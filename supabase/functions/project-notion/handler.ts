import type { ProjectNotionResult } from "./orchestrator.ts";

export interface ProjectNotionHandlerDependencies {
  readonly collectorSecret: string;
  readonly run: (creativeBriefId: string) => Promise<ProjectNotionResult>;
  readonly requestId?: () => string;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  let difference = leftDigest.length ^ rightDigest.length;
  for (let index = 0; index < leftDigest.length; index += 1) difference |= (leftDigest[index] ?? 0) ^ (rightDigest[index] ?? 0);
  return difference === 0;
}

function bearerToken(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

async function requestedBriefId(request: Request): Promise<string> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidRequestError();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== "creative_brief_id" || typeof entries[0]?.[1] !== "string" || entries[0][1].trim() === "") throw new InvalidRequestError();
  return entries[0][1];
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export function createProjectNotionHandler(
  dependencies: ProjectNotionHandlerDependencies,
): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));

  return async (request: Request): Promise<Response> => {
    const id = requestId();
    if (request.method !== "POST") return json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, 405);
    const suppliedSecret = bearerToken(request.headers.get("authorization"));
    if (!suppliedSecret || !await timingSafeEqual(suppliedSecret, dependencies.collectorSecret)) return json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, 401);
    try {
      const result = await dependencies.run(await requestedBriefId(request));
      if (result.status === "NOT_FOUND") return json({ request_id: id, status: result.status, creative_brief_id: result.creative_brief_id }, 404);
      log({ requestId: id, event: "project_notion_completed", status: result.status, action: result.action });
      return json({ request_id: id, status: result.status, creative_brief_id: result.creative_brief_id, action: result.action ?? null, revision: result.revision ?? null, notion_page_id: result.notion_page_id ?? null, url: result.url ?? null }, 200);
    } catch (error) {
      if (error instanceof InvalidRequestError) return json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, 400);
      log({ requestId: id, event: "project_notion_failed", code: "PROJECT_NOTION_FAILED" });
      return json({ request_id: id, error: { code: "PROJECT_NOTION_FAILED", message: "Notion projection failed" } }, 500);
    }
  };
}
