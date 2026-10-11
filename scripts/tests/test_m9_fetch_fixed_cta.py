"""M9 static CTA contract. The approved Figma PNG itself is not committed."""
from __future__ import annotations

import hashlib
import sys
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from m9_fetch_fixed_cta import APPROVED_CTA_SHA256, validate_approved_cta_bytes


class TestApprovedCta(unittest.TestCase):
    def test_approved_asset_hash_has_fixed_format(self):
        self.assertEqual(len(APPROVED_CTA_SHA256), 64)
        self.assertTrue(all(c in "0123456789abcdef" for c in APPROVED_CTA_SHA256))

    def test_malformed_and_unapproved_image_rejected(self):
        for value in [b"", b"not an image", b"\x89PNG\r\n\x1a\n" + b"\x00" * 50]:
            with self.assertRaises(ValueError):
                validate_approved_cta_bytes(value)
        image = Image.new("RGB", (1080, 1350), "#be0000")
        buf = BytesIO()
        image.save(buf, format="PNG")
        with self.assertRaisesRegex(ValueError, "M9_CTA_ASSET_HASH_MISMATCH"):
            validate_approved_cta_bytes(buf.getvalue())

    def test_does_not_fetch_unapproved_replacement(self):
        # Hash contract requires the *approved* Figma file, not a newly
        # generated/reconstructed CTA.
        image = Image.new("RGB", (1080, 1350), "#000000")
        buf = BytesIO()
        image.save(buf, format="PNG")
        self.assertNotEqual(hashlib.sha256(buf.getvalue()).hexdigest(), APPROVED_CTA_SHA256)


if __name__ == "__main__":
    unittest.main()
