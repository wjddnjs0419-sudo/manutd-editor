"""Protect service-role RPC client calls in GitHub Actions against regressions."""
from __future__ import annotations

import json
import sys
import unittest
from urllib.parse import parse_qs, urlsplit
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from m9_preview_workflow import SupabaseGateway, RemoteError

class FakeHttp:
    def __init__(self):
        self.calls=[]
        self.response=b'true'
    def request(self,method,url,headers,body=None):
        self.calls.append((method,url,headers,body))
        return self.response

class TestM9ServiceRpc(unittest.TestCase):
    def setUp(self):
        self.transport=FakeHttp()
        self.store=SupabaseGateway("https://sample-project.supabase.co","fake-service-jwt",self.transport)
    def test_claim_service_only_rpc(self):
        self.store.claim("m9:a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa:v1","a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{})
        method,url,headers,body=self.transport.calls[-1]
        self.assertEqual(method,"POST")
        self.assertTrue(url.endswith("/rest/v1/rpc/m9_claim_preview"))
        self.assertIn("p_job_key",json.loads(body))
        self.assertNotIn("accept-profile",headers)
    def test_transition_uses_public_rpc_without_exposing_private_schema(self):
        self.store.transition("m9:a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa:v1","UPLOADED","SENDING")
        method,url,headers,body=self.transport.calls[-1]
        self.assertTrue(url.endswith("/rest/v1/rpc/m9_transition_preview"))
        self.assertEqual(json.loads(body)["p_previous"],"UPLOADED")
        self.assertNotIn("content-profile",headers)
    def test_get_returns_record_or_missing(self):
        self.transport.response=b'{"id":"b8b8b8b8-bbbb-4bbb-8bbb-bbbbbbbbbbbb","status":"UPLOADED","creative_brief_id":"a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa","rendered_manifest":{"image_paths":["previews/x/slide_01.png"]}}'
        row=self.store.get_preview("jobkey")
        self.assertEqual(row["status"],"UPLOADED")
        self.assertIn("image_paths",row["rendered_manifest"])
        self.transport.response=b'null'
        self.assertIsNone(self.store.get_preview("jobkey"))
    def test_load_brief_selects_render_and_openai_usage_metadata(self):
        brief_id="a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        self.transport.response=json.dumps([{
            "id":brief_id,"version":1,"status":"READY","content_mode":"NEWS_UPDATE",
            "cta":"더 많은 소식","provider_calls":1,"input_tokens":10,
            "output_tokens":20,"estimated_cost_usd":0.001,
        }]).encode()
        brief=self.store.load_brief(brief_id)
        selected=set(parse_qs(urlsplit(self.transport.calls[-1][1]).query)["select"][0].split(","))
        self.assertTrue({"content_mode","cta","provider_calls","input_tokens","output_tokens","estimated_cost_usd"}.issubset(selected))
        self.assertEqual(brief["content_mode"],"NEWS_UPDATE")
    def test_duplicate_job_409_no_retry(self):
        class Conflict(FakeHttp):
            def request(self,*args,**kwargs):
                raise RemoteError(409,"M9_CONFLICT")
        store=SupabaseGateway("https://sample-project.supabase.co","fake-service-jwt",Conflict())
        with self.assertRaisesRegex(ValueError,"ALREADY_CLAIMED"):
            store.claim("m9:test:v1","a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{})

    def test_private_bucket_guard_rejects_public_bucket(self):
        self.transport.response=b'{"id":"manutd-card-assets","public":true}'
        with self.assertRaisesRegex(ValueError,"M9_STORAGE_BUCKET_NOT_PRIVATE"):
            self.store.ensure_private_bucket()

    def test_uploaded_bytes_are_sha_checked_and_public_read_is_denied(self):
        class PrivateStorageHttp:
            def request(self, method, url, headers, body=None):
                if "/object/public/" in url:
                    raise RemoteError(400, "private bucket")
                return b"\x89PNG\r\n\x1a\nsame-png-bytes"
        store=SupabaseGateway("https://sample-project.supabase.co","fake-service-jwt",PrivateStorageHttp())
        import hashlib
        expected=b"\x89PNG\r\n\x1a\nsame-png-bytes"
        self.assertEqual(store.verify_uploaded_png("previews/a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa/slide_01.png",expected),hashlib.sha256(expected).hexdigest())

    def test_uploaded_png_verification_rejects_public_read(self):
        class PublicStorageHttp:
            def request(self, method, url, headers, body=None):
                if "/object/public/" in url:
                    return b"\x89PNG\r\n\x1a\npublic-png-bytes"
                return b"\x89PNG\r\n\x1a\nprivate-png-bytes"
        store=SupabaseGateway("https://sample-project.supabase.co","fake-service-jwt",PublicStorageHttp())
        with self.assertRaisesRegex(ValueError,"M9_STORAGE_PUBLIC_READ_ALLOWED"):
            store.verify_uploaded_png("previews/a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa/slide_01.png",b"\x89PNG\r\n\x1a\nprivate-png-bytes")

if __name__=="__main__":unittest.main()
