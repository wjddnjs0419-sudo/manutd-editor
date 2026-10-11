"""M9 owner-approved post-upload Telegram stage, with no duplicate publish."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_send_uploaded_preview import deliver_existing, uploaded_paths
from m9_preview_workflow import job_key

BRIEF={"id":"72bf1111-ae15-45ca-a812-3c1e2ee37a10","version":1,"caption_draft":"뉴스 요약"}

class FakeStore:
    def __init__(self,status="UPLOADED",fail_sign=False):
        self.key=job_key(BRIEF,{})
        self.status=status
        self.fail_sign=fail_sign
        self.signed=[]
        self.transitions=[]
    def request(self,method,path,payload=None,schema=None):
        assert method=="GET"
        assert schema=="app_private"
        return [{"job_key":self.key,"creative_brief_id":BRIEF["id"],"status":self.status}]
    def signed_url(self,path):
        self.signed.append(path)
        if self.fail_sign:raise ValueError("M9_SIGN_FAILED")
        return "https://storage.example.com/"+path
    def transition(self,key,previous,next_status,patch=None):
        assert key==self.key
        if self.status!=previous:raise ValueError("M9_JOB_STATE_CONFLICT")
        self.status=next_status
        self.transitions.append((previous,next_status))

class FakeTelegram:
    def __init__(self,uncertain=False):
        self.attempts=0
        self.uncertain=uncertain
    def send_album(self,chat,urls,caption):
        self.attempts+=1
        assert chat=="777"
        assert len(urls)==3
        assert "검토용" in caption
        if self.uncertain:raise ConnectionError("send may have succeeded")
        return [1,2,3]

class TestPostUploadSend(unittest.TestCase):
    def test_preflight_three_urls_and_send_once(self):
        store,tel=FakeStore(),FakeTelegram()
        out=deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(out["message_count"],3)
        self.assertEqual(out["status"],"SENT")
        self.assertEqual(store.signed,uploaded_paths(store.key))
        self.assertEqual(store.transitions,[("UPLOADED","SENDING"),("SENDING","SENT")])
        self.assertEqual(tel.attempts,1)
        with self.assertRaisesRegex(ValueError,"M9_PREVIEW_NOT_APPROVED"):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(tel.attempts,1)

    def test_no_telegram_send_when_publisher_image_url_cannot_be_signed(self):
        store,tel=FakeStore(fail_sign=True),FakeTelegram()
        with self.assertRaisesRegex(ValueError,"M9_SIGN_FAILED"):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(store.status,"UPLOADED")
        self.assertEqual(tel.attempts,0)

    def test_uncertain_send_never_auto_retried(self):
        store,tel=FakeStore(),FakeTelegram(uncertain=True)
        with self.assertRaises(ConnectionError):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(store.status,"SEND_UNCERTAIN")
        self.assertEqual(tel.attempts,1)
        with self.assertRaisesRegex(ValueError,"M9_PREVIEW_NOT_APPROVED"):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(tel.attempts,1)

    def test_no_send_when_job_not_uploaded(self):
        store,tel=FakeStore(status="CLAIMED"),FakeTelegram()
        with self.assertRaisesRegex(ValueError,"M9_PREVIEW_NOT_APPROVED"):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(tel.attempts,0)

if __name__=="__main__":
    unittest.main()
