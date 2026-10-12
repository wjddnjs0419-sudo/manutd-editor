import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.8";
import {
  inspectImageBytes,allowedPhotoImageUrl,probePhotoImage,matchPhotoSubject,matchPhotoSubjectGroups,
  selectPublisherPhoto,shortlistPublisherPhotos,projectedCropScale,
} from "../../_shared/m9/photo_quality.ts";
import type { PhotoCandidate } from "../../_shared/m9/article_photo_candidates.ts";

function png(width:number,height:number):Uint8Array {
  const b=new Uint8Array(33);
  b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82],0);
  const d=new DataView(b.buffer);d.setUint32(16,width);d.setUint32(20,height);
  return b;
}
function jpg(width:number,height:number):Uint8Array {
  return new Uint8Array([
    0xff,0xd8,0xff,0xe0,0,4,0,0,
    0xff,0xc0,0,17,8,(height>>8)&255,height&255,(width>>8)&255,width&255,
    3,1,0x11,0,2,0x11,0,3,0x11,0,0xff,0xd9,
  ]);
}
function webpX(width:number,height:number):Uint8Array {
  const b=new Uint8Array(30);
  b.set(new TextEncoder().encode("RIFF"),0);
  b.set(new TextEncoder().encode("WEBP"),8);
  b.set(new TextEncoder().encode("VP8X"),12);
  const w=width-1,h=height-1;
  b.set([w&255,(w>>8)&255,(w>>16)&255,h&255,(h>>8)&255,(h>>16)&255],24);
  return b;
}
function candidate(fields:Partial<PhotoCandidate>={}):PhotoCandidate {
  return {
    image_url:"https://images.example.org/bruno-fernandes-match.jpg",
    article_url:"https://sports.example.org/bruno-transfer-report",
    origin:"ARTICLE",discovery_method:"OG_IMAGE",
    width:2000,height:1300,caption:"Bruno Fernandes before kick-off",
    credit:"Agency photographer",article_published_at:"2026-10-11T06:00:00.000Z",
    image_created_at:"2026-10-10T13:00:00.000Z",
    rights_status:"UNVERIFIED",score:90,...fields,
  };
}
const valid=(width:number,height:number)=>({
  status:"VALID" as const,width,height,mime_type:"image/jpeg" as const,bytes_read:80000,
});
Deno.test("PNG/JPEG/WebP probes read source dimensions without decoding entire image",()=>{
  assertEquals(inspectImageBytes(png(1800,1200)).width,1800);
  assertEquals(inspectImageBytes(png(1800,1200)).height,1200);
  assertEquals(inspectImageBytes(jpg(1600,1234)).width,1600);
  assertEquals(inspectImageBytes(jpg(1600,1234)).height,1234);
  assertEquals(inspectImageBytes(webpX(1080,1350)).width,1080);
  assertEquals(inspectImageBytes(webpX(1080,1350)).height,1350);
  assertEquals(inspectImageBytes(new TextEncoder().encode("<html></html>")).status,"NOT_AN_IMAGE");
});
Deno.test("rejects unapproved hosts, redirects, and non-images with no unbounded fetch",async()=>{
  let calls=0;
  const fake:typeof fetch=async()=>{
    calls++;
    return new Response(png(1500,1100).buffer as ArrayBuffer,{status:200,headers:{"content-type":"image/png"}});
  };
  assertEquals(allowedPhotoImageUrl("https://evil.example.com/a.jpg",["images.example.org"]),false);
  assertEquals(allowedPhotoImageUrl("http://images.example.org/a.jpg",["images.example.org"]),false);
  assertEquals(allowedPhotoImageUrl("https://images.example.org/a.jpg",["images.example.org"]),true);
  assertEquals(allowedPhotoImageUrl("https://images.example.org.evil.org/a.jpg",["images.example.org"]),false);
  assertEquals((await probePhotoImage("https://evil.example.com/a.jpg",{allowedImageHosts:["images.example.org"],fetch:fake})).status,"BLOCKED_HOST");
  assertEquals(calls,0);
  const r=await probePhotoImage("https://images.example.org/a.jpg",{allowedImageHosts:["images.example.org"],fetch:fake});
  assertEquals(r.status,"VALID");assertEquals(r.width,1500);assertEquals(r.height,1100);
  assertEquals(calls,1);
  const rejected=await probePhotoImage("https://images.example.org/a.jpg",{
    allowedImageHosts:["images.example.org"],
    fetch:async()=>new Response(null,{status:302,headers:{location:"https://local.internal/image.png"}}),
  });
  assertEquals(rejected.status,"UNAVAILABLE");
  const wrongType=await probePhotoImage("https://images.example.org/a.jpg",{
    allowedImageHosts:["images.example.org"],
    fetch:async()=>new Response("<html/>",{headers:{"content-type":"text/html"}}),
  });
  assertEquals(wrongType.status,"NOT_AN_IMAGE");
});
Deno.test("subject matching is text evidence, not visual identity verification",()=>{
  assertEquals(matchPhotoSubject(candidate(),["Bruno Fernandes"]),"ALT_OR_CAPTION_MATCH");
  assertEquals(matchPhotoSubject(candidate({caption:null}),["Bruno Fernandes"]),"FILENAME_HINT");
  assertEquals(matchPhotoSubject(candidate({caption:"Another footballer",image_url:"https://images.example.org/stock-photo.jpg"}),["Bruno Fernandes"]),"UNCONFIRMED");
  const groups=[
    {canonical_name:"Bryan Mbeumo",aliases:["Bryan Mbeumo"]},
    {canonical_name:"Dominic Solanke",aliases:["Dominic Solanke"]},
  ];
  const partial=matchPhotoSubjectGroups(candidate({caption:"Bryan Mbeumo celebrates"}),groups);
  assertEquals(partial.coverage,"PARTIAL");
  assertEquals(partial.metadata_matched_subjects,["Bryan Mbeumo"]);
  const full=matchPhotoSubjectGroups(candidate({caption:"Bryan Mbeumo and Dominic Solanke"}),groups);
  assertEquals(full.coverage,"FULL");
  assertEquals(full.metadata_matched_subjects,["Bryan Mbeumo","Dominic Solanke"]);
  const selected=selectPublisherPhoto([
    candidate({image_url:"https://images.example.org/partial.jpg",caption:"Bryan Mbeumo celebrates"}),
    candidate({image_url:"https://images.example.org/full.jpg",caption:"Bryan Mbeumo and Dominic Solanke"}),
  ],[valid(2000,1300),valid(2000,1300)],
  ["Bryan Mbeumo","Dominic Solanke"],"BODY_NEWS",new Date("2026-10-11T12:00:00Z"),groups);
  assertEquals(selected.selected?.candidate.image_url,"https://images.example.org/full.jpg");
  assertEquals(selected.selected?.subject_match.coverage,"FULL");
});
Deno.test("selects current subject-relevant article photo and flags reuse rights",()=>{
  const c=[
    candidate({image_url:"https://images.example.org/old.jpg",caption:"Bruno Fernandes in 2021",image_created_at:"2021-01-01T00:00:00Z"}),
    candidate({image_url:"https://images.example.org/current.jpg"}),
    candidate({image_url:"https://images.example.org/wrong.jpg",caption:"Different footballer"}),
    candidate({image_url:"https://images.example.org/tiny.jpg"}),
  ];
  const probes=[valid(1500,1000),valid(2200,1400),valid(1500,1000),valid(400,300)];
  const picked=selectPublisherPhoto(c,probes,["Bruno Fernandes"],"COVER_NEWS",new Date("2026-10-11T12:00:00Z"));
  assertEquals(picked.status,"CANDIDATES_FOR_REVIEW");
  assertEquals(picked.selected?.candidate.image_url,"https://images.example.org/current.jpg");
  assertEquals(picked.selected?.can_auto_publish,false);
  assertEquals(picked.selected?.requires_review,true);
  assert(picked.selected?.flags.includes("REUSE_RIGHTS_UNVERIFIED"));
  assertEquals(picked.shortlist.length,3);
  assert(picked.shortlist.some(x=>x.candidate.image_url==="https://images.example.org/tiny.jpg"));
  assert((picked.shortlist.find(x=>x.candidate.image_url.endsWith("tiny.jpg"))?.projected_crop_scale ?? 0)>2);
});
Deno.test("unknown subject never becomes automatically selected",()=>{
  const selected=selectPublisherPhoto([candidate({caption:"Unrelated photo",image_url:"https://images.example.org/a.jpg"})],[valid(2000,1500)],["Bruno Fernandes"],"PLAYER_PROFILE");
  assertEquals(selected.status,"NO_SUITABLE_IMAGE");
  assertEquals(selected.selected,null);
});
Deno.test("shortlist probes the real image bytes and respects host allowlist",async()=>{
  const c=[candidate({image_url:"https://images.example.org/bruno-fernandes.jpg"})];
  const selected=await shortlistPublisherPhotos(c,["Bruno Fernandes"],"COVER_NEWS",{
    allowedImageHosts:["images.example.org"],
    now:new Date("2026-10-11T12:00:00Z"),
    fetch:async(_input,init)=>{
      assertEquals(init?.redirect,"manual");
      assertEquals(new Headers(init?.headers).get("range"),"bytes=0-131071");
      return new Response(jpg(2000,1300).buffer as ArrayBuffer,{status:206,headers:{"content-type":"image/jpeg"}});
    },
  });
  assertEquals(selected.status,"CANDIDATES_FOR_REVIEW");
  assertEquals(selected.selected?.probe.width,2000);
  assertEquals(selected.selected?.probe.height,1300);
});
Deno.test("bad probe vector lengths rejected, no fake successful results",()=>{
  let threw=false;
  try {selectPublisherPhoto([candidate()],[],["Bruno Fernandes"],"COVER_NEWS");}catch{threw=true;}
  assertEquals(threw,true);
  assertEquals(selectPublisherPhoto([candidate()],[{status:"UNAVAILABLE",bytes_read:0,mime_type:null,width:null,height:null}],["Bruno Fernandes"],"COVER_NEWS").status,"NO_SUITABLE_IMAGE");
});

