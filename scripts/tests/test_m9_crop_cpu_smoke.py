"""Credential-free, generated-image smoke report contracts for the M9 CPU path."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_crop_cpu_smoke import run_smoke


def local_model() -> Path | None:
    candidates = [
        os.environ.get("M9_CROP_TEST_MODEL_PATH"),
        str(Path(__file__).resolve().parents[2] / ".superpowers/sdd/2026-10-12-m9-free-subject-crop/model/blaze_face_short_range.tflite"),
    ]
    return next((Path(path) for path in candidates if path and Path(path).is_file()), None)


@unittest.skipUnless(local_model(), "Provide the verified M9 CPU model locally")
class M9CropCpuSmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.report_path = Path(self.temp.name) / "smoke-report.json"
        self.model = local_model()
        assert self.model

    def tearDown(self):
        self.temp.cleanup()

    def assert_private_aggregate_report(self, report: dict) -> None:
        encoded = json.dumps(report, sort_keys=True).lower()
        for forbidden in ("source_url", "photo_url", "pixels", "supabase_url",
                          "service_role_key", "telegram_bot_token", "openai_api_key"):
            self.assertNotIn(forbidden, encoded)

    def test_report_has_versions_hash_and_timing(self):
        report = run_smoke(self.model, self.report_path)
        self.assertEqual(report["output_status"], "PASS")
        self.assertEqual(report["model_sha256"],
                         "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f")
        self.assertEqual(report["image_count"], 1)
        self.assertEqual(report["candidate_count"], 1)
        self.assertEqual(report["max_candidates_per_slot"], 3)
        self.assertGreaterEqual(report["model_load_ms"], 0)
        self.assertGreaterEqual(report["inference_ms"], 0)
        self.assertGreaterEqual(report["total_elapsed_seconds"], 0)
        self.assertTrue({"python", "mediapipe", "pillow", "numpy", "opencv"}.issubset(
            report["runtime_versions"]))
        self.assertEqual(json.loads(self.report_path.read_text()), report)
        self.assert_private_aggregate_report(report)

    def test_smoke_path_never_requires_credentials(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "", "SUPABASE_SERVICE_ROLE_KEY": "",
            "SUPABASE_SECRET_KEY": "", "TELEGRAM_BOT_TOKEN": "",
            "OPENAI_API_KEY": "",
        }):
            report = run_smoke(self.model, self.report_path)
        self.assertEqual(report["output_status"], "PASS")
        self.assert_private_aggregate_report(report)


if __name__ == "__main__":
    unittest.main()
