import {assertEquals,assertRejects} from "jsr:@std/assert@1.0.8";
import {harvestArticlePhotos} from "../../_shared/m9/photo_harvest.ts";

function png(w:number,h:number):ArrayBuffer {
  const b=new Uint8Array(33);
  b.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82],0);
  const d=new DataView(b.buffer);d.setUint32(16,w);d.setUint32(20,h);
  return b.buffer;
}
const news='<html><head>'+
'<meta property="og:image" content="https://cdn.example.org/bruno-fernandes-news.jpg">'+
'<meta property="og:image:alt" content="Bruno Fernandes celebrates at Old Trafford">'+
'<meta property="og:image:width" content="1600"><meta property="og:image:height" content="900">'+
'<meta property="article:published_time" content="2026-10-11T07:00:00Z">'+
'</head></html>';
const official='<html><head><script type="application/ld+json">'+
'{"@type":"NewsArticle","image":{"contentUrl":"https://cdn.example.org/bruno-fernandes-portrait.png","width":1200,"height":1600,"caption":"Bruno Fernandes full-body portrait","dateCreated":"2026-10-10"}}'+
'</script></head></html>';

Deno.test("harvests article and official photos and selects the stronger cover crop",async()=>{
 const requests:string[]=[];
 const out=await harvestArticlePhotos({
   publisher_article_urls:["https://sports.example.org/bruno"],
   official_article_urls:["https://www.manutd.com/en/news/bruno"],
   slots:[
     {slot:"COVER_NEWS",slide_number:1,subject_aliases:["Bruno Fernandes"]},
     {slot:"PLAYER_PROFILE",slide_number:2,subject_aliases:["Bruno Fernandes"]},
   ],
 },{
   allowedImageHosts:["cdn.example.org"],now:new Date("2026-10-11T14:00:00Z"),
   fetch:async(url)=>{
     const u=String(url);
     requests.push(u);
     if(u.includes("/en/news/bruno"))return new Response(official,{status:200,headers:{"content-type":"text/html"}});
     if(u.endsWith("/bruno"))return new Response(news,{status:200,headers:{"content-type":"text/html"}});
     if(u.includes("-news.jpg"))return new Response(png(1600,900),{status:200,headers:{"content-type":"image/png"}});
     if(u.includes("-portrait.png"))return new Response(png(1200,1600),{status:200,headers:{"content-type":"image/png"}});
     throw new Error("Unexpected URL "+u);
   },
 });
 assertEquals(out.status,"CANDIDATES_FOR_REVIEW");
 assertEquals(out.candidate_count,2);
 assertEquals(out.probed_count,2);
 assertEquals(out.selections.length,2);
 assertEquals(out.selections.map(selection=>selection.slide_number),[1,2]);
 assertEquals(out.selections[0]?.selected?.candidate.origin,"OFFICIAL_CLUB");
 assertEquals(out.selections[0]?.selected?.projected_crop_scale,0.9);
 assertEquals(out.selections[1]?.selected?.candidate.origin,"OFFICIAL_CLUB");
 assertEquals(out.selections[1]?.selected?.probe.height,1600);
 assertEquals(requests.length,4);
 assertEquals(out.publication_allowed,false);
 assertEquals(out.rights_status,"UNVERIFIED");
});
Deno.test("fails safely with unclear player caption and no image downloads",async()=>{
 let imageRequests=0;
 const r=await harvestArticlePhotos({
   publisher_article_urls:["https://sports.example.org/bruno"],
   slots:[{slot:"COVER_NEWS",subject_aliases:["Casemiro"]}],
 },{
   allowedImageHosts:["cdn.example.org"],
   fetch:async(url)=>{
     if(String(url).includes("cdn.example.org"))imageRequests++;
     return new Response(news,{status:200,headers:{"content-type":"text/html"}});
   },
 });
 assertEquals(r.candidate_count,1);
 assertEquals(r.probed_count,0);
 assertEquals(r.status,"NO_SUITABLE_IMAGE");
 assertEquals(imageRequests,0);
});
Deno.test("host policy blocks untrusted image CDN while preserving source record",async()=>{
 const r=await harvestArticlePhotos({
   publisher_article_urls:["https://sports.example.org/bruno"],
   slots:[{slot:"COVER_NEWS",subject_aliases:["Bruno Fernandes"]}],
 },{
   allowedImageHosts:["static.manutd.com"],
   fetch:async(url)=>{
     if(String(url).includes("cdn.example.org"))throw new Error("blocked domain accessed");
     return new Response(news,{status:200,headers:{"content-type":"text/html"}});
   },
 });
 assertEquals(r.candidate_count,1);
 assertEquals(r.probed_count,1);
 assertEquals(r.status,"NO_SUITABLE_IMAGE");
});
Deno.test("invalid slot request fails closed",async()=>{
 await assertRejects(()=>harvestArticlePhotos({publisher_article_urls:[],slots:[]},{
   allowedImageHosts:["cdn.example.org"],
 }),Error,"M9_PHOTO_SLOTS_REQUIRED");
});
