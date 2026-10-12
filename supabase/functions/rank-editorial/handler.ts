import type { EditorialRankingRunInput, EditorialRankingSummary } from "./types.ts";
import { businessDate } from "../_shared/m6/business_date.ts";

export interface RankEditorialHandlerDependencies {
  readonly collectorSecret: string;
  readonly requestId?: () => string;
  readonly run: (input: EditorialRankingRunInput & { readonly rankingDate: string }, requestId: string) => Promise<EditorialRankingSummary>;
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
  const emit = (entry: Record<string, unknown>) => {
    try { log(entry); } catch { /* Logging must never change the request result. */ }
  };
  const stage = (id: string, name: string, startedAt: number, outcome: string, fields: Record<string, unknown> = {}) => {
    emit({ requestId: id, event: "rank_editorial_stage", stage: name, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), outcome, ...fields });
  };
  return async (request) => {
    const id = requestId();
    const totalStartedAt = performance.now();
    const finish = (response: Response, outcome: string, code?: string) => {
      stage(id, "total", totalStartedAt, outcome, { status: response.status, ...(code ? { code } : {}) });
      return response;
    };
    if (request.method !== "POST") return finish(Response.json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405, headers: { allow: "POST" } }), "rejected", "METHOD_NOT_ALLOWED");
    const authStartedAt = performance.now();
    const supplied = bearer(request.headers.get("authorization"));
    const authorized = Boolean(supplied) && await equal(supplied, dependencies.collectorSecret);
    stage(id, "auth", authStartedAt, authorized ? "accepted" : "rejected", authorized ? {} : { code: "UNAUTHORIZED" });
    if (!authorized) return finish(Response.json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 }), "rejected", "UNAUTHORIZED");
    const parseStartedAt = performance.now();
    let input: EditorialRankingRunInput;
    try {
      input = await body(request);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        stage(id, "parse", parseStartedAt, "rejected", { code: "INVALID_REQUEST" });
        return finish(Response.json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 }), "rejected", "INVALID_REQUEST");
      }
      stage(id, "parse", parseStartedAt, "failed", { code: "REQUEST_PARSE_FAILED" });
      emit({ requestId: id, event: "rank_editorial_failed", code: "REQUEST_PARSE_FAILED" });
      return finish(Response.json({ request_id: id, error: { code: "RANK_EDITORIAL_FAILED", message: "Editorial ranking failed" } }, { status: 500 }), "failed", "REQUEST_PARSE_FAILED");
    }
    stage(id, "parse", parseStartedAt, "accepted");
    const rankingInput = {
      ...input,
      rankingDate: input.rankingDate ?? businessDate(input.asOf ?? new Date(), "Asia/Seoul"),
    };
    const runStartedAt = performance.now();
    try {
      const result = await dependencies.run(rankingInput, id);
      stage(id, "run", runStartedAt, "completed");
      return finish(Response.json({ request_id: id, status: result.status, ranked: result.ranked, news_eligible: result.newsEligible, research_leads: result.researchLeads, version: result.version }), "completed");
    } catch {
      stage(id, "run", runStartedAt, "failed", { code: "RANK_EDITORIAL_FAILED" });
      emit({ requestId: id, event: "rank_editorial_failed", code: "RANK_EDITORIAL_FAILED" });
      return finish(Response.json({ request_id: id, error: { code: "RANK_EDITORIAL_FAILED", message: "Editorial ranking failed" } }, { status: 500 }), "failed", "RANK_EDITORIAL_FAILED");
    }
  };
}
