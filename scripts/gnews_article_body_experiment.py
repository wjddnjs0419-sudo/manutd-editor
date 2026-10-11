#!/usr/bin/env python3
"""Compare bounded article extraction at 200, 500, and 800 KB caps."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any

try:
    from .gnews_decoder_poc import BODY_EXPERIMENT_LIMITS, run_body_limit_experiment
except ImportError:
    from gnews_decoder_poc import BODY_EXPERIMENT_LIMITS, run_body_limit_experiment


def load_articles(path: Path) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list) or not all(isinstance(row, dict) for row in data):
        raise ValueError("Input JSON must be a list of article objects")
    return data


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input",
        type=Path,
        default=Path("scripts/fixtures/gnews-decoder-body-input.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("/tmp/manutd-gnews-body-limit-results.json"),
    )
    parser.add_argument("--body-limit", type=int, default=10)
    args = parser.parse_args()

    result = run_body_limit_experiment(
        load_articles(args.input),
        body_limit=args.body_limit,
        byte_limits=BODY_EXPERIMENT_LIMITS,
    )
    result["tested_at"] = datetime.now().astimezone().isoformat()
    result["input_file"] = str(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    summaries = []
    for limit in result["byte_limits"]:
        rows = [
            item
            for article in result["articles"]
            for item in article["limits"]
            if item["limit_bytes"] == limit
        ]
        summaries.append(
            {
                "limit_bytes": limit,
                "existing_extraction_success_count": sum(
                    item["existing_extraction_success"] for item in rows
                ),
                "improved_extraction_success_count": sum(
                    item["improved_extraction_success"] for item in rows
                ),
            }
        )
    print(
        json.dumps(
            {
                "output": str(args.output),
                "body_test_count": result["body_test_count"],
                "http_request_count": result["http_request_count"],
                "publisher_http_429_observed": result[
                    "publisher_http_429_observed"
                ],
                "summaries": summaries,
            },
            ensure_ascii=False,
        )
    )
    return 2 if result["publisher_http_429_observed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
