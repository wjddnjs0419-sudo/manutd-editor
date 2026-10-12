from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "m9_dispatch_gate.py"
WORKFLOW = ROOT / ".github" / "workflows" / "m9-private-preview.yml"
TARGET_REF = "refs/heads/codex/gnews-resolution-pipeline"
GOOD_SHA = "a" * 40


class M9DispatchGateTests(unittest.TestCase):
    def run_gate(self, *, expected_sha: str = GOOD_SHA, actual_sha: str = GOOD_SHA,
                 github_ref: str = TARGET_REF) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env.update({
            "M9_EXPECTED_SHA": expected_sha,
            "GITHUB_SHA": actual_sha,
            "GITHUB_REF": github_ref,
        })
        return subprocess.run(
            [sys.executable, str(GATE)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_accepts_only_the_selected_pr_commit(self):
        result = self.run_gate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"M9_DISPATCH_TARGET_OK: {GOOD_SHA}", result.stdout)

    def test_rejects_a_changed_head_sha(self):
        result = self.run_gate(actual_sha="b" * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("M9_DISPATCH_TARGET_REJECTED", result.stderr)

    def test_rejects_dispatch_from_another_branch(self):
        result = self.run_gate(github_ref="refs/heads/feature/untrusted")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("M9_DISPATCH_TARGET_REJECTED", result.stderr)

    def test_allows_the_default_branch_after_merge(self):
        result = self.run_gate(github_ref="refs/heads/main")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_workflow_checks_target_before_loading_preview_secrets(self):
        workflow = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("expected_sha:", workflow)
        self.assertIn("python scripts/m9_dispatch_gate.py", workflow)
        self.assertIn("needs: validate-target", workflow)
        self.assertIn("https://byymtttpwmllqvggnddm.supabase.co", workflow)


if __name__ == "__main__":
    unittest.main()
