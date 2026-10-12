/**
 * M9.1 orchestration: original publisher article -> real image metadata ->
 * restricted byte probe -> ranked candidates for Telegram editorial review.
 *
 * No generation, Storage upload, or public Telegram/Instagram publishing.
 */
import {collectPublisherImages, type PhotoSourcePage,type PhotoCandidate} from "./article_photo_candidates.ts";
import {
  type M9PhotoSlot,type M9ImageProbe,type M9PhotoSelection,type M9PhotoSubjectGroup,
  type M9ProbeOptions,probePhotoImage,selectPublisherPhoto,matchPhotoSubjectGroups,
} from "./photo_quality.ts";

export interface M9PhotoSlotRequest {
  readonly slot: M9PhotoSlot;
  readonly subject_aliases: readonly string[];
  /** Separate named people; aliases within each group are synonyms for one person. */
  readonly subject_alias_groups?: readonly M9PhotoSubjectGroup[];
  /** 1-based creative brief page; omitted by legacy two-slot callers. */
  readonly slide_number?: number;
}
export interface M9PhotoHarvestJob {
  readonly publisher_article_urls: readonly string[];
  readonly official_article_urls?: readonly string[];
  readonly slots: readonly M9PhotoSlotRequest[];
}
export interface M9PhotoHarvestResult {
  readonly status: "CANDIDATES_FOR_REVIEW" | "NO_SUITABLE_IMAGE";
  readonly candidate_count: number;
  readonly probed_count: number;
  readonly selections: readonly M9PhotoSelection[];
  readonly publication_allowed: false;
  readonly rights_status: "UNVERIFIED";
}
export interface M9PhotoHarvestOptions extends M9ProbeOptions {
  readonly now?:Date;
  /** Caps network image inspections per job. Default 6; max 8. */
  readonly maxImageProbes?:number;
  /** Max fetched publisher/official article HTML pages, default 3. */
  readonly maxSourcePages?:number;
}

function uniquePageSources(job:M9PhotoHarvestJob,maxPages:number):PhotoSourcePage[] {
  const sources:PhotoSourcePage[]=[];
  const seen=new Set<string>();
  for(const [urls,origin] of [
    [job.publisher_article_urls,"ARTICLE"],
    [job.official_article_urls??[],"OFFICIAL_CLUB"],
  ] as const) {
    for(const url of urls) {
      if(seen.has(url)||sources.length>=maxPages)continue;
      seen.add(url);
      sources.push({url,origin});
    }
  }
  return sources;
}
function uniquePhotoCandidates(candidates:readonly PhotoCandidate[]):PhotoCandidate[] {
  const seen=new Set<string>();
  return candidates.filter(p=>{
    if(seen.has(p.image_url))return false;
    seen.add(p.image_url);return true;
  });
}
function subjectGroups(request:M9PhotoSlotRequest):readonly M9PhotoSubjectGroup[] {
  if(request.subject_alias_groups?.length)return request.subject_alias_groups;
  return [{canonical_name:request.subject_aliases[0]??"",aliases:request.subject_aliases}];
}
function candidateRelevance(candidate:PhotoCandidate, slots:readonly M9PhotoSlotRequest[]):number {
  const identity=Math.max(0,...slots.map(request=>{
    const groups=subjectGroups(request);
    const match=matchPhotoSubjectGroups(candidate,groups);
    const covered=match.metadata_matched_subjects.length;
    if(!covered&&!match.filename_matched_subjects.length)return 0;
    const complete=match.coverage==="FULL"?1_000_000:0;
    const coverage=Math.round(100_000*covered/groups.length);
    const evidence=covered?3_000:match.filename_matched_subjects.length?1_000:0;
    return complete+coverage+evidence;
  }));
  return identity+(candidate.origin==="ARTICLE"?100:0)+candidate.score;
}
/**
 * Fail-closed: unknown player metadata never enters the automatic probe budget.
 * A human can manually inspect unscreened images through a later review UI.
 */
export async function harvestArticlePhotos(
  job:M9PhotoHarvestJob, opts:M9PhotoHarvestOptions,
):Promise<M9PhotoHarvestResult> {
  if(!job.slots.length||job.slots.length>9||job.slots.some(x=>
    !x.subject_aliases.length&&!x.subject_alias_groups?.length ||
    (x.subject_alias_groups?.length??0)>6 ||
    x.subject_alias_groups?.some(group=>!group.canonical_name.trim()||!group.aliases.length)
  )) {
    throw new Error("M9_PHOTO_SLOTS_REQUIRED");
  }
  const maxSourcePages=Math.min(5,Math.max(1,opts.maxSourcePages??3));
  const maxProbes=Math.min(8,Math.max(1,opts.maxImageProbes??6));
  const sources=uniquePageSources(job,maxSourcePages);
  const candidates=uniquePhotoCandidates(await collectPublisherImages(sources,{
    fetch:opts.fetch,timeoutMs:opts.timeoutMs??5500,maxPages:maxSourcePages,
  }));
  const eligible=candidates.filter(candidate=>job.slots.some(s=>{
    const match=matchPhotoSubjectGroups(candidate,subjectGroups(s));
    return match.metadata_matched_subjects.length>0||match.filename_matched_subjects.length>0;
  }))
    .sort((a,b)=>candidateRelevance(b,job.slots)-candidateRelevance(a,job.slots));
  const toProbe=eligible.slice(0,maxProbes);
  const probes:M9ImageProbe[]=[];
  // Sequential to avoid hammering image CDNs; each image is probed once.
  for(const candidate of toProbe) {
    probes.push(await probePhotoImage(candidate.image_url,opts));
  }
  const now=opts.now??new Date();
  const selections=job.slots.map(request=>({
    ...selectPublisherPhoto(toProbe,probes,request.subject_aliases,request.slot,now,subjectGroups(request)),
    ...(request.slide_number !== undefined ? {slide_number:request.slide_number} : {}),
  }));
  return {
    status:selections.some(s=>s.status==="CANDIDATES_FOR_REVIEW")
      ? "CANDIDATES_FOR_REVIEW":"NO_SUITABLE_IMAGE",
    candidate_count:candidates.length,
    probed_count:toProbe.length,
    selections,
    publication_allowed:false,
    rights_status:"UNVERIFIED",
  };
}
