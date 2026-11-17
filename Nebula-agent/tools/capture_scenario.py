# -*- coding: utf-8 -*-
"""Capture a user-reported bug as a permanent regression scenario.

Turns a screenshot / pasted model output into a `tests/user_scenarios.json` entry that
`tests/_adversarial.py` loads and `tests/test_adversarial_llm.py` runs on every commit.
So "report one bug" == "gain one regression" against the coverage ceiling.

Usage:
    python tools/capture_scenario.py --name node_v24_drift \
        --kind narration --content "接下来开始构建。" \
        --desc "模型只描述不行动"

    --kind: xml | narration | length | empty | work   (default work)
    --out : path to user_scenarios.json (default tests/user_scenarios.json)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

KINDS = ("xml", "narration", "length", "empty", "work")


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(os.path.dirname(here), "tests", "user_scenarios.json")
    ap = argparse.ArgumentParser(
        description="Capture a bug report as a permanent regression scenario.")
    ap.add_argument("--name", required=True,
                    help="short id; becomes scenario name 'user_<name>'")
    ap.add_argument("--kind", choices=KINDS, default="work", help="failure class")
    ap.add_argument("--content", default="", help="the exact model output to replay")
    ap.add_argument("--desc", default="", help="what the bug looked like")
    ap.add_argument("--out", default=default_out,
                    help="target user_scenarios.json")
    args = ap.parse_args()

    path = args.out
    data = []
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                data = []
        except Exception:
            data = []
    # de-dup by name so re-capturing the same bug updates, not duplicates.
    data = [e for e in data if e.get("name") != args.name]
    data.append({"name": args.name, "kind": args.kind,
                 "content": args.content, "desc": args.desc})
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"capture_scenario: wrote scenario 'user_{args.name}' ({args.kind}) -> {path}")
    print("  run: python tests/test_adversarial_llm.py   (now includes this scenario)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
