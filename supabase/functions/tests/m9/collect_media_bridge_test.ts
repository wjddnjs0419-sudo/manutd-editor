import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.8";
import { collectM9ForWorker, validateM9SourceRequest } from "../../../../scripts/m9_collect_media.ts";

const request={
 publisher_article_urls:["https://publisher.example.org/article"],
 official_article_urls:["https://www.manutd.com/en/news/relevant"],
 allowed_image_hosts:["i.guim.co.uk","media.manutd.com"],
 slots:[
  {slot:"COVER_NEWS",subject_aliases:["Michael Carrick"]},
  {slot:"BODY_NEWS",subject_aliases:["Dominic Solanke"]},
 ],
};
Deno.test("accepts explicit trusted publisher URLs with two different photo subjects",()=>{
 const r=validateM9SourceRequest(request);
 assertEquals(r.job.slots.map(x=>x.slot),["COVER_NEWS","BODY_NEWS"]);
 assertEquals(r.allowed_image_hosts,["i.guim.co.uk","media.manutd.com"]);
});
Deno.test("refuses implicit CDN allowlist, missing subject or extra photo slot",()=>{
 assertThrows(()=>validateM9SourceRequest({...request,allowed_image_hosts:[]}),Error,"M9_TRUSTED_IMAGE_HOSTS_REQUIRED");
 assertThrows(()=>validateM9SourceRequest({...request,slots:[request.slots[0]]}),Error,"M9_SUBJECT_ALIASES_INVALID");
 assertThrows(()=>validateM9SourceRequest({...request,slots:[
  {slot:"COVER_NEWS",subject_aliases:[]},request.slots[1],
 ]}),Error,"M9_SUBJECT_ALIASES_INVALID");
});
Deno.test("refuses insecure article URLs and malformed image CDN hosts",()=>{
 assertThrows(()=>validateM9SourceRequest({...request,publisher_article_urls:["http://publisher.example.org/a"]}),Error,"M9_SOURCE_URLS_INVALID");
 assertThrows(()=>validateM9SourceRequest({...request,publisher_article_urls:["https://news.google.com/rss/articles/article-id"]}),Error,"M9_SOURCE_URLS_INVALID");
 assertThrows(()=>validateM9SourceRequest({...request,publisher_article_urls:["https://google.co.uk/search?q=story"]}),Error,"M9_SOURCE_URLS_INVALID");
 assertThrows(()=>validateM9SourceRequest({...request,official_article_urls:["https://youtu.be/video-id"]}),Error,"M9_SOURCE_URLS_INVALID");
 assertThrows(()=>validateM9SourceRequest({...request,allowed_image_hosts:["*.example.org"]}),Error,"M9_TRUSTED_IMAGE_HOSTS_REQUIRED");
});
Deno.test("M9 keeps Google discovery provenance beside the publisher URL",async()=>{
 const original="https://news.google.com/rss/articles/article-id";
 const result=await collectM9ForWorker({...request,google_news_original_urls:[original]}, {
  fetch:async()=>new Response("<html><body>No article images</body></html>"),
 });
 assertEquals(result.source_provenance,{
  publisher_article_urls:request.publisher_article_urls,
  google_news_original_urls:[original],
  source_type:"creative_briefs.evidence_snapshot.sources",
 });
});
