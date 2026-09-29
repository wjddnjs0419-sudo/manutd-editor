import type { PromotionSummary } from "./types.ts";

export interface PromoteDiscoveryHandlerDependencies {
  readonly invokeSecret: string;
  readonly defaultLimit?: number;
  readonly now?: () => Date;
  readonly run: (input: { asOf?: Date; limit?: number; rankingDate?: string }) => Promise<PromotionSummary>;
}

function bearer(value: string | null): string { return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }

async function equal(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let index = 0; index < x.length; index += 1) diff |= x[index]! ^ y[index]!;
  return diff === 0;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function createPromoteDiscoveryHandler(dependencies: PromoteDiscoveryHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret.trim()) throw new Error("Promotion invoke secret is required");
  const now = dependencies.now ?? (() => new Date());
  const defaultLimit = dependencies.defaultLimit ?? 100;
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    if (!await equal(bearer(request.headers.get("authorization")), dependencies.invokeSecret)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    let body: unknown;
    try { body = await request.json(); } catch { body = {}; }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const value = body as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["as_of", "limit", "ranking_date"].includes(key))) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const asOf = value.as_of === undefined ? now() : typeof value.as_of === "string" && ISO.test(value.as_of) ? new Date(value.as_of) : null;
    const limit = value.limit === undefined ? defaultLimit : value.limit;
    const rankingDate = value.ranking_date === undefined ? undefined : typeof value.ranking_date === "string" && DATE.test(value.ranking_date) ? value.ranking_date : null;
    if (!asOf || !Number.isFinite(asOf.getTime()) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || rankingDate === null) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const result = await dependencies.run({ asOf, limit, ...(rankingDate ? { rankingDate } : {}) });
    return Response.json(result);
  };
}
