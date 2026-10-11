
import { assertEquals, assert } from "jsr:@std/assert@1.0.8";
import { extractPublisherImages, collectPublisherImages } from "../../_shared/m9/article_photo_candidates.ts";
const html = '<html><head><meta property="og:image" content="https://news.example.com/og.jpg"><meta property="og:image:width" content="1600"><meta property="og:image:height" content="900"><meta property="article:published_time" content="2026-10-11T11:00:00Z"><script type="application/ld+json">{"@type":"NewsArticle","image":{"url":"https://news.example.com/dalot.jpg","creditText":"Photographer A","width":2000,"height":1300,"dateCreated":"2026-10-10"}}</script></head><body><figure><img src="/pic.jpg" width="800" height="1000" alt="Dalot"><figcaption>Photographer B</figcaption></figure></body></html>';
Deno.test("original publisher images extracted with provenance and no implicit rights",()=>{
 const c=extractPublisherImages(html,"https://news.example.com/article");
 assertEquals(c.length,3);
 assertEquals(c[0]?.image_url,"https://news.example.com/dalot.jpg");
 assertEquals(c[0]?.credit,"Photographer A");
 assertEquals(c[0]?.image_created_at?.slice(0,10),"2026-10-10");
 assertEquals(c[1]?.discovery_method,"OG_IMAGE");
 assertEquals(c[2]?.image_url,"https://news.example.com/pic.jpg");
 assert(c.every(x=>x.rights_status==="UNVERIFIED"));
});
Deno.test("rejects unsafe URLs and never fabricates photos",()=>{
 assertEquals(extractPublisherImages('<meta property="og:image" content="http://127.0.0.1/a.jpg">',"https://news.example.com/a"),[]);
 assertEquals(extractPublisherImages(html,"http://news.example.com/a"),[]);
 assertEquals(extractPublisherImages("<html>no photos</html>","https://news.example.com/a"),[]);
});
Deno.test("article pages have priority over official fallback pages",async()=>{
 const urls:string[]=[];
 const c=await collectPublisherImages([
 {url:"https://news.example.com/a",origin:"ARTICLE"},
 {url:"https://www.manutd.com/en/news/article",origin:"OFFICIAL_CLUB"}
 ],{fetch:async(input)=>{urls.push(String(input));return new Response(
 String(input).includes("manutd.com")?'<meta property="og:image" content="https://media.manutd.com/now.jpg">':html,
 {status:200});}});
 assertEquals(urls.length,2);
 assertEquals(c[0]?.origin,"ARTICLE");
 assertEquals(c.at(-1)?.origin,"OFFICIAL_CLUB");
});
