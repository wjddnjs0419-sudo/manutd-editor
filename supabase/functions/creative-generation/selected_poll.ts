import type { GenerationResult, GenerationTrigger } from "./orchestrator.ts";

export interface SelectedDailyIntelligencePage {
  readonly id: string;
  readonly properties: Record<string, unknown>;
}

export interface SelectedPollClient {
  queryDatabase(): Promise<readonly SelectedDailyIntelligencePage[]>;
}

export interface SelectedPollSummary {
  readonly selected: number;
  readonly triggered: number;
  readonly failed: number;
}

function property(page: SelectedDailyIntelligencePage, name: string): Record<string, unknown> {
  const value = page.properties[name];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function candidateId(page: SelectedDailyIntelligencePage): string | null {
  const richText = property(page, "Candidate ID").rich_text;
  if (!Array.isArray(richText)) return null;
  const first = richText[0];
  if (!first || typeof first !== "object") return null;
  const value = first as Record<string, unknown>;
  if (typeof value.plain_text === "string" && value.plain_text.trim()) return value.plain_text;
  const text = value.text;
  if (text && typeof text === "object" && typeof (text as Record<string, unknown>).content === "string") return (text as Record<string, unknown>).content as string;
  return null;
}

export async function pollSelectedDailyIntelligence(
  notion: SelectedPollClient,
  run: (trigger: GenerationTrigger) => Promise<GenerationResult>,
): Promise<SelectedPollSummary> {
  const pages = await notion.queryDatabase();
  let selected = 0;
  let triggered = 0;
  let failed = 0;
  for (const page of pages) {
    if (property(page, "Selected").checkbox !== true) continue;
    const id = candidateId(page);
    if (!id) continue;
    selected += 1;
    try {
      await run({ candidate_id: id, trigger_type: "NOTION_SELECTED" });
      triggered += 1;
    } catch {
      failed += 1;
    }
  }
  return { selected, triggered, failed };
}
