# -*- coding: utf-8 -*-
"""End-to-end (REAL gateway subprocess + REAL HTTP) test for plan A's thinking-only-round nudge.

test_empty_round.py proves the contract in-process (it imports GatewayHandler and only mocks
_llm_stream). This one closes the last mile: it boots a REAL gateway subprocess in --agent mode
pointed at a fake upstream that feeds a DETERMINISTIC sequence, so the finalize guard, the
nudge, the continue and the empty-round diagnostic all run through the real HTTP path the
frontend uses -- no mock of _llm_stream, the production code runs unmodified.

The deterministic sequence (fake upstream answers per POST, in order):
    request 1 -> a pure thinking round: reasoning_content, then finish_reason=stop,
                 no content, no tool call. This is EXACTLY the "it just stopped" shape.
    request 2 -> the answer the guard's nudge earned -- a real reply the user can act on.

What this test pins (the jump test_empty_round could only prove at the contract layer):
  1. the FIRST thinking-only round is auto-nudged: the user sees NO stop notice (no
     strata_notice with code=empty_round), because only ONE empty round happened;
  2. after the nudge the model produced a real answer (it reached the fake upstream a 2nd time);
  3. the FIRST thinking-only round STILL wrote a diagnostic line to empty-round.jsonl with
     empty_streak=1 -- proof the nudge+continue chain (not the >=2 stop path) is what ran;
  4. the turn ends cleanly with [DONE] and no fatal error.

If plan A were absent, a thinking-only round would break straight to [DONE] after ONE upstream
call, the fake upstream would never be hit a 2nd time, no real answer would appear, and the
diagnostic would report empty_streak=1 with no follow-up request. This test makes that the
falsifiable outcome. Pure standard library, no real model, no network beyond localhost.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT = os.path.join(ROOT, "runtime")
PY = sys.executable

MOCK_PORT = 8251
GW_PORT = 8252
MODELS_CFG = os.path.join(ROOT, "tests", "_scratch_er_e2e_models.json")
# diagnostic dir isolated so the real logs/ empty-round.jsonl is NEVER touched
DIAG_DIR = os.path.join(ROOT, "tests", "_scratch_er_e2e_diag")

# what the fake upstream answers, per POST (0-based order)
SEQUENCE = [
    # request 1: pure thinking round -- reasoning, clean stop, no content, no tool call
    [{"choices": [{"delta": {"reasoning_content": "I need to look into this further before acting."}}]},
     {"choices": [{"delta": {}, "finish_reason": "stop"}]}],
    # request 2: the answer the guard's nudge earned -- a real reply the user can act on
    [{"choices": [{"delta": {"content": "All done."}}]},
     {"choices": [{"delta": {}, "finish_reason": "stop"}]}],
]

# the nudge text the gateway appends as a user turn (read verbatim from http_server.py L2361-2364)
NUDGE_MARK = "只有思考链"


class SeqUpstream(BaseHTTPRequestHandler):
    """Answers each POST with the next scripted sequence, and records the exact JSON body the
    gateway forwarded, so the test can prove the nudge actually reached the model."""
    counter = 0
    seen = []

    def do_POST(self):
        n = SeqUpstream.counter
        SeqUpstream.counter += 1
        try:
            ln = int(self.headers.get("Content-Length") or 0)
            SeqUpstream.seen.append(json.loads(self.rfile.read(ln).decode("utf-8")))
        except Exception:
            SeqUpstream.seen.append({})
        seq = SEQUENCE[n] if n < len(SEQUENCE) else SEQUENCE[-1]
        body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def wait_http(port, path, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def parse(raw):
    events = []
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        p = block[5:].strip()
        if p == "[DONE]":
            events.append("[DONE]")
            continue
        try:
            events.append(json.loads(p))
        except Exception:
            pass
    return events


def main() -> int:
    SeqUpstream.counter = 0
    SeqUpstream.seen = []
    shutil.rmtree(DIAG_DIR, ignore_errors=True)
    os.makedirs(DIAG_DIR, exist_ok=True)

    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), SeqUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    with open(MODELS_CFG, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)

    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                "FS_ALLOW_FILE": os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "fs_allowed_roots.txt"),
                "STRATA_MODELS_CONFIG": MODELS_CFG,
                "STRATA_EMPTY_ROUND_DIR": DIAG_DIR})   # isolated diagnostic sink
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK_PORT}/v1", "--model", "x", "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW_PORT, "/mcp"), "gateway did not come up"
        rq = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/v1/chat/completions",
            data=json.dumps({"strata_session": "e2e-er-1",
                             "messages": [{"role": "user", "content": "do the thing"}]}).encode(),
            headers={"Content-Type": "application/json"})
        raw = urllib.request.urlopen(rq, timeout=60).read().decode("utf-8", "replace")
        ev = parse(raw)

        # --- 1) first thinking-only round is nudged: NO empty_round stop notice to the user ---
        notices = [e["strata_notice"] for e in ev if isinstance(e, dict) and e.get("strata_notice")]
        assert len(notices) == 0, f"expected no notice (model recovered after nudge), got {notices}"

        # --- 2) the nudge earned a real answer: fake upstream was hit a 2nd time, and it replied ---
        assert SeqUpstream.counter == 2, (
            f"guard must continue to a 2nd round after the nudge; fake upstream hit {SeqUpstream.counter} times")
        assert any("All done" in json.dumps(e, ensure_ascii=False) for e in ev), \
            "a real answer must reach the user after the nudge"

        # the forwarded 2nd request must literally carry the nudge as a user turn + the thinking
        # as the assistant turn -- proof the continue rebuilt messages exactly as plan A specifies.
        fwd2 = SeqUpstream.seen[1] if len(SeqUpstream.seen) > 1 else {}
        msgs = fwd2.get("messages", [])
        roles = [m.get("role") for m in msgs]
        assert roles.count("assistant") >= 1 and roles.count("user") >= 2, \
            f"2nd request must carry assistant(thinking)+user(nudge) appended, roles={roles}"
        assert any(NUDGE_MARK in (m.get("content") or "") for m in msgs if m.get("role") == "user"), \
            "the nudge instruction text must be the user turn that pushed the model to act"

        # --- 3) the FIRST thinking-only round wrote a diagnostic with empty_streak=1 ---
        path = os.path.join(DIAG_DIR, "empty-round.jsonl")
        assert os.path.exists(path), "the first empty round must still leave a diagnostic trail"
        lines = [json.loads(x) for x in io.open(path, encoding="utf-8").read().splitlines() if x.strip()]
        assert len(lines) == 1, f"exactly one empty-round diagnostic expected, got {len(lines)}"
        rec = lines[0]
        for key in ("ts", "round", "finish", "content_chars", "reasoning_chars", "empty_streak", "sampling"):
            assert key in rec, f"diagnostic missing {key}: {rec}"
        assert rec["empty_streak"] == 1, f"first thinking-only round must be streak=1, got {rec}"
        assert rec["content_chars"] == 0 and rec["reasoning_chars"] > 0, rec

        # --- 4) clean finish, no fatal error ---
        assert ev and ev[-1] == "[DONE]", "turn must terminate with [DONE]"
        assert not any(isinstance(e, dict) and e.get("error") for e in ev), "no fatal error in stream"

        print("thinking streamed to UI:", any(
            isinstance(e, dict) and "reasoning_content" in json.dumps(e) for e in ev))
        print("E2E EMPTY-ROUND (real subprocess): PASSED")
        return 0
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        shutil.rmtree(DIAG_DIR, ignore_errors=True)
        try:
            os.remove(MODELS_CFG)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
