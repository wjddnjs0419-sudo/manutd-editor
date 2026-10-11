/**
 * Recover high-resolution real photos from original publisher image srcsets.
 * Some publishers expose low-res social thumbnails via og:image but embed
 * signed 1920px in-article photo URLs with caption and photo agency credit.
 * Never fabricate or alter signed URLs; discovery != redistribution rights.
 */
export interface ResponsivePhoto {
  readonly url: string;
  readonly width: number | null;
  readonly caption: string | null;
  readonly credit: string | null;
}
function decode(value: string): string {
  return value.replace(/&amp;/giu,"&").replace(/&quot;/giu,'"').replace(/\\u0026/giu,"&").replace(/\\\//gu,"/");
}
function safeString(value: string | undefined): string | null {
  if (!value) return null;
  const normalized=decode(value).replace(/<[^>]+>/gu," ").replace(/\s+/gu," ").trim();
  return normalized?normalized.slice(0,240):null;
}
function parseSrcset(value:string):Array<{url:string;width:number}> {
  const results:Array<{url:string;width:number}>=[];
  for(const match of value.matchAll(/(https:\/\/[^\s"'<>]+?)\s+(\d{2,5})w(?:,|$)/gu)) {
    const width=Number(match[2]);
    if(Number.isInteger(width)&&width>=300&&width<=10000) {
      results.push({url:decode(match[1]!),width});
    }
  }
  return results;
}
function bestVariant(srcset:string):{url:string;width:number}|null {
  const variants=parseSrcset(srcset).filter(x=>!/[<>]/u.test(x.url));
  return variants.sort((a,b)=>b.width-a.width)[0]??null;
}
function attr(tag:string,name:string):string|null {
  const pattern=new RegExp("(?:\\s|^)"+name+"\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)')","iu");
  const match=pattern.exec(tag);
  return match?decode(match[1]??match[2]??""):null;
}
/** Parse serialized publisher media blocks plus generic HTML image srcsets. */
export function extractResponsivePublisherPhotos(html:string):ResponsivePhoto[] {
  const photos:ResponsivePhoto[]=[];
  const input=html.slice(0,650000);
  const jsonPattern=/"caption":"([^"]{0,1800})","credit":"([^"]{0,700})","displayCredit":(?:true|false),"src":"([^"]{0,3000})","srcsets":"([^"]{0,18000})"/gu;
  for(const match of input.matchAll(jsonPattern)){
    const best=bestVariant(match[4]??"");
    if(best){
      photos.push({url:best.url,width:best.width,
        caption:safeString(match[1]),credit:safeString(match[2])});
      if(photos.length>=12)break;
    }
  }
  for(const element of input.matchAll(/<(?:img|source)\b[^>]{0,18000}>/giu)){
    if(photos.length>=20)break;
    const tag=element[0],srcset=attr(tag,"srcset");
    if(!srcset)continue;
    const best=bestVariant(srcset);
    if(best){
      photos.push({url:best.url,width:best.width,
        caption:safeString(attr(tag,"alt")??undefined),credit:null});
    }
  }
  const seen=new Set<string>();
  return photos.filter(p=>{
    if(seen.has(p.url))return false;
    seen.add(p.url);return true;
  }).slice(0,20);
}
