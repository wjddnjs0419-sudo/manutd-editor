export interface MorningBriefResult {
  status: "SENT" | "ALREADY_SENT" | "NOT_READY" | "DEGRADED" | "FAILED";
  briefing_date: string;
  messages_sent: number;
  render_mode: "OPENAI" | "FALLBACK_TEMPLATE";
  readiness?: "NOT_READY" | "DEGRADED" | "READY_EMPTY" | "READY_WITH_CANDIDATES";
  warning?: string;
}

export interface MorningBriefHandlerDependencies {
  invokeSecret: string;
  run: (request: { force: boolean }) => Promise<MorningBriefResult>;
}

function bearer(header: string | null): string {
  return header?.match(/^Bearer ([^\s]+)$/u)?.[1] ?? "";
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(left)), crypto.subtle.digest("SHA-256", encoder.encode(right))]);
  const leftBytes = new Uint8Array(a);
  const rightBytes = new Uint8Array(b);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) diff |= leftBytes[index] ^ rightBytes[index];
  return diff === 0;
}

export function createMorningBriefHandler(dependencies: MorningBriefHandlerDependencies): (request: Request) => Promise<Response> {
  if (!dependencies.invokeSecret) throw new Error("Morning brief invoke secret is required");
  return async (request) => {
    if (request.method !== "POST") return Response.json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST required" } }, { status: 405 });
    if (!await equalSecret(bearer(request.headers.get("authorization")), dependencies.invokeSecret)) return Response.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    if (typeof body !== "object" || body === null || Array.isArray(body)) return Response.json({ error: { code: "INVALID_REQUEST", message: "Invalid request body" } }, { status: 400 });
    const result = await dependencies.run({ force: true });
    const responseStatus = result.status === "FAILED" ? 502 : result.status === "NOT_READY" ? 409 : result.status === "DEGRADED" ? 503 : 200;
    return Response.json(result, { status: responseStatus });
  };
}
