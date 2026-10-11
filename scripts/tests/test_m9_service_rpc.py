"""Protect service-role RPC client calls in GitHub Actions against regressions."""
from __future__ import annotations

import json
import sys
import unittest
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
        self.transport.response=b'{"status":"UPLOADED","creative_brief_id":"a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}'
        self.assertEqual(self.store.get_preview("jobkey")["status"],"UPLOADED")
        self.transport.response=b'null'
        self.assertIsNone(self.store.get_preview("jobkey"))
    def test_duplicate_job_409_no_retry(self):
        class Conflict(FakeHttp):
            def request(self,*args,**kwargs):
                raise RemoteError(409,"M9_CONFLICT")
        store=SupabaseGateway("https://sample-project.supabase.co","fake-service-jwt",Conflict())
        with self.assertRaisesRegex(ValueError,"ALREADY_CLAIMED"):
            store.claim("m9:test:v1","a9a9a9a9-aaaa-4aaa-8aaa-aaaaaaaaaaaa",{})

if __name__=="__main__":unittest.main()
