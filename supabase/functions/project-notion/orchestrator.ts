import { projectCreativeBriefToContentPipeline, dailyIntelligenceCreativeProperties, type ContentPipelineNotionClientLike } from "../creative-generation/notion_projection.ts";
import type { ProjectNotionRepository } from "../creative-generation/repository.ts";

export interface ProjectNotionDependencies {
  readonly repository: ProjectNotionRepository;
  readonly notion: ContentPipelineNotionClientLike;
}

export interface ProjectNotionResult {
  readonly status: "PROJECTED" | "NOT_FOUND";
  readonly creative_brief_id: string;
  readonly action?: "CREATED" | "UPDATED";
  readonly revision?: number;
  readonly notion_page_id?: string;
  readonly url?: string;
}

export async function runProjectNotion(
  creativeBriefId: string,
  dependencies: ProjectNotionDependencies,
): Promise<ProjectNotionResult> {
  const brief = await dependencies.repository.getCreativeBrief(creativeBriefId);
  if (!brief) return { status: "NOT_FOUND", creative_brief_id: creativeBriefId };

  const existing = await dependencies.repository.getPipelineState(brief.candidate_id);
  const projection = await projectCreativeBriefToContentPipeline(brief, existing, dependencies.notion);
  await dependencies.repository.savePipelineState({
    candidate_id: brief.candidate_id,
    creative_brief_id: brief.id,
    revision: projection.revision,
    notion_page_id: projection.notion_page_id,
    sync_hash: brief.input_fingerprint,
    production_status: "EDITABLE",
  });
  const dailyPageId = await dependencies.repository.getDailyIntelligencePageId(brief.candidate_id);
  if (dailyPageId) {
    await dependencies.notion.updatePage(dailyPageId, {
      properties: dailyIntelligenceCreativeProperties({ status: brief.status, revision: brief.version, contentPipelineUrl: projection.url }),
    });
  }
  return {
    status: "PROJECTED",
    creative_brief_id: brief.id,
    action: projection.action,
    revision: projection.revision,
    notion_page_id: projection.notion_page_id,
    url: projection.url,
  };
}
