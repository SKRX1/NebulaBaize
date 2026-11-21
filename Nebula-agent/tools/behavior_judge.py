# -*- coding: utf-8 -*-
"""Behavior judge — evaluate each assistant turn for soft-instruction adherence.

The hard failures (crash, disconnect, leaked XML) are already caught by the
per-commit gates and the session scanner. This layer catches the *soft* drift
that users notice but no assertion flags:

  * 强制中文思考: did the reasoning/thinking actually use Chinese? (CJK ratio)
  * 工具调用合法  : are tool_calls well-formed JSON with known tool names?
  * 无 XML 泄漏   : is raw <function=...>/<tool_call> markup absent from the answer?
  * 收尾干净      : did the turn end on a text answer, not a dangling tool call?

Two modes:
  * Deterministic heuristics (no model, always runs) — fast, CI-friendly.
  * Optional LLM-as-judge: if JUDGE_URL + JUDGE_MODEL are set, send the turn to a
    model with a rubric and fold its verdict in. Falls back to heuristics when
    unset, so the script is always runnable.

Usage as library:
    from behavior_judge import judge_turn, judge_session
    res = judge_session(turns, known=KNOWN_TOOLS)

Usage as CLI (nightly):
    python tools/behavior_judge.py turns.jsonl [--known filesystem__write shell__exec ...]
    exit 0 = all turns pass; 1 = any turn fails a hard heuristic
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request

# CJK unified ideographs + extension A. Good enough to separate "thought in Chinese"
# from "thought in English/Latin" for the force-Chinese-think rule.
_CJK = re.compile(r"[㐀-䶿一-鿿豈-﫿]")

# Rubric handed to the optional LLM-as-judge. Covers the same four dimensions as the
# deterministic heuristics so the two layers agree, but the model can also catch
# soft semantic drift (e.g. Chinese ratio is fine but the thought drifted off-topic).
RUBRIC = (
    "你是一个对话质量评审。判断下面这一轮助手输出是否合格：\n"
    "1) 思考/推理是否确实使用中文（强制中文思考规则）；\n"
    "2) 工具调用是否合规（已知工具名、参数合法 JSON）；\n"
    "3) 回答是否混入原始调用标记（如 <function= 或 </function>）；\n"
    "4) 轮次是否干净收尾（有文本答案，而非悬空工具调用）。\n"
    "只要任一维度明显不合格就判 FAIL，否则 PASS。用一行 PASS/FAIL 开头，再给简短理由。"
)


def _cjk_ratio(text: str) -> float:
    if not text:
        return 0.0
    cjk = len(_CJK.findall(text))
    return cjk / max(1, len(text))


def judge_chinese_think(turn: dict, threshold: float = 0.5) -> dict:
    """Pass when the reasoning content is predominantly Chinese.

    `ok=None` means "nothing to judge" (no reasoning content) — not a failure.
    """
    reasoning = (turn.get("reasoning_content")
                 or turn.get("reasoning")
                 or turn.get("thinking")
                 or "")
    if not reasoning:
        return {"name": "chinese_think", "ok": None,
                "detail": "no reasoning content to judge (ok=None)"}
    ratio = _cjk_ratio(reasoning)
    ok = ratio >= threshold
    return {"name": "chinese_think", "ok": ok, "ratio": round(ratio, 3),
            "detail": f"cjk {ratio:.2%} (>= {threshold:.0%} required)"}


def judge_tool_calls(turn: dict, known=None) -> dict:
    tcs = turn.get("tool_calls") or []
    if not tcs:
        return {"name": "tool_call_valid", "ok": True, "detail": "no tool calls"}
    bad = []
    for tc in tcs:
        fn = tc.get("function", {}) if isinstance(tc, dict) else {}
        name = fn.get("name", "")
        args = fn.get("arguments")
        if known and name not in known:
            bad.append(f"unknown:{name}")
        if isinstance(args, str):
            try:
                json.loads(args)
            except Exception:
                bad.append(f"bad_json:{name}")
        elif not isinstance(args, dict):
            bad.append(f"bad_args:{name}")
    return {"name": "tool_call_valid", "ok": not bad,
            "detail": ("ok" if not bad else "issues: " + ", ".join(bad))}


def judge_no_xml_leak(turn: dict) -> dict:
    text = turn.get("content") or ""
    leak = ("<function=" in text) or ("<tool_call" in text) or ("</function>" in text)
    return {"name": "no_xml_leak", "ok": not leak,
            "detail": ("no raw markup in answer" if not leak
                       else "raw call markup leaked into the answer text")}


def judge_clean_finish(turn: dict) -> dict:
    text = (turn.get("content") or "").strip()
    has_tc = bool(turn.get("tool_calls"))
    if has_tc and not text:
        return {"name": "clean_finish", "ok": False,
                "detail": "turn ended on a tool call with no text answer"}
    if not text and not has_tc:
        return {"name": "clean_finish", "ok": False, "detail": "empty turn (no text, no call)"}
    return {"name": "clean_finish", "ok": True, "detail": "text answer present"}


def judge_turn(turn: dict, known=None, threshold: float = 0.5, use_llm=None) -> dict:
    checks = [
        judge_chinese_think(turn, threshold),
        judge_tool_calls(turn, known),
        judge_no_xml_leak(turn),
        judge_clean_finish(turn),
    ]
    # When use_llm is None, auto-enable only if both JUDGE_URL and JUDGE_MODEL are set.
    if use_llm is None:
        use_llm = bool(os.environ.get("JUDGE_URL")) and bool(os.environ.get("JUDGE_MODEL"))
    if use_llm:
        llm = judge_llm(turn, RUBRIC)
        if llm.get("applied"):
            checks.append({
                "name": "llm_judge",
                "ok": llm.get("verdict") == "PASS",
                "detail": f"llm[{os.environ.get('JUDGE_MODEL')}]: {llm.get('reason', '')[:160]}",
            })
    # ok=None (no reasoning to judge) does not fail the turn.
    hard_fail = any(c["ok"] is False for c in checks)
    return {"turn": turn.get("id"), "ok": not hard_fail, "checks": checks}


def judge_session(turns: list[dict], known=None, threshold: float = 0.5, use_llm=None) -> dict:
    per = [judge_turn(t, known, threshold, use_llm) for t in turns]
    failed = [p for p in per if not p["ok"]]
    return {"turns": len(turns), "failed": len(failed),
            "ok": len(failed) == 0, "per": per}


# ─── optional LLM-as-judge ──────────────────────────────────────────────────────

def judge_llm(turn: dict, rubric: str, model: str | None = None) -> dict:
    """Send a turn to a model for a soft verdict. Returns {applied, verdict?, reason?}.

    No-op (applied=False) when JUDGE_URL / JUDGE_MODEL are unset, so the script
    stays runnable in any environment. Uses only the stdlib (urllib).
    """
    base = os.environ.get("JUDGE_URL")
    model = model or os.environ.get("JUDGE_MODEL")
    if not base or not model:
        return {"applied": False, "reason": "JUDGE_URL/JUDGE_MODEL not set"}
    text = (turn.get("content") or "")
    reasoning = (turn.get("reasoning_content") or turn.get("reasoning") or "")
    prompt = (
        f"{rubric}\n\n"
        f"--- reasoning ---\n{reasoning}\n\n"
        f"--- answer ---\n{text}\n\n"
        f"Reply with one line: PASS or FAIL, then a short reason."
    )
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0,
        "max_tokens": 200,
    }
    url = base.rstrip("/") + "/chat/completions"
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + (os.environ.get("JUDGE_API_KEY") or "none")},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        content = data["choices"][0]["message"]["content"].strip()
        verdict = "PASS" if content.upper().startswith("PASS") else "FAIL"
        return {"applied": True, "verdict": verdict, "reason": content}
    except Exception as e:
        return {"applied": False, "reason": f"judge call failed: {e}"}


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: python tools/behavior_judge.py turns.jsonl [--known a b c]")
        return 2
    path = sys.argv[1]
    known = None
    if "--known" in sys.argv:
        idx = sys.argv.index("--known")
        known = set(sys.argv[idx + 1:])

    turns = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                turns.append(json.loads(line))
            except Exception:
                pass
    if not turns:
        print("behavior_judge: no turns found in", path)
        return 0

    rep = judge_session(turns, known=known)
    print(f"behavior_judge: {rep['turns']} turns, {rep['failed']} failed")
    for p in rep["per"]:
        if p["ok"]:
            continue
        print(f"  FAIL turn={p['turn']}:")
        for c in p["checks"]:
            if c["ok"] is False:
                print(f"    - {c['name']}: {c['detail']}")
    return 0 if rep["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
