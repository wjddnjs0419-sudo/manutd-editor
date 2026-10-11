import {assert,assertEquals} from "jsr:@std/assert@1.0.8";
import {extractResponsivePublisherPhotos} from "../../_shared/m9/responsive_media.ts";
import {extractPublisherImages} from "../../_shared/m9/article_photo_candidates.ts";
const guardianStyle = [
'<html><head><meta property="og:image" content="https://i.guim.co.uk/img/media/a/master.jpg?width=1200&amp;height=630&amp;s=social">',
'</head><body><script>',
'{"images":[{"caption":"Michael Carrick reflects on the late equaliser","credit":"Photograph: Phil Noble/Reuters","displayCredit":true,"src":"https://i.guim.co.uk/img/media/a/master.jpg?width=700&quality=85&s=small","srcsets":"https://i.guim.co.uk/img/media/a/master.jpg?width=1920&quality=85&fit=max&s=big 1920w, https://i.guim.co.uk/img/media/a/master.jpg?width=1225&s=mid 1225w"}]}',
'</script></body></html>',
].join("");
Deno.test("publisher srcsets choose genuine larger signed URL and preserve credits",()=>{
 const result=extractResponsivePublisherPhotos(guardianStyle);
 assertEquals(result.length,1);
 assertEquals(result[0]?.width,1920);
 assertEquals(result[0]?.url,"https://i.guim.co.uk/img/media/a/master.jpg?width=1920&quality=85&fit=max&s=big");
 assertEquals(result[0]?.caption,"Michael Carrick reflects on the late equaliser");
 assertEquals(result[0]?.credit,"Photograph: Phil Noble/Reuters");
});
Deno.test("metadata candidate ranking selects Guardian 1920 photo above 1200x630 social crop",()=>{
 const rows=extractPublisherImages(guardianStyle,"https://www.theguardian.com/football/2026/oct/10/manchester-united");
 assert(rows.length>=2);
 assertEquals(rows[0]?.discovery_method,"RESPONSIVE_SRCSET");
 assertEquals(rows[0]?.credit,"Photograph: Phil Noble/Reuters");
 assertEquals(rows[0]?.width,1920);
 assertEquals(rows[0]?.rights_status,"UNVERIFIED");
});
Deno.test("HTML img srcset picks largest without manufacturing filenames",()=>{
 const html='<img srcset="https://cdn.example.org/pic.jpg?w=600 600w, https://cdn.example.org/pic.jpg?w=1800 1800w" alt="Bruno Fernandes">';
 const rows=extractResponsivePublisherPhotos(html);
 assertEquals(rows[0]?.url,"https://cdn.example.org/pic.jpg?w=1800");
 assertEquals(rows[0]?.width,1800);
 assertEquals(rows[0]?.caption,"Bruno Fernandes");
});
Deno.test("invalid and empty srcsets do not create candidates",()=>{
 assertEquals(extractResponsivePublisherPhotos("<html><img src='https://a.example/a.jpg'></html>"),[]);
});
