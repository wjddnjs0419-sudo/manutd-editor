"""M9 owner-approved post-upload Telegram stage, with no duplicate publish."""
from __future__ import annotations

import sys
import unittest
import hashlib
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_send_uploaded_preview import deliver_existing, uploaded_paths
from m9_preview_workflow import job_key
from m9_notify_owner import notify_owner

BRIEF={"id":"72bf1111-ae15-45ca-a812-3c1e2ee37a10","version":1,"caption_draft":"뉴스 요약"}

class FakeStore:
    def __init__(self,status="UPLOADED",fail_sign=False,manifest=None):
        self.key=job_key(BRIEF,{})
        self.status=status
        self.fail_sign=fail_sign
        self.manifest=manifest
        self.downloaded=[]
        self.signed=[]
        self.transitions=[]
    def get_preview(self, key):
        assert key == self.key
        return {"job_key":self.key,"creative_brief_id":BRIEF["id"],"status":self.status,
                "rendered_manifest":self.manifest or {}}
    def signed_url(self,path):
        self.signed.append(path)
        if self.fail_sign:raise ValueError("M9_SIGN_FAILED")
        return "https://storage.example.com/"+path
    def transition(self,key,previous,next_status,patch=None):
        assert key==self.key
        if self.status!=previous:raise ValueError("M9_JOB_STATE_CONFLICT")
        self.status=next_status
        self.transitions.append((previous,next_status))
    def download_private_png(self,path):
        self.downloaded.append(path)
        return self.manifest["test_bytes"][path]

class FakeTelegram:
    def __init__(self,uncertain=False):
        self.attempts=0
        self.uncertain=uncertain
    def send_album(self,chat,urls,caption):
        self.attempts+=1
        assert chat=="777"
        assert len(urls)==3
        assert caption == ""
        if self.uncertain:raise ConnectionError("send may have succeeded")
        return [1,2,3]
    def send_png_documents(self,chat,documents):
        self.attempts+=1
        assert chat=="777"
        assert len(documents)==3
        assert [name for name,_ in documents]==["slide_01.png","slide_02.png","slide_03.png"]
        if self.uncertain:raise ConnectionError("send may have succeeded")
        return [1,2,3]
    def send_text(self,chat,text):
        assert chat=="777"
        assert text=="📋 Instagram 캡션 (복사)\n\n뉴스 요약"
        if self.uncertain:raise ConnectionError("send may have succeeded")
        return [4]

class TestPostUploadSend(unittest.TestCase):
    def test_workflow_status_requires_private_owner_chat_and_explicit_enable(self):
        class StatusTelegram:
            def __init__(self): self.calls=[]
            def send_text(self, chat, message):
                self.calls.append((chat,message))
                return [88]
        telegram=StatusTelegram()
        with patch.dict("os.environ", {"M9_ENABLE_TELEGRAM_PREVIEW":"YES"}):
            self.assertEqual(notify_owner("777","777","accepted",telegram),[88])
            with self.assertRaisesRegex(ValueError,"OWNER_CHAT_REQUIRED"):
                notify_owner("778","777","accepted",telegram)
        with patch.dict("os.environ", {"M9_ENABLE_TELEGRAM_PREVIEW":"NO"}):
            with self.assertRaisesRegex(ValueError,"PREVIEW_DISABLED"):
                notify_owner("777","777","accepted",telegram)
        self.assertEqual(len(telegram.calls),1)

    def test_preflight_three_urls_and_send_once(self):
        store,tel=FakeStore(),FakeTelegram()
        out=deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(out["message_count"],4)
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

    def test_uploaded_manifest_delivers_all_original_pngs_in_order(self):
        paths=[f"previews/72bf1111-ae15-45ca-a812-3c1e2ee37a10/slide_0{i}.png" for i in range(1,4)]
        data={path:b"\x89PNG\r\n\x1a\n"+bytes([i]) for i,path in enumerate(paths,1)}
        manifest={"image_paths":paths,"caption":"📋 Instagram 캡션 (복사)\n\n뉴스 요약",
                  "slide_count":3,
                  "slides":[{"slide_order":i,"image_path":path,"kind":"CTA" if i==3 else "BODY_NEWS",
                             "sha256":hashlib.sha256(data[path]).hexdigest()}
                            for i,path in enumerate(paths,1)],"test_bytes":data}
        store,tel=FakeStore(manifest=manifest),FakeTelegram()
        out=deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(store.downloaded,paths)
        self.assertEqual(store.signed,[])
        self.assertEqual(out["status"],"SENT")
        self.assertEqual(out["message_count"],4)

    def test_uploaded_manifest_hash_mismatch_prevents_telegram_send(self):
        path="previews/72bf1111-ae15-45ca-a812-3c1e2ee37a10/slide_01.png"
        data=b"\x89PNG\r\n\x1a\nslide"
        manifest={"image_paths":[path,path.replace("01","02")],"caption":"caption",
                  "slide_count":2,
                  "slides":[{"slide_order":i,"image_path":path.replace("01",f"0{i}"),
                             "kind":"CTA" if i==2 else "COVER_NEWS","sha256":"0"*64}
                            for i in (1,2)],"test_bytes":{path:data}}
        store,tel=FakeStore(manifest=manifest),FakeTelegram()
        with self.assertRaisesRegex(ValueError,"M9_STORAGE_SHA256_MISMATCH"):
            deliver_existing(BRIEF,store,tel,"777")
        self.assertEqual(tel.attempts,0)

if __name__=="__main__":
    unittest.main()
