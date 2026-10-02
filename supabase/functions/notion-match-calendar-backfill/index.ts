import { createM6Repository } from "../_shared/m6/repository.ts";
import { runMatchCalendarBackfill } from "../_shared/m6/match_calendar_backfill.ts";
import { projectMatchToCalendarBestEffort } from "../_shared/m6/match_assistant.ts";
import { createNotionClient } from "../notion-sync/notion_client.ts";

const invokeSecret = Deno.env.get("TELEGRAM_AGENT_INVOKE_SECRET") ??
  Deno.env.get("COLLECTOR_INVOKE_SECRET") ?? "";
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SECRET_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const repository = createM6Repository({ supabaseUrl, serviceRoleKey });
const notionToken = Deno.env.get("NOTION_TOKEN") ??
  Deno.env.get("NOTION_API_KEY") ?? "";
const notionDatabaseId = Deno.env.get("NOTION_MATCH_CALENDAR_DATABASE_ID") ??
  "";
const missingNotionConfiguration = [
  ...(!notionToken ? ["NOTION_TOKEN"] : []),
  ...(!notionDatabaseId ? ["NOTION_MATCH_CALENDAR_DATABASE_ID"] : []),
];
const configured = Boolean(notionToken && notionDatabaseId);
const notion = configured
  ? createNotionClient({ token: notionToken, databaseId: notionDatabaseId })
  : null;

async function matchesSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function bearer(request: Request): string {
  return request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/u)
    ?.[1] ?? "";
}

const handler = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") {
    return Response.json({ error: { code: "METHOD_NOT_ALLOWED" } }, {
      status: 405,
    });
  }
  const suppliedSecret = bearer(request);
  if (
    !invokeSecret || !suppliedSecret ||
    !await matchesSecret(suppliedSecret, invokeSecret)
  ) {
    return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  }
  const result = await runMatchCalendarBackfill({
    configured,
    missingConfiguration: missingNotionConfiguration,
    now: new Date(),
    listMatches: (from, to) => repository.listMatchesForCalendar(from, to),
    project: (match, mode, syncedAt) =>
      projectMatchToCalendarBestEffort({
        match,
        mode,
        configured,
        notion,
        missingConfiguration: missingNotionConfiguration,
        getState: (matchId) => repository.getMatchCalendarSyncState(matchId),
        saveState: (state) => repository.saveMatchCalendarSyncState(state),
        syncedAt,
      }),
  });
  return Response.json(
    result,
    result.status === "PARTIAL" ? { status: 207 } : { status: 200 },
  );
};

Deno.serve(handler);
