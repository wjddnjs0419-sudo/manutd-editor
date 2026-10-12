/**
 * M9.1: inspect REAL image bytes (never generate an image) and rank usable
 * candidates for editorial review. No photo is auto-approved for publishing.
 * Only small byte ranges are fetched; no publisher image is cached/stored here.
 */
import type { PhotoCandidate } from "./article_photo_candidates.ts";
import cropPolicy from "./crop_policy.json" with { type: "json" };

export type M9PhotoSlot = "COVER_NEWS" | "BODY_NEWS" | "PLAYER_PROFILE";
export type M9PhotoMime = "image/jpeg" | "image/png" | "image/webp";
export type M9ProbeStatus =
  | "VALID" | "LOW_RESOLUTION" | "UNSUPPORTED_FORMAT" | "NOT_AN_IMAGE"
  | "BLOCKED_HOST" | "UNAVAILABLE" | "TOO_LARGE";
export interface M9ImageProbe {
  readonly status: M9ProbeStatus;
  readonly width: number | null;
  readonly height: number | null;
  readonly mime_type: M9PhotoMime | null;
  readonly bytes_read: number;
}
export type M9IdentityEvidence = "ALT_OR_CAPTION_MATCH" | "FILENAME_HINT" | "UNCONFIRMED";
export interface M9PhotoAssessment {
  readonly candidate: PhotoCandidate;
  readonly probe: M9ImageProbe;
  readonly identity_evidence: M9IdentityEvidence;
  readonly is_recent_photo: boolean | null;
  readonly requires_review: true;
  readonly can_auto_publish: false;
  readonly score: number;
  readonly projected_crop_scale: number | null;
  readonly flags: readonly string[];
}
export interface M9PhotoSelection {
  readonly status: "CANDIDATES_FOR_REVIEW" | "NO_SUITABLE_IMAGE";
  readonly subject_aliases: readonly string[];
  readonly slot: M9PhotoSlot;
  readonly selected: M9PhotoAssessment | null;
  readonly shortlist: readonly M9PhotoAssessment[];
  readonly slide_number?: number;
}
export interface M9ProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Explicit trusted publisher/media-CDN hosts; no host = no network request. */
  readonly allowedImageHosts: readonly string[];
}
const BYTE_LIMIT = 131072; // 128 KiB inspection, not a full image download
const MAX_IMAGE_DIMENSION = 16000;
const MAX_DECLARED_CONTENT_LENGTH = 25 * 1024 * 1024;
function result(status: M9ProbeStatus, bytes_read = 0, mime_type: M9PhotoMime | null = null, width: number | null = null, height: number | null = null): M9ImageProbe {
  return {status,bytes_read,mime_type,width,height};
}

export function allowedPhotoImageUrl(value: string, allowedHosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u,"");
    return url.protocol === "https:" && !url.username && !url.password &&
      (!url.port || url.port === "443") && value.length <= 2500 &&
      hostname.includes(".") && !hostname.includes(":") &&
      !/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(hostname) &&
      !/(?:^|\.)(?:localhost|internal|local|test|invalid)$/u.test(hostname) &&
      allowedHosts.some(host => {
        const normalized = host.trim().toLowerCase().replace(/\.$/u,"");
        return normalized === hostname && normalized.includes(".") &&
          !normalized.startsWith(".") && !normalized.includes("*");
      });
  } catch { return false; }
}

function validDimensions(width: number, height: number, mime: M9PhotoMime, read: number): M9ImageProbe {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    return result("NOT_AN_IMAGE", read);
  }
  return result("VALID",read,mime,width,height);
}

