"""M9 scheduled polling regression tests. No real Supabase/Telegram calls."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_auto_preview import recent_ready_briefs, run_once

A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

class FakeStore:
    def __init__(self, rows=None, existing=None):
        self.rows=rows or []
        self.existing=set(existing or [])
        self.seen_paths=[]
        self.checked=[]
    def request(self, method, path):
        self.seen_paths.append((method,path))
        return self.rows
    def get_preview(self, key):
        self.checked.append(key)
        return {"status":"SENT"} if key in self.existing else None

def row(identifier,version=1):
    return {"id":identifier,"version":version,"status":"READY",
            "created_at":"2026-10-12T00:05:00Z"}

class TestM9AutomatedTrigger(unittest.TestCase):
    def setUp(self):
        self.t=tempfile.TemporaryDirectory()
        self.root=Path(self.t.name)
        self.now=datetime(2026,10,12,0,20,tzinfo=timezone.utc)
        self.env=patch.dict(os.environ,{
            "TELEGRAM_OWNER_USER_ID":"555",
            "M9_ENABLE_TELEGRAM_PREVIEW":"YES",
        })
        self.env.start()
    def tearDown(self):
        self.env.stop()
        self.t.cleanup()
    def call(self,store,runner,**more):
        return run_once(store,now=self.now,image_hosts=["i.guim.co.uk"],
            font=self.root/"font.otf",logo=self.root/"logo.png",
            cta=self.root/"cta.png",workdir=self.root/"results",
            chat_id="555",command=runner,**more)
    def test_recent_ready_only_and_bounded_query(self):
        store=FakeStore([row(A),row(B),{"id":"bad","version":1,"status":"READY"}, 
                         {"id":A,"version":True,"status":"READY"}, 
                         {"id":A,"version":2,"status":"DRAFT"}])
        r=recent_ready_briefs(store,self.now,hours_back=24,limit=8)
        self.assertEqual([v["id"] for v in r],[A,B])
        self.assertEqual(store.seen_paths[0][0],"GET")
        self.assertIn("status=eq.READY",store.seen_paths[0][1])
        self.assertIn("created_at=gte.",store.seen_paths[0][1])
        self.assertIn("limit=8",store.seen_paths[0][1])
    def test_empty_queue_does_not_send(self):
        store=FakeStore([])
        def unexpected(*args,**kwargs): raise AssertionError("No job should run")
        state=self.call(store,unexpected)
        self.assertEqual((state["seen_ready"],state["sent"],state["failed"]),(0,0,0))
    def test_existing_brief_never_sent_twice(self):
        store=FakeStore([row(A)],{"m9:"+A+":v1"})
        state=self.call(store,lambda *_a,**_k: (_ for _ in ()).throw(AssertionError("duplicate")))
        self.assertEqual(state["skipped_existing"],1)
        self.assertEqual(state["attempted"],0)
    def test_new_briefs_send_without_manual_brief_ids_and_limit(self):
        store=FakeStore([row(A),row(B)])
        calls=[]
        class Completed:
            returncode=0
        def mock_runner(cmd,**kwargs):
            calls.append(cmd)
            identifier=cmd[cmd.index("--brief-id")+1]
            destination=self.root/"results"/identifier/"slides"
            destination.mkdir(parents=True,exist_ok=True)
            (destination/"delivery-state.json").write_text(json.dumps({"status":"SENT"}))
            return Completed()
        state=self.call(store,mock_runner,max_sends=1)
        self.assertEqual(state["sent"],1)
        self.assertEqual(len(calls),1)
        self.assertIn("--upload",calls[0])
        self.assertIn("--send-telegram",calls[0])
        self.assertEqual(calls[0][calls[0].index("--brief-id")+1],A)
        self.assertEqual(calls[0][calls[0].index("--chat-id")+1],"555")
    def test_failed_candidate_does_not_block_next(self):
        store=FakeStore([row(A),row(B)])
        class Completed:
            returncode=1
        def runner(cmd,**kwargs):
            if A in cmd:return Completed()
            path=self.root/"results"/B/"slides"
            path.mkdir(parents=True,exist_ok=True)
            (path/"delivery-state.json").write_text('{"status":"SENT"}')
            class Success:
                returncode=0
            return Success()
        state=self.call(store,runner,max_sends=1)
        self.assertEqual((state["failed"],state["sent"]),(1,1))
    def test_owner_confirmation_required_for_auto_send(self):
        store=FakeStore([row(A)])
        os.environ["TELEGRAM_OWNER_USER_ID"]="666"
        with self.assertRaisesRegex(ValueError,"M9_AUTOMATIC_OWNER_AUTH_REQUIRED"):
            self.call(store,lambda *_a,**_k:None)
    def test_does_not_log_news_html_secrets_or_signed_urls(self):
        store=FakeStore([row(A)])
        class Fail:
            returncode=1
            stdout="SECRET private signed image"
            stderr="SECRET token"
        state=self.call(store,lambda *a,**kw: Fail())
        self.assertEqual(state["failed"],1)
        self.assertNotIn("SECRET",json.dumps(state))

if __name__=="__main__":
    unittest.main()
