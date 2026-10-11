#!/usr/bin/env python3
"""Derive M9 photo-search inputs from the EXISTING canonical creative brief.

No new football claims, no LLM subject guessing. If the brief is missing
credited publisher URLs or contains multiple competing named subjects, fail
closed and request manual editorial selection. Google News wrappers remain
intact for the existing Deno Google News -> publisher URL resolver.

Trusted photo CDN hosts come ONLY from operator configuration, never from
untrusted article metadata.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

# Conservative fallback for known named football figures when
# app_private.tracked_entities has not yet been configured.
# This is a recognition dictionary, NOT a claim about current team membership.
CURATED_PERSON_ALIASES: dict[str, tuple[str, ...]] = {
    "Sir Alex Ferguson": ("Sir Alex Ferguson", "Alex Ferguson", "알렉스 퍼거슨", "퍼거슨 경", "퍼거슨"),
    "Michael Carrick": ("Michael Carrick", "마이클 캐릭", "캐릭 감독", "캐릭"),
    "Bruno Fernandes": ("Bruno Fernandes", "브루노 페르난데스", "브루노"),
    "Dominic Solanke": ("Dominic Solanke", "도미닉 솔란케", "솔란케"),
    "Bryan Mbeumo": ("Bryan Mbeumo", "브라이언 음뵈모", "음뵈모", "음베우모"),
    "Diogo Dalot": ("Diogo Dalot", "디오구 달로", "달롯", "달로"),
    "Fred": ("Fred", "프레드"),
    "Erik ten Hag": ("Erik ten Hag", "에릭 텐 하흐", "텐 하흐", "텐하흐"),
    "Harry Maguire": ("Harry Maguire", "해리 매과이어", "매과이어"),
    "Kobbie Mainoo": ("Kobbie Mainoo", "코비 마이누", "마이누"),
    "Casemiro": ("Casemiro", "카세미루"),
    "Ruben Amorim": ("Ruben Amorim", "후벵 아모링", "아모림", "아모링"),
    "Amad Diallo": ("Amad Diallo", "아마드 디알로", "아마드"),
    "Alberto Costa": ("Alberto Costa", "알베르토 코스타"),
    "Pep Guardiola": ("Pep Guardiola", "펩 과르디올라", "과르디올라"),
    "Eva Olid": ("Eva Olid", "에바 올리드", "올리드"),
}
ROLES = {"FACT_PRIMARY": 0, "FACT_INDEPENDENT": 1, "OFFICIAL": 2,
         "DISCOVERY_COMMUNITY": 5, "DISCOVERY_OFFICIAL": 3}
SOCIAL_HOSTS = {"instagram.com", "www.instagram.com", "x.com", "twitter.com",
                "www.youtube.com", "youtube.com", "t.me", "www.tiktok.com"}
M9_SLOT_LABELS = ("COVER_NEWS", "BODY_NEWS")

def is_publishable_source_url(value: object) -> bool:
    if not isinstance(value, str) or len(value) > 2000:
        return False
    try:
        url = urlsplit(value)
        host = (url.hostname or "").lower()
        if url.scheme != "https" or not host or "." not in host or \
            url.username or url.password or url.port not in (None,443) or \
            host in SOCIAL_HOSTS or host.endswith(".internal") or \
            host.endswith(".localhost") or ":" in host or \
            re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", host):
            return False
        if host in ("google.com", "www.google.com"):
            return False
        if host == "news.google.com" and not re.match(r"^/(?:rss/)?(?:articles|read)/",url.path):
            return False
        return True
    except ValueError:
        return False

def recognized_people(text: str, registry: dict[str, tuple[str, ...]] | None = None) -> list[str]:
    registry = registry or CURATED_PERSON_ALIASES
    found: list[str] = []
    for canonical, names in registry.items():
        for alias in names:
            if not alias or len(alias.strip()) < 3:
                continue
            # Strict Unicode boundary prevents matching "Fred" inside "Freddie".
            pattern = (r"(?<![^\W_])" + re.escape(alias) +
                       (r"(?=$|[^\w]|[은는이가을를의와과에서도])" if re.search(r"[가-힣]",alias) else r"(?![^\W_])"))
            if re.search(pattern,text,re.IGNORECASE | re.UNICODE):
                found.append(canonical)
                break
    return found

def from_tracked_entities(rows: list[dict[str,Any]]) -> dict[str, tuple[str,...]]:
    registry = dict(CURATED_PERSON_ALIASES)
    for row in rows:
        if row.get("active") is not True or row.get("entity_type") not in ("PLAYER","MANAGER"):
            continue
        name = row.get("canonical_name")
        if not isinstance(name,str) or len(name.strip()) < 4:continue
        aliases = row.get("aliases",[])
        if not isinstance(aliases,list):aliases=[]
        valid = [v for v in aliases if isinstance(v,str) and len(v.strip()) >= 4]
        registry[name] = tuple([name,*valid[:15]])
    return registry

def source_pages(snapshot: dict[str,Any]) -> tuple[list[str],list[str]]:
    sources = snapshot.get("sources")
    if not isinstance(sources,list):
        raise ValueError("M9_BRIEF_SOURCES_MISSING")
    scored:list[tuple[int,int,str,bool]] = []
    for index,source in enumerate(sources):
        if not isinstance(source,dict):continue
        url=source.get("canonical_url")
        if not is_publishable_source_url(url):continue
        publisher = urlsplit(url).hostname or ""
        official = publisher.lower() in ("manutd.com","www.manutd.com")
        priority=ROLES.get(str(source.get("editorial_role")),4)
        scored.append((priority,index,url,official))
    scored.sort()
    news:list[str]=[]
    club:list[str]=[]
    for _,_,url,official in scored:
        dest=club if official else news
        if url not in dest and len(dest)<5:
            dest.append(url)
    if not news and not club:
        raise ValueError("M9_PUBLISHER_ARTICLE_URL_REQUIRED")
    return news,club

def build_request(
    brief:dict[str,Any],allowed_image_hosts:list[str],
    *,tracked_entities:list[dict[str,Any]]|None=None,
) -> dict[str,Any]:
    if not all(isinstance(v,str) and re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}",v) for v in allowed_image_hosts) or not allowed_image_hosts:
        raise ValueError("M9_OPERATOR_IMAGE_HOST_ALLOWLIST_REQUIRED")
    snapshot=brief.get("evidence_snapshot")
    if not isinstance(snapshot,dict):
        raise ValueError("M9_BRIEF_EVIDENCE_MISSING")
    slides_raw=brief.get("slides_json")
    slides=slides_raw.get("slides") if isinstance(slides_raw,dict) else slides_raw
    if not isinstance(slides,list) or len(slides)<2:
        raise ValueError("M9_BRIEF_SLIDES_MISSING")
    registry=from_tracked_entities(tracked_entities or [])
    subjects=[]
    for index in (0,1):
        slide=slides[index]
        if not isinstance(slide,dict):raise ValueError("M9_BRIEF_SLIDES_MISSING")
        direction=slide.get("visual_direction")
        if not isinstance(direction,dict):direction={}
        scene=direction.get("subject") or ""
        if not isinstance(scene,str):scene=""
        recognized=recognized_people(scene,registry)
        # A person named elsewhere in a headline is not proof they appear in a photo.
        # For simple one-person stories only, inherit the named subject from page 1.
        if len(recognized)>1:
            raise ValueError(f"M9_AMBIGUOUS_PHOTO_SUBJECT_PAGE_{index+1}")
        if len(recognized)==0:
            if index==1 and subjects:recognized=[subjects[0]]
            else:raise ValueError(f"M9_PHOTO_SUBJECT_NOT_IDENTIFIED_PAGE_{index+1}")
        subjects.append(recognized[0])
    news,official=source_pages(snapshot)
    return {
        "publisher_article_urls":news,
        "official_article_urls":official,
        "slots":[{"slot":role,"subject_aliases":list(registry[name])}
                 for role,name in zip(M9_SLOT_LABELS,subjects)],
        "allowed_image_hosts":allowed_image_hosts,
        "_provenance":{
            "brief_id":brief.get("id"),
            "subject_names":subjects,
            "source_type":"creative_briefs.evidence_snapshot.sources",
            "requires_human_photo_review":True,
            "auto_publish":False,
        },
    }

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--brief-json",required=True)
    parser.add_argument("--output",required=True)
    parser.add_argument("--allowed-hosts",help="Trusted CDN hosts, comma-separated. Defaults to M9_APPROVED_IMAGE_HOSTS.")
    args=parser.parse_args()
    hosts=(args.allowed_hosts or os.getenv("M9_APPROVED_IMAGE_HOSTS") or "").split(",")
    hosts=[x.strip().lower() for x in hosts if x.strip()]
    brief=json.loads(Path(args.brief_json).read_text(encoding="utf-8"))
    request=build_request(brief,hosts)
    Path(args.output).write_text(json.dumps(request,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps({"status":"REQUEST_READY","sources":len(request["publisher_article_urls"]),
                      "subjects":request["_provenance"]["subject_names"]},ensure_ascii=False))

if __name__=="__main__":
    main()