/** Pure, header-only parser; PNG, baseline/progressive JPEG and WebP. */
export function inspectImageBytes(bytes: Uint8Array): M9ImageProbe {
  const n=bytes.length;
  const d=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if (n>=24 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v)) {
    return validDimensions(d.getUint32(16,false),d.getUint32(20,false),"image/png",n);
  }
  if (n>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) {
    let at=2;
    while (at+3<n) {
      if (bytes[at]!==255) return result("UNSUPPORTED_FORMAT",n);
      while(at<n && bytes[at]===255)at++;
      if (at>=n) break;
      const marker=bytes[at++]!;
      if (marker===0xD9 || marker===0xDA)break;
      if (marker===0x01 || marker>=0xD0 && marker<=0xD7)continue;
      if (at+1>=n)break;
      const segmentSize=d.getUint16(at,false);
      if (segmentSize<2) return result("NOT_AN_IMAGE",n);
      const isSOF=(marker>=0xC0 && marker<=0xC3) || (marker>=0xC5 && marker<=0xC7) ||
        (marker>=0xC9 && marker<=0xCB) || (marker>=0xCD && marker<=0xCF);
      if (isSOF) {
        if (segmentSize<7 || at+6>=n)return result("NOT_AN_IMAGE",n);
        return validDimensions(d.getUint16(at+5,false),d.getUint16(at+3,false),"image/jpeg",n);
      }
      at+=segmentSize;
    }
    return result("UNSUPPORTED_FORMAT",n);
  }
  const ascii=(offset:number,size:number)=>String.fromCharCode(...bytes.subarray(offset,offset+size));
  if (n>=30 && ascii(0,4)==="RIFF" && ascii(8,4)==="WEBP") {
    const kind=ascii(12,4);
    if (kind==="VP8X" && n>=30) {
      return validDimensions(1+bytes[24]!+(bytes[25]!<<8)+(bytes[26]!<<16),
        1+bytes[27]!+(bytes[28]!<<8)+(bytes[29]!<<16),"image/webp",n);
    }
    if (kind==="VP8 " && n>=30 && bytes[23]===0x9d && bytes[24]===0x01 && bytes[25]===0x2a) {
      return validDimensions(d.getUint16(26,true)&0x3fff,d.getUint16(28,true)&0x3fff,"image/webp",n);
    }
    if (kind==="VP8L" && n>=25 && bytes[20]===0x2f) {
      const w=1+(((bytes[22]!&0x3f)<<8)|bytes[21]!);
      const h=1+(((bytes[24]!&0x0f)<<10)|(bytes[23]!<<2)|((bytes[22]!&0xc0)>>6));
      return validDimensions(w,h,"image/webp",n);
    }
    return result("UNSUPPORTED_FORMAT",n);
  }
  return result("NOT_AN_IMAGE",n);
}

/** Fetches at most 128 KiB. Redirects are rejected to prevent trust-boundary escape. */
export async function probePhotoImage(imageUrl: string, opts: M9ProbeOptions): Promise<M9ImageProbe> {
  if (!allowedPhotoImageUrl(imageUrl,opts.allowedImageHosts))return result("BLOCKED_HOST");
  const fetchImpl=opts.fetch??fetch;
  const controller=new AbortController();
  const timeout=Math.min(8000,Math.max(100,opts.timeoutMs??5000));
  const timer=setTimeout(()=>controller.abort(),timeout);
  let bytesRead=0;
  try {
    const response=await fetchImpl(imageUrl,{
      method:"GET",
      redirect:"manual",
      credentials:"omit",
      referrerPolicy:"no-referrer",
      headers:{accept:"image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8","range":"bytes=0-131071"},
      signal:controller.signal,
    });
    if (!response.ok || response.status>=300 || !response.body)return result("UNAVAILABLE");
    const lengthHeader=response.headers.get("content-length");
    const length=lengthHeader===null?NaN:Number(lengthHeader);
    if (Number.isFinite(length)&&length>MAX_DECLARED_CONTENT_LENGTH)return result("TOO_LARGE");
    const mime=(response.headers.get("content-type")??"").split(";")[0]!.trim().toLowerCase();
    if (mime && mime!=="image/jpeg" && mime!=="image/png" && mime!=="image/webp" && mime!=="application/octet-stream")
      return result("NOT_AN_IMAGE");
    const parts:Uint8Array[]=[];
    const reader=response.body.getReader();
    try {
      while (bytesRead<BYTE_LIMIT) {
        const chunk=await reader.read();
        if (chunk.done)break;
        const take=Math.min(chunk.value.length,BYTE_LIMIT-bytesRead);
        parts.push(chunk.value.subarray(0,take));
        bytesRead+=take;
        if (take<chunk.value.length)break;
      }
    } finally {
      await reader.cancel().catch(()=>{});
      reader.releaseLock();
    }
    const firstBytes=new Uint8Array(bytesRead);
    let offset=0;
    for(const part of parts){firstBytes.set(part,offset);offset+=part.length;}
    const inspection=inspectImageBytes(firstBytes);
    if (inspection.status!=="VALID")return inspection;
    if (mime.startsWith("image/") && inspection.mime_type!==mime)return result("NOT_AN_IMAGE",bytesRead);
    return inspection;
  } catch {return result("UNAVAILABLE",bytesRead);}
  finally {clearTimeout(timer);controller.abort();}
}

