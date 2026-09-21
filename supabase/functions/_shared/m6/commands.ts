export type ParsedCommand =
  | { type: "TODAY" | "CURRENT" | "BRIEF" | "SELECT" | "STATUS" | "BACK" | "RESET" | "CONFIRM" | "CANCEL" | "HELP" }
  | { type: "OPEN"; target: string }
  | { type: "HOOK"; hook: number }
  | { type: "SLIDE"; slide: number; instruction: string }
  | { type: "CAPTION"; instruction: string };

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export function parseCommand(text: string): ParsedCommand | null {
  const value = text.trim();
  if (/^\/(?:today|current|brief|select|status|back|reset|confirm|cancel|help)$/u.test(value)) return { type: value.slice(1).toUpperCase() as ParsedCommand["type"] } as ParsedCommand;
  const open = value.match(new RegExp(`^\\/open\\s+((?:[1-3])|alert|${uuid})$`, "iu"));
  if (open) return { type: "OPEN", target: open[1] };
  const hook = value.match(/^\/hook\s+([1-3])$/u);
  if (hook) return { type: "HOOK", hook: Number(hook[1]) };
  const slide = value.match(/^\/slide\s+([1-7])\s+(\S[\s\S]*)$/u);
  if (slide) return { type: "SLIDE", slide: Number(slide[1]), instruction: slide[2].trim() };
  const caption = value.match(/^\/caption\s+(\S[\s\S]*)$/u);
  if (caption) return { type: "CAPTION", instruction: caption[1].trim() };
  return null;
}

export interface CommandThread {
  id: string;
  active_candidate_id: string | null;
  active_brief_id: string | null;
  active_match_id: string | null;
  context_history: readonly unknown[];
  pending_action?: Record<string, unknown> | null;
  pending_action_expires_at?: string | null;
}

export interface CommandResult { status: string; reply: string; result_brief_id?: string | null; }

export interface PendingAction {
  command_event_id: string;
  command_type: string;
  base_brief_id: string;
  base_revision: number;
  args: Record<string, unknown>;
  requested_at: string;
  expires_at: string;
}

export function validatePendingAction(
  pending: PendingAction | null | undefined,
  current: { latest_brief_id: string | null; latest_revision: number | null; production_status: string },
  now = new Date(),
): "NO_PENDING_ACTION" | "PENDING_ACTION_EXPIRED" | "STALE_PENDING_ACTION" | "CONFIRMABLE" {
  if (!pending) return "NO_PENDING_ACTION";
  if (Date.parse(pending.expires_at) <= now.getTime()) return "PENDING_ACTION_EXPIRED";
  if (pending.base_brief_id !== current.latest_brief_id || pending.base_revision !== current.latest_revision) return "STALE_PENDING_ACTION";
  if (current.production_status !== "LOCKED" && current.production_status !== "APPROVED") return "STALE_PENDING_ACTION";
  return "CONFIRMABLE";
}

export async function commandFingerprint(input: { telegram_update_id: number; base_brief_id: string; command_type: string; args: unknown }): Promise<string> {
  const canonical = JSON.stringify({ origin: "TELEGRAM_COMMAND", ...input });
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function executeCommand(command: ParsedCommand, thread: CommandThread, deps: { run: (command: ParsedCommand, thread: CommandThread) => Promise<CommandResult> }): Promise<CommandResult> {
  return deps.run(command, thread);
}
