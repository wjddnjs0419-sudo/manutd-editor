"""M9 auto-input tests: real creative_briefs evidence shapes, no guessing."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_source_request_from_brief import build_request, recognized_people

def brief(cover="알렉스 퍼거슨 경의 올드 트래퍼드 복귀 장면",
          body="퍼거슨 경의 차분한 클로즈업"):
    return {
        "id": "17bf0000-0000-4000-8000-123456781234",
        "slides_json":{"slides":[
            {"slide_number":1,"visual_direction":{"subject":cover}},
            {"slide_number":2,"visual_direction":{"subject":body}},
        ]},
        "evidence_snapshot":{"sources":[
            {"canonical_url":"https://news.google.com/rss/articles/CBM123456789ABCD","resolved_publisher_url":"https://www.bbc.com/sport/football/united","google_news_original_url":"https://news.google.com/rss/articles/CBM123456789ABCD","editorial_role":"DISCOVERY_COMMUNITY"},
            {"canonical_url":"https://www.theguardian.com/football/2026/oct/10/match-report","editorial_role":"FACT_PRIMARY"},
            {"canonical_url":"https://www.manutd.com/en/news/detail/ferguson","editorial_role":"OFFICIAL"},
            {"canonical_url":"https://instagram.com/example","editorial_role":"DISCOVERY_COMMUNITY"},
            {"canonical_url":"http://unsafe.example.com/a","editorial_role":"FACT_PRIMARY"},
        ]},
    }

class BriefToRequest(unittest.TestCase):
    def test_hook_role_and_content_index_define_photo_slot_order(self):
        value = brief()
        value["slides_json"]["slides"] = [
            {"slide_number": 1, "index": 2, "role": "KEY_FACT",
             "visual_direction": {"subject": "브루노 페르난데스의 경기 장면"}},
            {"slide_number": 2, "index": 3, "role": "CONTEXT",
             "visual_direction": {"subject": "마이클 캐릭 감독의 인터뷰"}},
            {"slide_number": 3, "index": 1, "role": "HOOK",
             "visual_direction": {"subject": "알렉스 퍼거슨 감독의 복귀 장면"}},
        ]
        result = build_request(value, ["i.guim.co.uk"])
        self.assertEqual([(row["slot"], row["slide_number"]) for row in result["slots"]], [
            ("COVER_NEWS", 1), ("BODY_NEWS", 2), ("BODY_NEWS", 3),
        ])
        self.assertEqual([row["subject_alias_groups"][0]["canonical_name"] for row in result["slots"]], [
            "Sir Alex Ferguson", "Bruno Fernandes", "Michael Carrick",
        ])

    def test_creates_one_subject_request_per_news_page_with_legacy_first_two_slots(self):
        value = brief()
        value["slides_json"]["slides"] = [
            value["slides_json"]["slides"][0],
            value["slides_json"]["slides"][1],
            {"slide_number": 3, "visual_direction": {"subject": "브루노 페르난데스의 경기 장면"}},
            {"slide_number": 4, "visual_direction": {"subject": "알렉스 퍼거슨 감독의 인터뷰"}},
        ]
        result = build_request(value, ["i.guim.co.uk"])
        self.assertEqual([(row["slot"], row.get("slide_number")) for row in result["slots"]], [
            ("COVER_NEWS", 1), ("BODY_NEWS", 2), ("BODY_NEWS", 3), ("BODY_NEWS", 4),
        ])
        self.assertEqual(result["_provenance"]["subject_names"], [
            "Sir Alex Ferguson", "Sir Alex Ferguson", "Bruno Fernandes", "Sir Alex Ferguson",
        ])

    def test_extracts_canonical_url_prioritized_original_and_explicit_player_aliases(self):
        result=build_request(brief(),["i.guim.co.uk","media.manutd.com"])
        self.assertEqual(result["publisher_article_urls"][0],
                         "https://www.theguardian.com/football/2026/oct/10/match-report")
        self.assertEqual(len(result["publisher_article_urls"]),2)
        self.assertEqual(result["publisher_article_urls"][1],
                         "https://www.bbc.com/sport/football/united")
        self.assertNotIn("news.google.com", str(result["publisher_article_urls"]))
        self.assertEqual(result["_provenance"]["google_news_original_urls"],
                         ["https://news.google.com/rss/articles/CBM123456789ABCD"])
        self.assertEqual(result["official_article_urls"],
                         ["https://www.manutd.com/en/news/detail/ferguson"])
        self.assertEqual(result["slots"][0]["subject_aliases"][0],"Sir Alex Ferguson")
        self.assertEqual(result["slots"][1]["subject_aliases"][0],"Sir Alex Ferguson")
        self.assertTrue(result["_provenance"]["requires_human_photo_review"])

    def test_keeps_two_named_people_as_separate_subject_groups(self):
        x=brief("프레드와 텐 하흐의 대비 컷 또는 실루엣","프레드의 인터뷰 사진")
        result=build_request(x,["i.guim.co.uk"])
        groups=result["slots"][0]["subject_alias_groups"]
        self.assertEqual([group["canonical_name"] for group in groups], ["Fred","Erik ten Hag"])
        self.assertEqual(result["slots"][0]["subject_aliases"][:2], ["Fred","Erik ten Hag"])

    def test_different_players_for_cover_and_body(self):
        x=brief("마이클 캐릭 감독 경기 후 모습","도미닉 솔란케가 동점골을 넣는 모습")
        result=build_request(x,["i.guim.co.uk"])
        self.assertEqual(result["_provenance"]["subject_names"],["Michael Carrick","Dominic Solanke"])

    def test_fails_instead_of_inventing_person(self):
        x=brief("올드 트래퍼드 경기장 전경","팬들 환호")
        with self.assertRaisesRegex(ValueError,"M9_PHOTO_SUBJECT_NOT_IDENTIFIED"):
            build_request(x,["i.guim.co.uk"])

    def test_rejects_unverified_urls_and_unknown_cdn(self):
        x=brief()
        x["evidence_snapshot"]={"sources":[{"canonical_url":"https://www.instagram.com/manutd","editorial_role":"FACT_PRIMARY"}]}
        with self.assertRaisesRegex(ValueError,"M9_PUBLISHER_ARTICLE_URL_REQUIRED"):
            build_request(x,["i.guim.co.uk"])
        with self.assertRaisesRegex(ValueError,"M9_OPERATOR_IMAGE_HOST_ALLOWLIST_REQUIRED"):
            build_request(brief(),[])

    def test_unresolved_google_wrapper_is_not_an_m9_photo_source(self):
        x=brief()
        x["evidence_snapshot"]={"sources":[
            {"canonical_url":"https://news.google.com/rss/articles/CBM123456789ABCD","editorial_role":"DISCOVERY_COMMUNITY"}
        ]}
        with self.assertRaisesRegex(ValueError,"M9_PUBLISHER_ARTICLE_URL_REQUIRED"):
            build_request(x,["i.guim.co.uk"])

    def test_refreshed_linked_source_uses_publisher_url_and_keeps_google_url_as_provenance(self):
        x=brief()
        x["evidence_snapshot"]={"sources":[{
            "canonical_url":"https://www.bbc.com/sport/football/united-story",
            "excerpt":"BBC article body excerpt about Manchester United.",
            "editorial_role":"DISCOVERY_COMMUNITY",
            "metadata":{
                "google_news_original_url":"https://news.google.com/rss/articles/CBM123456789ABCD",
                "resolved_publisher_url":"https://www.bbc.com/sport/football/united-story",
                "article_extraction_status":"EXTRACTED",
                "article_body_present":True,
            },
        }]}
        result=build_request(x,["i.guim.co.uk"])
        self.assertEqual(result["publisher_article_urls"],["https://www.bbc.com/sport/football/united-story"])
        self.assertNotIn("news.google.com",str(result["publisher_article_urls"]))
        self.assertEqual(result["_provenance"]["google_news_original_urls"],
                         ["https://news.google.com/rss/articles/CBM123456789ABCD"])

    def test_exploration_article_url_is_eligible_for_explicit_private_preview(self):
        x=brief()
        x["evidence_snapshot"]={"sources":[],"exploration_articles":[{
            "publisher_name":"The Athletic",
            "canonical_url":"https://www.theathletic.com/football/123/manchester-united-story",
            "published_at":"2026-10-12T09:00:00Z",
            "verified":False,
        }]}
        result=build_request(x,["i.guim.co.uk"])
        self.assertEqual(result["publisher_article_urls"],["https://www.theathletic.com/football/123/manchester-united-story"])
        self.assertEqual(result["_provenance"]["source_type"],"creative_briefs.evidence_snapshot.sources_and_exploration_articles")

    def test_protects_short_english_name_boundaries(self):
        self.assertEqual(recognized_people("Freddie scored his first goal"),[])
        self.assertEqual(recognized_people("Fred criticizes Erik ten Hag"),["Fred","Erik ten Hag"])

    def test_optional_active_entity_registry(self):
        b=brief("새 선수가 복귀했다","새 선수의 경기 장면")
        active=[{"canonical_name":"Test Player","entity_type":"PLAYER","active":True,
                 "aliases":["새 선수","Test Player"]}]
        result=build_request(b,["i.guim.co.uk"],tracked_entities=active)
        self.assertEqual(result["_provenance"]["subject_names"],["Test Player","Test Player"])

if __name__=="__main__":
    unittest.main()