/** Text-only association is not proof of visual identity. */
export function matchPhotoSubject(candidate: PhotoCandidate, aliases: readonly string[]): M9IdentityEvidence {
  const normalize=(s:string)=>s.toLocaleLowerCase("en-US").normalize("NFKC")
    .replace(/[_-]+/gu," ").replace(/[^\p{L}\p{N}]+/gu," ").replace(/\s+/gu," ").trim();
  const text=normalize((candidate.caption??"")+" "+(candidate.credit??""));
  const filename=normalize(new URL(candidate.image_url).pathname.split("/").pop()??"");
  const containsAlias=(s:string,a:string)=>s.length>0 && (" "+s+" ").includes(" "+a+" ");
  const validAliases=aliases.map(normalize).filter(x=>x.length>=4);
  if(validAliases.some(a=>containsAlias(text,a)))return "ALT_OR_CAPTION_MATCH";
  if(validAliases.some(a=>containsAlias(filename,a)))return "FILENAME_HINT";
  return "UNCONFIRMED";
}

// Resolution and exact 4:5 crop scale are enforced after the full image reaches
// Python. Keep low-resolution candidates (including >2x cases) in the bounded
// shortlist so the crop gate can report the precise rejection reason.
function isCoverOrBodyUsable(w:number,h:number): boolean {return w>0 && h>0;}
function isProfileUsable(w:number,h:number): boolean {return w>=650 && h>=950;}

/** Effective target enlargement after taking the required 4:5 source crop. */
export function projectedCropScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RangeError("M9_IMAGE_DIMENSIONS_INVALID");
  }
  const targetWidth = cropPolicy.target_width;
  const targetHeight = cropPolicy.target_height;
  const targetAspect = targetWidth / targetHeight;
  const sourceAspect = width / height;
  const cropWidth = sourceAspect > targetAspect ? height * targetAspect : width;
  const cropHeight = sourceAspect > targetAspect ? height : width / targetAspect;
  return Math.max(targetWidth / cropWidth, targetHeight / cropHeight);
}

