import type { NotionBlock, NotionPagePayload, NotionProperty, RichText } from "../notion-sync/mapper.ts";
import type { StoredCreativeBrief } from "./repository.ts";

export interface ContentPipelineNotionClientLike {
  createPage(payload: NotionPagePayload): Promise<{ id: string; url?: string }>;
  updatePage(pageId: string, payload: { properties: Record<string, unknown> }): Promise<{ id: string; url?: string }>;
  appendBlockChildren(pageId: string, children: NotionBlock[]): Promise<{ id: string; url?: string }>;
}

export interface ExistingPipelineState {
  readonly notion_page_id: string | null;
  readonly production_status: "EDITABLE" | "LOCKED" | "APPROVED" | "UNKNOWN";
  readonly current_revision: number | null;
}

export interface ProjectionResult {
  readonly action: "CREATED" | "UPDATED";
  readonly notion_page_id: string;
  readonly url?: string;
  readonly revision: number;
}

function text(content: string): RichText {
  return { type: "text", text: { content: content.slice(0, 1900) } };
}

function rich(content: string): NotionProperty {
  return { rich_text: content ? [text(content)] : [] };
}

function title(content: string): NotionProperty {
  return { title: [text(content || "Creative Brief")] };
}

function number(value: number | null): NotionProperty {
  return { number: value };
}

function select(value: string | null): NotionProperty {
  return { select: value ? { name: value } : null };
}

function block(type: NotionBlock["type"], content: string): NotionBlock {
  const value = { rich_text: [text(content)] };
  if (type === "heading_2") return { object: "block", type, heading_2: value };
  if (type === "bulleted_list_item") return { object: "block", type, bulleted_list_item: value };
  return { object: "block", type, paragraph: value };
}

export function dailyIntelligenceCreativeProperties(input: { status: string; revision: number | null; contentPipelineUrl?: string }): Record<string, unknown> {
  return {
    "Creative Status": select(input.status),
    "Current Brief Revision": number(input.revision),
    "Content Pipeline URL": rich(input.contentPipelineUrl ?? ""),
  };
}

function properties(brief: StoredCreativeBrief): Record<string, NotionProperty> {
  return {
    Title: title(brief.headline),
    "Source Candidate": rich(brief.candidate_id),
    "Creative Brief ID": rich(brief.id),
    Revision: number(brief.version),
    "Content Mode": select(brief.content_mode),
    "Creative Status": select(brief.status),
  };
}

function body(brief: StoredCreativeBrief): NotionBlock[] {
  const slides = Array.isArray(brief.slides_json.slides) ? brief.slides_json.slides : [];
  const hooks = Array.isArray(brief.hooks_json) ? brief.hooks_json : [];
  const design = Array.isArray(brief.design_json.slides) ? brief.design_json.slides : [];
  const sources = Array.isArray((brief.evidence_snapshot as { sources?: unknown[] })?.sources) ? (brief.evidence_snapshot as { sources: unknown[] }).sources : [];
  const blocks: NotionBlock[] = [block("heading_2", "Creative Brief"), block("paragraph", `Angle: ${brief.angle}`), block("paragraph", `Key Takeaway: ${String(brief.slides_json.key_takeaway ?? "")}`), block("heading_2", "Hook Options")];
  hooks.forEach((hook) => { if (hook && typeof hook === "object") blocks.push(block("bulleted_list_item", String((hook as Record<string, unknown>).text ?? ""))); });
  blocks.push(block("heading_2", "Carousel"));
  slides.forEach((slide) => { if (slide && typeof slide === "object") { const value = slide as Record<string, unknown>; blocks.push(block("paragraph", `Slide ${String(value.slide_number)} — ${String(value.headline)}\n${String(value.body)}`)); } });
  blocks.push(block("heading_2", "Caption"), block("paragraph", brief.caption_draft), block("paragraph", `CTA: ${brief.cta}`), block("heading_2", "Visual Direction"));
  design.forEach((slide) => { if (slide && typeof slide === "object") blocks.push(block("bulleted_list_item", JSON.stringify(slide))); });
  blocks.push(block("heading_2", "Sources"));
  sources.forEach((source) => { if (source && typeof source === "object") blocks.push(block("bulleted_list_item", JSON.stringify(source))); });
  return blocks;
}

export async function projectCreativeBriefToContentPipeline(
  brief: StoredCreativeBrief,
  existing: ExistingPipelineState | null,
  notion: ContentPipelineNotionClientLike,
): Promise<ProjectionResult> {
  const payload: NotionPagePayload = { properties: properties(brief), children: body(brief) };
  if (existing?.notion_page_id && existing.production_status === "EDITABLE") {
    const page = await notion.updatePage(existing.notion_page_id, { properties: payload.properties });
    await notion.appendBlockChildren(existing.notion_page_id, payload.children);
    return { action: "UPDATED", notion_page_id: page.id, url: page.url, revision: brief.version };
  }
  const page = await notion.createPage(payload);
  return { action: "CREATED", notion_page_id: page.id, url: page.url, revision: brief.version };
}
