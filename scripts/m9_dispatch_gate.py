#!/usr/bin/env python3
"""Reject M9 private-preview dispatches outside an explicitly selected commit."""
from __future__ import annotations

import os
import re
import sys


ALLOWED_REFS = {
    "refs/heads/codex/gnews-resolution-pipeline",
    "refs/heads/main",
}
SHA_PATTERN = re.compile(r"[0-9a-f]{40}\Z")


def validate_dispatch_target(github_ref: str, expected_sha: str, actual_sha: str) -> None:
    if github_ref not in ALLOWED_REFS:
        raise ValueError("M9_DISPATCH_REF_REJECTED")
    if not SHA_PATTERN.fullmatch(expected_sha):
        raise ValueError("M9_DISPATCH_EXPECTED_SHA_INVALID")
    if not SHA_PATTERN.fullmatch(actual_sha) or expected_sha != actual_sha:
        raise ValueError("M9_DISPATCH_SHA_MISMATCH")


def main() -> int:
    try:
        validate_dispatch_target(
            os.environ.get("GITHUB_REF", ""),
            os.environ.get("M9_EXPECTED_SHA", ""),
            os.environ.get("GITHUB_SHA", ""),
        )
    except ValueError as error:
        print(f"M9_DISPATCH_TARGET_REJECTED: {error}", file=sys.stderr)
        return 1
    print(f"M9_DISPATCH_TARGET_OK: {os.environ['GITHUB_SHA']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
