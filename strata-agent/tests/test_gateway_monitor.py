"""Step2-A gateway regression: the request monitor records a per-chunk timeline of the
streamed agent-loop response and is ON by default (no --api-monitor flag needed).

Spins up a mock OpenAI-compatible upstream that returns a thinking + content + usage SSE,
starts the REAL gateway in --agent --serve mode pointed at it, issues a real
POST /v1/chat/completions, then reads GET /api/requests and asserts:
  - the latest record carries a non-empty chunk_timeline;
  - the timeline is classified into thinking / content / usage / done (in that order);
  - it ends with a "done" entry and chunk_timeline_truncated is False;
  - the monitor returns records with no --api-monitor flag (always-on lightweight mode).
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT = os.path.join(ROOT, "runtime")
PY = sys.executable

MOCK_PORT = 8241
GW_PORT = 8242
MODELS_CFG = os.path.join(ROOT, "tests", "_scratch_gw_mon_models.json")


class MockTimelineUpstream(BaseHTTPRequestHandler):
    """Returns one clean round: thinking delta, content delta, then a usage chunk. No tool
    call, so the agent loop finishes after a single round and emits [DONE]."""

    def do_POST(self):
        if self.path.rstrip("/").endswith("/v1/chat/completions"):
            seq = [
                {"choices": [{"delta": {"reasoning_content": "let me think step by step"}}]},
                {"choices": [{"delta": {"content": "hello from the timeline"}}]},
                {"choices": [{"delta": {}}],
                 "usage": {"prompt_tokens": 12, "completion_tokens": 6}},
            ]
            body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


def wait_http(port, path, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockTimelineUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": "E:/WorkBuddy",
                "FS_ALLOW_FILE": "E:/WorkBuddy/fs_allowed_roots.txt",
                "STRATA_MODELS_CONFIG": MODELS_CFG})
    with open(MODELS_CFG, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    # NOTE: no --api-monitor flag -> the lightweight monitor must still capture by default.
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK_PORT}/v1", "--model", "x", "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW_PORT, "/mcp"), "gateway did not come up"
        # drive a real chat so the agent loop streams a thinking/content/usage sequence
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": "hi"}],
                             "strata_session": "sess-abc"}).encode(),
            headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=30)
        raw = resp.read().decode("utf-8", "replace")
        events = []
        for block in raw.split("\n\n"):
            block = block.strip()
            if not block.startswith("data:"):
                continue
            p = block[5:].strip()
            if p == "[DONE]":
                events.append("[DONE]")
            else:
                try:
                    events.append(json.loads(p))
                except Exception:
                    pass
        assert any(e == "[DONE]" for e in events), "stream must end with [DONE]"
        assert any(isinstance(e, dict) and e.get("choices", [{}])[0].get("delta", {}).get("content")
                   for e in events), "expected a content delta in the stream"

        # read the monitor: it must be populated WITHOUT --api-monitor
        r = urllib.request.urlopen(f"http://127.0.0.1:{GW_PORT}/api/requests", timeout=5)
        mon = json.loads(r.read())
        assert "requests" in mon and isinstance(mon["requests"], list), "/api/requests shape"
        assert len(mon["requests"]) > 0, "monitor must record the chat by default (no --api-monitor)"
        rec = mon["requests"][0]          # newest first
        assert "chunk_timeline" in rec, "record must carry chunk_timeline"
        tl = rec["chunk_timeline"]
        types = [e["type"] for e in tl]
        print("chunk_timeline types:", types)
        assert len(tl) >= 4, f"timeline too short: {types}"
        assert "thinking" in types, f"expected a thinking entry: {types}"
        assert "content" in types, f"expected a content entry: {types}"
        assert "usage" in types, f"expected a usage entry: {types}"
        assert types[-1] == "done", f"timeline must end with done: {types}"
        # ordering: thinking before content before usage, all before done
        assert types.index("thinking") < types.index("content") < types.index("usage") < types.index("done"), \
            f"unexpected order: {types}"
        assert rec.get("chunk_timeline_truncated") is False, "small stream must not be truncated"
        # each entry is well-formed
        for e in tl:
            assert set(e.keys()) >= {"t", "type", "bytes"}, f"malformed timeline entry: {e}"
            assert isinstance(e["bytes"], int) and e["bytes"] >= 0
        # Step2-C: breakpoint annotation is frozen on the record even for a clean finish.
        assert rec.get("chunks") == len(tl), f"chunks count mismatch: {rec.get('chunks')} vs {len(tl)}"
        assert rec.get("last_chunk_type") == "done", f"last chunk type: {rec.get('last_chunk_type')}"
        assert rec.get("end_reason") == "done", f"clean finish must be end_reason=done: {rec.get('end_reason')}"
        assert rec.get("resumable") is False, "a clean finish is not a resumable stop"
        # Step3-B: the gateway captures the session id from the request body and freezes a
        # stable total duration (duration_s) so the time waterfall does not keep growing.
        assert rec.get("session_id") == "sess-abc", f"session_id not captured: {rec.get('session_id')}"
        dur = rec.get("duration_s")
        assert isinstance(dur, (int, float)) and dur > 0, f"duration_s not frozen: {dur}"
        print("GATEWAY MONITOR TIMELINE TEST PASSED")

    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(MODELS_CFG)
        except Exception:
            pass


class MockEmptyUpstream(BaseHTTPRequestHandler):
    """Returns one round with NO content and NO tool call -> the agent loop ends with a
    recoverable empty_round notice (Step2-C must annotate this as a breakpoint)."""

    def do_POST(self):
        if self.path.rstrip("/").endswith("/v1/chat/completions"):
            seq = [{"choices": [{"delta": {}}]}, {"choices": [{"delta": {}}]}]
            body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


def test_breakpoint_annotation():
    """A turn that ends with a recoverable notice must be recorded as a breakpoint:
    end_reason starts with 'notice:', resumable is True, and chunks/last_chunk_type are set."""
    MOCK = 8245
    GW = 8246
    CFG = os.path.join(ROOT, "tests", "_scratch_gw_mon_empty.json")
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockEmptyUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": "E:/WorkBuddy",
                "FS_ALLOW_FILE": "E:/WorkBuddy/fs_allowed_roots.txt",
                "STRATA_MODELS_CONFIG": CFG})
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW, "/mcp"), "gateway did not come up"
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": "hi"}]}).encode(),
            headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=30)
        raw = resp.read().decode("utf-8", "replace")
        assert "strata_notice" in raw, "expected a recoverable notice for the empty round"
        assert "[DONE]" in raw, "stream must still terminate with [DONE]"
        r = urllib.request.urlopen(f"http://127.0.0.1:{GW}/api/requests", timeout=5)
        mon = json.loads(r.read())
        rec = mon["requests"][0]
        er = rec.get("end_reason", "")
        print("end_reason:", er, "| resumable:", rec.get("resumable"),
              "| chunks:", rec.get("chunks"), "| last:", rec.get("last_chunk_type"))
        assert er.startswith("notice:"), f"recoverable stop must be a notice breakpoint: {er}"
        assert rec.get("resumable") is True, "empty_round (first time) is resumable"
        assert rec.get("chunks") is not None and rec.get("chunks") >= 1
        assert rec.get("last_chunk_type") == "done"
        print("GATEWAY BREAKPOINT ANNOTATION TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(CFG)
        except Exception:
            pass


if __name__ == "__main__":
    main()
    test_breakpoint_annotation()
