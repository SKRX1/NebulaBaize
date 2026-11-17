# -*- coding: utf-8 -*-
"""Soak runner — the "nightly / slow lane" stress layer.

Catches what the per-commit gates cannot: long-session leaks, soft-instruction
drift, and unbounded memory growth that only show up after many turns / rounds.

Two modes:

  * in-process (default, CI-safe): drives the REAL `_agent_stream` agent loop with
    a scripted "engine" that replays the adversarial corpus over a long, busy
    session (many tool rounds + breakage rounds + a clean finish). No network,
    no model, no MCP child — but it exercises the genuine loop, history stitching,
    leak recovery and the narration cap across dozens of rounds.

  * live (--gateway-url / --engine-url): drives a RUNNING gateway's
    /v1/chat/completions over N real turns with a growing message list (true
    multi-turn context accumulation), applies the behavior judge each turn, and
    reports drift. This is the real-engine soak — run it nightly against 8080+8099.

Either way it returns a structured report and exits non-zero on a hard invariant
violation, so it can be the nightly CI gate.

Usage:
    # CI / local: a short, deterministic soak
    python tools/soak_runner.py --fake --rounds 24

    # Nightly against the real engine:
    python tools/soak_runner.py --gateway-url http://127.0.0.1:8099 --turns 60 --duration 14400
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))
sys.path.insert(0, os.path.join(ROOT, "tests"))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from _adversarial import (  # noqa: E402
    KNOWN, Executor as FakeExecutor, FakeHandler, fresh_state, parse, run,
)

LEAK_MARKUP = ("<function=", "<tool_call", "</function>")


def _work_round(i: int, cjk: bool = True):
    """A productive round: Chinese reasoning + one filesystem write tool call."""
    reasoning = (f"正在执行第 {i} 步，先把内容写入文件。"
                 if cjk else f"now executing step {i}, writing the file.")
    tc = {"index": 0, "id": f"call_{i}", "type": "function",
          "function": {"name": "filesystem__write",
                       "arguments": json.dumps(
                           {"path": f"_build/{i:02d}.html", "content": f"<html>{i}</html>"})}}
    return [{"choices": [{"delta": {"reasoning_content": reasoning}}]},
            {"choices": [{"delta": {"tool_calls": [tc]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]}]


def _xml_round(i: int):
    """FM4 neighbour: a call the engine failed to structure, arrives as text."""
    text = (f"第 {i} 步的输出如下。\n<tool_call>\n<function=filesystem__write>\n"
            f"<parameter=path>\n_build/{i:02d}.html\n</parameter>\n"
            f"<parameter=content>\n<html>{i}</html>\n</parameter>\n"
            f"</function>\n</tool_call>\n")
    return [{"choices": [{"delta": {"content": text}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]}]


def _narration_round(i: int):
    return [{"choices": [{"delta": {"content": f"接下来写第 {i} 个文件。"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]}]


def _length_round(i: int):
    return [{"choices": [{"delta": {"content": ""}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]}]


def build_rotation(rounds: int) -> list:
    """A single, continuous, LONG session built from rounds that keep running.

    The agent loop ends a turn on: a clean text answer (no tool call), a pure
    thought that hits the length budget, or the 3rd narration nudge. To stress a
    *long* session we therefore compose the rotation almost entirely of TOOL rounds
    (which always continue) plus a couple of recovery/narration rounds, and finish
    with exactly one clean text answer.

    Keeps reasoning predominantly Chinese so the behavior judge's session adherence
    stays green; drift detection itself is covered by test_behavior_judge.py.
    """
    rot = []
    narr_left = 2  # the narration nudge caps at 2; stay at/under it so it never ends the turn
    for i in range(rounds - 1):
        mod = i % 5
        if mod == 2 and narr_left > 0:
            rot.append(_narration_round(i))    # narration nudge path (continues)
            narr_left -= 1
        elif mod == 3:
            rot.append(_xml_round(i))          # recovery path (continues)
        else:
            rot.append(_work_round(i))         # tool round (continues)
    rot.append([{"choices": [{"delta": {"content": "全部构建完成。"}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]}])  # clean finish
    return rot


def _any_markup(seen) -> bool:
    for msgs in seen:
        for m in msgs:
            c = m.get("content") if isinstance(m, dict) else ""
            if isinstance(c, str) and any(k in c for k in LEAK_MARKUP):
                return True
    return False


def _rss_delta():
    """Best-effort RSS growth across the soak. Returns (delta_bytes, source) or (None, 'n/a')."""
    try:
        import resource
        before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    except Exception:
        try:
            import psutil
            before = psutil.Process().memory_info().rss
        except Exception:
            return None, "n/a"
    return before, "resource"


def soak_in_process(rounds: int = 24) -> dict:
    state = fresh_state()
    state.max_rounds = rounds + 8
    rotation = build_rotation(rounds)
    rss_start, src = _rss_delta()
    h, events = run(state, rotation, session="s-soak")
    rss_end, _ = _rss_delta()
    rss_delta = (rss_end - rss_start) if (rss_start is not None and rss_end is not None) else None

    ended_done = bool(events) and events[-1] == "[DONE]"
    leaked = _any_markup(h.seen)
    bad_tools = [c[0] for c in state.executor.calls if c[0] not in KNOWN]
    all_known = not bad_tools
    capped = h._round >= state.max_rounds  # spun to the round ceiling => a guard failed

    # chinese-think adherence over the whole session (session-level soft signal)
    reasoning = "".join(
        ch.get("choices", [{}])[0].get("delta", {}).get("reasoning_content", "")
        for seq in rotation for ch in seq)
    from behavior_judge import judge_chinese_think
    cjk = judge_chinese_think({"reasoning_content": reasoning})

    req = {
        "ended_with_done": ended_done,
        "leaked_markup": leaked,
        "all_tools_known": all_known,
        "bad_tools": bad_tools,
        "tool_calls": len(state.executor.calls),
        "rounds_run": h._round,
        "max_rounds": state.max_rounds,
        "narration_capped": capped,
        "rss_delta_bytes": rss_delta,
        "rss_source": src,
        "chinese_think_ratio": cjk.get("ratio"),
        "rotation_rounds": rounds,
    }
    ok = ended_done and not leaked and all_known and not capped
    req["ok"] = ok
    return req


# ─── live (real engine) driver ───────────────────────────────────────────────────

def _probe(url: str, timeout: float = 3.0) -> bool:
    """True if a server answers (any HTTP status counts — even 4xx means it's up)."""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True
    except urllib.error.HTTPError:
        return True  # server responded => reachable
    except Exception:
        return False


def _post_json(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=600) as r:
        return r.read().decode("utf-8", "replace")


def _parse_sse(text):
    events = []
    for block in text.split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        payload = block[5:].strip()
        if payload in ("[DONE]", '"[DONE]"'):
            events.append("[DONE]")
            continue
        try:
            events.append(json.loads(payload))
        except Exception:
            pass
    return events


def soak_live(gateway_url: str, model: str = "strata", turns: int = 20,
              tasks: list[str] | None = None, require_engine: bool = False,
              report_dir: str | None = None) -> dict:
    """Drive a RUNNING gateway (8099) over N real turns with a growing message list.

    Probes the gateway first; if it (or the 8080 engine behind it) is down, returns a
    neutral report so a nightly job does not break when the engine is intentionally off.
    With require_engine=True the caller insists the engine must be present, so an
    unreachable gateway becomes a hard failure (exit non-zero).

    Each captured turn is judged (heuristics + optional LLM-as-judge when configured),
    the turns are persisted to logs/soak_turns.jsonl for downstream judge/scan, and the
    behavior-judge summary is folded into the report.
    """
    from behavior_judge import judge_turn, judge_session
    base = gateway_url.rstrip("/")
    health = base + "/api/models"
    if not _probe(health):
        return {"mode": "live", "reachable": False,
                "ok": (False if require_engine else None),
                "error": "gateway unreachable (is 8099 up? is 8080 engine running?)"}

    chat = base + "/v1/chat/completions"
    messages = []
    per = []
    turns_data = []
    total_tools = 0
    try:
        for t in range(turns):
            task = tasks[t % len(tasks)] if tasks else f"step {t + 1}"
            messages.append({"role": "user", "content": task})
            body = {"model": model, "messages": messages, "stream": True,
                    "strata_session": "soak-live"}
            raw = _post_json(chat, body)
            evs = _parse_sse(raw)
            content = ""
            tcs = []
            for e in evs:
                if not isinstance(e, dict):
                    continue
                d = e.get("choices", [{}])[0].get("delta", {})
                content += d.get("content", "") or ""
                for tc in (d.get("tool_calls") or []):
                    tcs.append(tc)
            turn = {"id": t, "content": content, "tool_calls": tcs}
            turns_data.append(turn)
            r = judge_turn(turn, known={"filesystem__write", "shell__exec"}, use_llm=True)
            per.append(r)
            messages.append({"role": "assistant", "content": content,
                             "tool_calls": tcs})
            total_tools += len(tcs)
    except Exception as e:  # engine died mid-soak, gateway 502, etc.
        return {"mode": "live", "reachable": True, "ok": False,
                "error": f"soak aborted after {len(turns_data)} turns: {e}",
                "turns_run": len(turns_data), "tool_calls": total_tools,
                "per": per}

    jsess = judge_session(turns_data, known={"filesystem__write", "shell__exec"}, use_llm=True)
    failed = [p for p in per if not p["ok"]]
    if report_dir:
        os.makedirs(report_dir, exist_ok=True)
        with open(os.path.join(report_dir, "soak_turns.jsonl"), "w", encoding="utf-8") as fh:
            for td in turns_data:
                fh.write(json.dumps(td, ensure_ascii=False) + "\n")
    return {"mode": "live", "reachable": True, "turns": turns,
            "turns_run": len(turns_data), "tool_calls": total_tools,
            "failed_turns": len(failed), "judge_failed": jsess["failed"],
            "ok": len(failed) == 0, "per": per}


def main() -> int:
    ap = argparse.ArgumentParser(description="Soak-test the agent loop / live gateway.")
    ap.add_argument("--fake", action="store_true",
                    help="in-process deterministic soak (CI-safe, no network)")
    ap.add_argument("--rounds", type=int, default=24,
                    help="in-process: number of rounds in the long session")
    ap.add_argument("--gateway-url", default=None,
                    help="live: gateway base URL (e.g. http://127.0.0.1:8099)")
    ap.add_argument("--model", default="strata", help="live: upstream model id")
    ap.add_argument("--turns", type=int, default=20, help="live: number of real turns")
    ap.add_argument("--task", action="append", default=None,
                    help="live: a task to repeat across turns (repeatable)")
    ap.add_argument("--require-engine", action="store_true",
                    help="live: fail (exit 1) if the gateway/engine is unreachable")
    ap.add_argument("--report", default=os.path.join(ROOT, "logs", "soak_report.json"),
                    help="where to write the JSON report")
    args = ap.parse_args()

    live = bool(args.gateway_url)
    report_dir = os.path.dirname(args.report)
    if live:
        rep = soak_live(args.gateway_url, args.model, args.turns,
                        args.task or [], args.require_engine, report_dir)
    else:
        rep = soak_in_process(args.rounds)

    os.makedirs(report_dir or ".", exist_ok=True)
    with open(args.report, "w", encoding="utf-8") as fh:
        json.dump(rep, fh, ensure_ascii=False, indent=2)

    print("soak:")
    for k, v in rep.items():
        if k in ("per",):
            continue
        print(f"  {k}: {v}")
    print(f"  report written: {args.report}")

    # Neutral skip: engine intentionally off and we didn't require it.
    if live and rep.get("reachable") is False and not args.require_engine:
        print("soak: SKIP (engine not required, gateway unreachable)")
        return 0
    return 0 if rep.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