Deno.test("landscape 1600x900 projects to 1.5x for the 4:5 crop",()=>{
  assertEquals(projectedCropScale(1600,900),1.5);
});

Deno.test("portrait 1.5x and over-2x candidates remain visible to Python crop gates",()=>{
  const candidates=[
    candidate({image_url:"https://images.example.org/portrait-720.jpg"}),
    candidate({image_url:"https://images.example.org/tiny-512.jpg"}),
  ];
  const selected=selectPublisherPhoto(candidates,[valid(720,900),valid(512,640)],
    ["Bruno Fernandes"],"COVER_NEWS",new Date("2026-10-11T12:00:00Z"));
  assertEquals(selected.status,"CANDIDATES_FOR_REVIEW");
  assertEquals(selected.shortlist.length,2);
  assertEquals(selected.shortlist.find(x=>x.candidate.image_url.endsWith("portrait-720.jpg"))?.projected_crop_scale,1.5);
  assert((selected.shortlist.find(x=>x.candidate.image_url.endsWith("tiny-512.jpg"))?.projected_crop_scale ?? 0)>2);
});

Deno.test("native 1080x1350 projects to 1x",()=>{
  assertEquals(projectedCropScale(1080,1350),1);
});

Deno.test("candidate ranking rewards projected crop fit instead of landscape orientation",()=>{
  const landscape=candidate({image_url:"https://images.example.org/landscape.jpg",score:80});
  const portrait=candidate({image_url:"https://images.example.org/portrait.jpg",score:80});
  const selected=selectPublisherPhoto(
    [landscape,portrait],[valid(1600,900),valid(960,1200)],
    ["Bruno Fernandes"],"COVER_NEWS",new Date("2026-10-11T12:00:00Z"),
  );
  assertEquals(selected.selected?.candidate.image_url,"https://images.example.org/portrait.jpg");
  assertEquals(selected.shortlist[0]?.projected_crop_scale,1.125);
  assertEquals(selected.shortlist[1]?.projected_crop_scale,1.5);
});