export function assessPublisherPhoto(
  candidate:PhotoCandidate,probe:M9ImageProbe,subjectAliases:readonly string[],
  slot:M9PhotoSlot,now:Date,
):M9PhotoAssessment {
  const flags:string[]=[];
  const nameEvidence=matchPhotoSubject(candidate,subjectAliases);
  if(nameEvidence==="UNCONFIRMED")flags.push("SUBJECT_NOT_CONFIRMED");
  else if(nameEvidence==="FILENAME_HINT")flags.push("SUBJECT_FILENAME_ONLY");
  else flags.push("SUBJECT_METADATA_MATCH_NOT_VISUAL_PROOF");
  const good=probe.status==="VALID" && probe.width!==null && probe.height!==null &&
    (slot==="PLAYER_PROFILE"?isProfileUsable(probe.width,probe.height):isCoverOrBodyUsable(probe.width,probe.height));
  if(!good)flags.push(probe.status==="VALID"?"INSUFFICIENT_DIMENSIONS":"IMAGE_"+probe.status);
  let isRecent:boolean|null=null;
  if(candidate.image_created_at) {
    const date=Date.parse(candidate.image_created_at);
    if(Number.isFinite(date)) {
      const days=(now.getTime()-date)/86400000;
      isRecent=days>=0&&days<=180;
      if(days>365)flags.push("ARCHIVE_PHOTO");
      else if(days<0)flags.push("FUTURE_PHOTO_DATE");
      else if(!isRecent)flags.push("PHOTO_OVER_180_DAYS");
    }
  }else flags.push("PHOTO_CAPTURE_DATE_UNKNOWN");
  flags.push("REUSE_RIGHTS_UNVERIFIED");
  // Source relevancy is a tie-breaker after actual dimensions and subject evidence.
  const identityScore=nameEvidence==="ALT_OR_CAPTION_MATCH"?38:nameEvidence==="FILENAME_HINT"?15:0;
  const aspect=probe.width&&probe.height?probe.width/probe.height:null;
  const projectedScale=probe.width&&probe.height?projectedCropScale(probe.width,probe.height):null;
  const compositionScore=slot==="PLAYER_PROFILE"?
    (aspect===null?0:aspect<=1?12:0):
    projectedScale===null?0:Math.min(12,Math.max(0,12*(2-projectedScale)));
  const freshness=isRecent===true?12:isRecent===false?-10:0;
  const score=(good?50:-100)+identityScore+compositionScore+freshness+
    Math.min(15,Math.max(0,candidate.score/8))+
    (candidate.origin==="ARTICLE"?7:0);
  return {candidate,probe,identity_evidence:nameEvidence,is_recent_photo:isRecent,
    requires_review:true,can_auto_publish:false,score,projected_crop_scale:projectedScale,flags};
}

export function selectPublisherPhoto(
  candidates:readonly PhotoCandidate[],probes:readonly M9ImageProbe[],
  aliases:readonly string[],slot:M9PhotoSlot,now:Date=new Date(),
):M9PhotoSelection {
  if(candidates.length!==probes.length)throw new Error("M9_PHOTO_PROBE_LENGTH_MISMATCH");
  if(!aliases.length||aliases.every(a=>a.trim().length<4))throw new Error("M9_SUBJECT_NAME_REQUIRED");
  const assessed=candidates.map((candidate,i)=>assessPublisherPhoto(candidate,probes[i]!,aliases,slot,now));
  const usable=assessed.filter(x=>!x.flags.includes("INSUFFICIENT_DIMENSIONS") &&
    x.probe.status==="VALID" && x.identity_evidence!=="UNCONFIRMED" &&
    !x.flags.includes("FUTURE_PHOTO_DATE") &&
    (slot!=="PLAYER_PROFILE"||x.identity_evidence==="ALT_OR_CAPTION_MATCH"));
  usable.sort((a,b)=>b.score-a.score||a.candidate.image_url.localeCompare(b.candidate.image_url));
  return {
    status:usable.length?"CANDIDATES_FOR_REVIEW":"NO_SUITABLE_IMAGE",
    subject_aliases:[...aliases],slot,selected:usable[0]??null,shortlist:usable.slice(0,3),
  };
}

/** Top 8 candidates; preflight in order and never download full image bodies. */
export async function shortlistPublisherPhotos(
  candidates:readonly PhotoCandidate[],aliases:readonly string[],slot:M9PhotoSlot,
  opts:M9ProbeOptions & {now?:Date},
):Promise<M9PhotoSelection> {
  const selected=candidates.slice(0,8);
  const probes: M9ImageProbe[]=[];
  for (const candidate of selected)probes.push(await probePhotoImage(candidate.image_url,opts));
  return selectPublisherPhoto(selected,probes,aliases,slot,opts.now??new Date());
}
