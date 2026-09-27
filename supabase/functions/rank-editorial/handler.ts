import type { EditorialRankingRunInput, EditorialRankingSummary } from "./types.ts";

export interface RankEditorialHandlerDependencies {
  readonly collectorSecret: string;
  readonly requestId?: () => string;
  readonly run: (input: EditorialRankingRunInput) => Promise<EditorialRankingSummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
function bearer(value: string | null): string { return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }
async function equal(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b); let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
async function body(request: Request): Promise<EditorialRankingRunInput> {
  const text = await request.text();
  if (!text.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new InvalidRequestError(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !["as_of", "ranking_date"].includes(key))) throw new InvalidRequestError();
  const result: EditorialRankingRunInput = {};
  if (object.as_of !== undefined) {
    if (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of) || !Number.isFinite(new Date(object.as_of).getTime())) throw new InvalidRequestError();
    (result as { asOf?: Date }).asOf = new Date(object.as_of);
  }
  if (object.ranking_date !== undefined) {
    if (typeof object.ranking_date !== "string" || !DATE.test(object.ranking_date)) throw new InvalidRequestError();
    (result as { rankingDate?: string }).rankingDate = object.ranking_date;
  }
  return result;
}

export function createRankEditorialHandler(dependencies: RankEditorialHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request) => {
    const id = requestId();
    if (request.method !== "POST") return Response.json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405, headers: { allow: "POST" } });
    const supplied = bearer(request.headers.get("authorization"));
    if (!supplied || !await equal(supplied, dependencies.collectorSecret)) { log({ requestId: id, event: "rank_editorial_rejected", code: "UNAUTHORIZED" }); return Response.json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 }); }
    try {
      const result = await dependencies.run(await body(request));
      return Response.json({ request_id: id, status: result.status, ranked: result.ranked, news_eligible: result.newsEligible, research_leads: result.researchLeads, version: result.version });
    } catch (error) {
      if (error instanceof InvalidRequestError) return Response.json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
      log({ requestId: id, event: "rank_editorial_failed", code: "RANK_EDITORIAL_FAILED" });
      return Response.json({ request_id: id, error: { code: "RANK_EDITORIAL_FAILED", message: "Editorial ranking failed" } }, { status: 500 });
    }
  };
}
