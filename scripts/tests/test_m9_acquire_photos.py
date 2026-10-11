"""M9 real-photo file handoff tests; no external network requests."""
import os,sys,tempfile,unittest
from io import BytesIO
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from m9_acquire_photos import choose_media,validate_cdn_url

def selection(role,url="https://photos.example.org/photo.jpg",old=False):
    return {
        "slot": role,
        "selected": {
            "identity_evidence":"ALT_OR_CAPTION_MATCH",
            "requires_review":True,
            "can_auto_publish":False,
            "flags": ["ARCHIVE_PHOTO"] if old else ["REUSE_RIGHTS_UNVERIFIED"],
            "probe":{"status":"VALID","width":1800,"height":1300,"mime_type":"image/jpeg","bytes_read":4000},
            "candidate":{"image_url":url,"article_url":"https://news.example.org/football/story",
                         "credit":"Photographer B / News Agency",
                         "rights_status":"UNVERIFIED","caption":"Bruno Fernandes scores in Manchester"},
        }
    }

def payload():
    return {"schema_version":"m9-media-v1","review_only":True,"rights_status":"UNVERIFIED",
            "status":"CANDIDATES_FOR_REVIEW",
            "selections":[selection("COVER_NEWS"),selection("BODY_NEWS")]}

class TestAcquire(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name)
        bio=BytesIO()
        Image.new("RGB",(1800,1400),"navy").save(bio,format="JPEG")
        self.photo=bio.getvalue()
    def tearDown(self):
        self.tmp.cleanup()

    def test_two_roles_one_download_for_same_url(self):
        requests=[]
        def fake(url,hosts):
            validate_cdn_url(url,hosts)
            requests.append(url)
            return self.photo,".jpg"
        result=choose_media(payload(),self.root,["photos.example.org"],fake)
        self.assertEqual(requests,["https://photos.example.org/photo.jpg"])
        self.assertEqual(result["cover"]["file"],"cover.jpg")
        self.assertEqual(result["body"]["file"],"body.jpg")
        self.assertEqual((self.root/"cover.jpg").read_bytes(),self.photo)
        self.assertTrue((self.root/"media.json").is_file())
        self.assertFalse(result["cover"]["visual_subject_verified"])
        self.assertEqual(result["rights_status"],"UNVERIFIED")

    def test_reject_unmatched_subject(self):
        p=payload()
        p["selections"][0]["selected"]["identity_evidence"]="UNCONFIRMED"
        with self.assertRaisesRegex(ValueError,"M9_SUBJECT_METADATA_NOT_CONFIRMED"):
            choose_media(p,self.root,["photos.example.org"],lambda *_:(self.photo,".jpg"))

    def test_reject_archive_or_missing_slot(self):
        p=payload()
        p["selections"][0]["selected"]["flags"]=["ARCHIVE_PHOTO"]
        with self.assertRaisesRegex(ValueError,"ARCHIVED_PHOTO"):
            choose_media(p,self.root,["photos.example.org"],lambda *_:(self.photo,".jpg"))
        p=payload()
        p["selections"]=p["selections"][:1]
        with self.assertRaisesRegex(ValueError,"M9_PHOTO_REVIEW_REQUIRED_BODY_NEWS"):
            choose_media(p,self.root,["photos.example.org"],lambda *_:(self.photo,".jpg"))

    def test_reject_untrusted_cdn(self):
        for url in ("http://photos.example.org/photo.jpg","https://photos.example.org.evil.org/p.jpg",
                    "https://127.0.0.1/a.jpg","https://photos.example.org:444/p.jpg"):
            with self.assertRaises(ValueError):
                validate_cdn_url(url,["photos.example.org"])
        validate_cdn_url("https://photos.example.org/path?width=1920&s=hash",["photos.example.org"])

if __name__=="__main__":unittest.main()
