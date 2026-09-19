import { validateCreativeBrief, type QualityGateConfig } from "../../creative-generation/quality_gate.ts";
import type { StoredCreativeBrief } from "../../creative-generation/repository.ts";
import type { CreativeBriefOutput, CreativeBriefSlide, EvidenceSnapshot } from "../../creative-generation/types.ts";

interface RevisionDependencies {
  qualityConfig: QualityGateConfig;
  idFactory?: () => string;
  reviseSlide?: (base: CreativeBriefOutput, slide: CreativeBriefSlide, instruction: string) => Promise<CreativeBriefSlide>;
  reviseCaption?: (base: CreativeBriefOutput, instruction: string) => Promise<{ body: string; cta: string }>;
}

function outputFromBrief(brief: StoredCreativeBrief): CreativeBriefOutput {
  const snapshot = brief.evidence_snapshot as EvidenceSnapshot;
  return { schema_version: "1.0", content_mode: brief.content_mode as CreativeBriefOutput["content_mode"], match_phase: brief.match_phase as CreativeBriefOutput["match_phase"], generation_quality: brief.generation_quality as CreativeBriefOutput["generation_quality"], angle: brief.angle, key_takeaway: String(brief.slides_json.key_takeaway ?? ""), hooks: brief.hooks_json as CreativeBriefOutput["hooks"], slides: brief.slides_json.slides as CreativeBriefSlide[], caption: { body: brief.caption_draft, cta: brief.cta }, sources: snapshot.sources.map((source) => ({ evidence_id: source.evidence_id, label: source.canonical_name })) };
}

function materialize(base: StoredCreativeBrief, output: CreativeBriefOutput, dependencies: RevisionDependencies, headlineOverride?: string): StoredCreativeBrief {
  const evidence = base.evidence_snapshot as EvidenceSnapshot;
  const validation = validateCreativeBrief(output, evidence, dependencies.qualityConfig);
  if (!validation.valid) throw new Error("REVISION_INVALID");
  return {
    ...base,
    id: dependencies.idFactory?.() ?? crypto.randomUUID(),
    version: base.version + 1,
    headline: headlineOverride ?? output.hooks[0]?.text ?? base.headline,
    angle: output.angle,
    slide_count: output.slides.length,
    slides_json: { slides: output.slides, key_takeaway: output.key_takeaway },
    caption_draft: output.caption.body,
    cta: output.caption.cta,
    status: "DRAFT",
    hooks_json: output.hooks,
    grounding_json: { claims: output.slides.flatMap((slide) => slide.claims) },
    generation_metadata: { ...(typeof base.generation_metadata === "object" && base.generation_metadata !== null ? base.generation_metadata : {}), origin: "TELEGRAM_COMMAND", base_brief_id: base.id },
    evidence_snapshot: structuredClone(base.evidence_snapshot),
    generated_at: new Date().toISOString(),
  };
}

export async function selectHook(baseBrief: StoredCreativeBrief, hookNumber: number, dependencies: RevisionDependencies): Promise<StoredCreativeBrief> {
  const output = outputFromBrief(baseBrief);
  if (!Number.isInteger(hookNumber) || hookNumber < 1 || hookNumber > output.hooks.length) throw new Error("HOOK_NOT_FOUND");
  const hooks = output.hooks.map((hook, index) => index === hookNumber - 1 ? { ...hook, text: hook.text } : hook);
  return materialize(baseBrief, { ...output, hooks }, dependencies, hooks[hookNumber - 1]?.text);
}

export async function reviseSlide(baseBrief: StoredCreativeBrief, slideNumber: number, instruction: string, dependencies: RevisionDependencies): Promise<StoredCreativeBrief> {
  const output = outputFromBrief(baseBrief);
  const target = output.slides.find((slide) => slide.slide_number === slideNumber);
  if (!target || !instruction.trim() || !dependencies.reviseSlide) throw new Error("SLIDE_NOT_FOUND");
  const revised = await dependencies.reviseSlide(output, target, instruction);
  if (revised.slide_number !== slideNumber) throw new Error("REVISION_INVALID");
  return materialize(baseBrief, { ...output, slides: output.slides.map((slide) => slide.slide_number === slideNumber ? revised : slide) }, dependencies);
}

export async function reviseCaption(baseBrief: StoredCreativeBrief, instruction: string, dependencies: RevisionDependencies): Promise<StoredCreativeBrief> {
  const output = outputFromBrief(baseBrief);
  if (!instruction.trim() || !dependencies.reviseCaption) throw new Error("CAPTION_PROVIDER_MISSING");
  const caption = await dependencies.reviseCaption(output, instruction);
  if (!caption.body.trim() || !caption.cta.trim()) throw new Error("REVISION_INVALID");
  return materialize(baseBrief, { ...output, caption }, dependencies);
}
