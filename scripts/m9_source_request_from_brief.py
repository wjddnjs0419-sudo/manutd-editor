#!/usr/bin/env python3
"""Derive M9 photo-search inputs from the EXISTING canonical creative brief.

No new football claims, no LLM subject guessing. If the brief is missing
credited publisher URLs or contains multiple competing named subjects, fail
closed and request manual editorial selection. Google News wrappers remain
provenance only; photo discovery requires an already resolved publisher URL.

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
from m9_content_policy import ordered_content_slides

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
                "www.youtube.com", "youtube.com", "youtu.be", "m.youtube.com",
                "t.me", "www.tiktok.com"}
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
        if host == "google.com" or host.endswith(".google.com") or host.startswith("google.") or host.endswith(".googleusercontent.com"):
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
    sources = list(sources)
    articles = snapshot.get("exploration_articles")
    if isinstance(articles, list):
        for article in articles:
            if not isinstance(article, dict):
                continue
            sources.append({
                "canonical_url": article.get("canonical_url"),
                "canonical_name": article.get("publisher_name"),
                "editorial_role": "DISCOVERY_COMMUNITY",
            })
    scored:list[tuple[int,int,str,bool]] = []
    for index,source in enumerate(sources):
        if not isinstance(source,dict):continue
        metadata=source.get("metadata") if isinstance(source.get("metadata"),dict) else {}
        url=(source.get("resolved_publisher_url") or metadata.get("resolved_publisher_url")
             or source.get("canonical_url"))
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
    numbered_slides = ordered_content_slides(slides)
    if len(numbered_slides) != len(slides) or len(numbered_slides) > 6:
        raise ValueError("M9_BRIEF_SLIDE_COUNT_INVALID")
    first_page_subjects: list[str] | None = None
    slots=[]
    for index, slide in enumerate(numbered_slides):
        if not isinstance(slide,dict):raise ValueError("M9_BRIEF_SLIDES_MISSING")
        # Photo jobs use canonical rendered order: HOOK first, then the other
        # content in saved index order, regardless of stale slide_number values.
        slide_number = index + 1
        direction=slide.get("visual_direction")
        if not isinstance(direction,dict):direction={}
        scene=direction.get("subject") or ""
        if not isinstance(scene,str):scene=""
        recognized=recognized_people(scene,registry)
        # A person named elsewhere in a headline is not proof they appear in a photo.
        # Keep the existing page-1 fallback, inheriting its full named subject group.
        if len(recognized)==0:
            if index > 0 and first_page_subjects:recognized=list(first_page_subjects)
            else:raise ValueError(f"M9_PHOTO_SUBJECT_NOT_IDENTIFIED_PAGE_{index+1}")
        if len(recognized)>6:
            raise ValueError(f"M9_PHOTO_SUBJECT_COUNT_INVALID_PAGE_{index+1}")
        if index == 0:
            first_page_subjects=list(recognized)
        role = "COVER_NEWS" if index == 0 else "BODY_NEWS"
        subject_alias_groups = []
        for canonical_name in recognized:
            aliases = list(dict.fromkeys([
                canonical_name,
                *[alias for alias in registry[canonical_name] if len(alias.strip()) >= 4],
            ]))[:6]
            subject_alias_groups.append({"canonical_name": canonical_name, "aliases": aliases})
        flat_aliases = list(recognized)
        flat_aliases.extend(
            alias
            for group in subject_alias_groups
            for alias in group["aliases"]
            if alias != group["canonical_name"]
        )
        slots.append({
            "slot": role,
            "slide_number": slide_number,
            "content_role": str(slide.get("role") or ("HOOK" if index == 0 else "BODY")).strip().upper(),
            # Retain the legacy flat field for older readers. New collectors use
            # the grouped field so aliases for different people aren't confused.
            "subject_aliases": list(dict.fromkeys(flat_aliases))[:6],
            "subject_alias_groups": subject_alias_groups,
        })
    news,official=source_pages(snapshot)
    google_original_urls=[]
    for source in snapshot.get("sources",[]):
        if not isinstance(source,dict):continue
        metadata=source.get("metadata") if isinstance(source.get("metadata"),dict) else {}
        original=source.get("google_news_original_url") or metadata.get("google_news_original_url") or metadata.get("google_news_url")
        if isinstance(original,str) and original.startswith("https://news.google.com/rss/articles/") and original not in google_original_urls:
            google_original_urls.append(original)
    return {
        "publisher_article_urls":news,
        "official_article_urls":official,
        "slots":slots,
        "allowed_image_hosts":allowed_image_hosts,
        "_provenance":{
            "brief_id":brief.get("id"),
            "subject_names":[
                group["canonical_name"]
                for slot in slots
                for group in slot["subject_alias_groups"]
            ],
            "source_type":"creative_briefs.evidence_snapshot.sources_and_exploration_articles",
            "google_news_original_urls":google_original_urls[:20],
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
