import type { GroundingRunInput, GroundingSummary } from "./types.ts";

export interface GroundClaimsHandlerDependencies {
  readonly collectorSecret: string;
  readonly requestId?: () => string;
  readonly run: (input: GroundingRunInput) => Promise<GroundingSummary>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

class InvalidRequestError extends Error {}
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
function bearer(value: string | null): string { return value?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? ""; }
async function equal(left: string, right: string): Promise<boolean> { const encoder = new TextEncoder(); const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]); const x = new Uint8Array(a); const y = new Uint8Array(b); let diff = x.length ^ y.length; for (let i = 0; i < Math.max(x.length, y.length); i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0); return diff === 0; }
async function body(request: Request): Promise<GroundingRunInput> { const text = await request.text(); if (!text.trim()) return {}; let value: unknown; try { value = JSON.parse(text); } catch { throw new InvalidRequestError(); } if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError(); const object = value as Record<string, unknown>; if (Object.keys(object).some((key) => key !== "as_of")) throw new InvalidRequestError(); if (object.as_of === undefined) return {}; if (typeof object.as_of !== "string" || !ISO_TIMESTAMP.test(object.as_of)) throw new InvalidRequestError(); const asOf = new Date(object.as_of); if (!Number.isFinite(asOf.getTime())) throw new InvalidRequestError(); return { asOf }; }

export function createGroundClaimsHandler(dependencies: GroundClaimsHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.collectorSecret) throw new Error("Collector secret is required");
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  const log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  return async (request) => { const id = requestId(); if (request.method !== "POST") return Response.json({ request_id: id, error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405, headers: { allow: "POST" } }); const supplied = bearer(request.headers.get("authorization")); if (!supplied || !await equal(supplied, dependencies.collectorSecret)) { log({ requestId: id, event: "ground_claims_rejected", code: "UNAUTHORIZED" }); return Response.json({ request_id: id, error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 }); } try { const result = await dependencies.run(await body(request)); return Response.json({ request_id: id, status: result.status, claims_processed: result.claimsProcessed, verified: result.verified, discovery_only: result.discoveryOnly, contradicted: result.contradicted, insufficient: result.insufficient }); } catch (error) { if (error instanceof InvalidRequestError) return Response.json({ request_id: id, error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 }); log({ requestId: id, event: "ground_claims_failed", code: "GROUND_CLAIMS_FAILED" }); return Response.json({ request_id: id, error: { code: "GROUND_CLAIMS_FAILED", message: "Claim grounding failed" } }, { status: 500 }); } };
}
