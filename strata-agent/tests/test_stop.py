"""Tests for the streaming Stop/cancel chain.

Two layers:

1. Unit (fast, always runs): the GatewayState stream-cancellation registry
   (register / cancel / unregister) and the executor honouring a cancel Event.

2. Integration (spins up the real gateway in --agent mode against a mock upstream
   that streams slowly): a Stop click must end the gateway's SSE promptly AND make
   the gateway drop the upstream socket (so the 8080 engine stops generating),
   instead of letting the model stream to completion into a closed client pipe.
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


# ─── Unit: GatewayState registry ──────────────────────────────────────────────────
def test_state_registry():
    # import the gateway module directly (it is pure stdlib)
    sys.path.insert(0, RT)
    import http_server as hs
    st = hs.GatewayState("http://127.0.0.1:1", model="x")

    # unknown id -> cancel returns False
    assert st.cancel_stream("nope") is False

    ev = st.register_stream("s1")
    assert isinstance(ev, threading.Event)
    assert st.cancel_stream("s1") is True
    assert ev.is_set()

    # second cancel is a no-op but still reports True (id still known until unregister)
    assert st.cancel_stream("s1") is True
    st.unregister_stream("s1")
    assert st.cancel_stream("s1") is False

    # a stream with no id uses an unregistered local Event (still cancellable by disconnect)
    ev2 = st.register_stream(None)
    assert not st.cancel_stream("anything")  # never registered under an id
    ev2.set()
    assert ev2.is_set()
    print("unit: GatewayState registry OK")


# ─── Integration: real gateway + mock slow upstream ───────────────────────────────
class SlowUpstream(BaseHTTPRequestHandler):
    """Streams N content tokens, each delayed, and records whether the client dropped
    the connection mid-stream (proving the gateway closed the upstream socket)."""
    tokens = 0
    client_gone = False
    exc_type = ""
    lock = threading.Lock()

    def do_POST(self):
        # Emit a long, slow stream so a non-cancelling client would block for seconds.
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        n = 0
        try:
            while True:  # no [DONE]: keep streaming until the client disconnects
                d = {"choices": [{"delta": {"content": f"tok{n} "}}]}
                self.wfile.write(("data: " + json.dumps(d) + "\n\n").encode())
                self.wfile.flush()
                n += 1
                time.sleep(0.05)
        except Exception as e:
            with SlowUpstream.lock:
                SlowUpstream.client_gone = True
                SlowUpstream.tokens = n
                SlowUpstream.exc_type = type(e).__name__

    def log_message(self, *a):
        pass


def _wait_port(port, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def test_stop_integration():
    SlowUpstream.tokens = 0
    SlowUpstream.client_gone = False
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), SlowUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": "E:/WorkBuddy",
                "FS_ALLOW_FILE": "E:/WorkBuddy/fs_allowed_roots.txt"})
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK_PORT}/v1", "--model", "x", "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert _wait_port(GW_PORT), "gateway did not come up"

        stop_id = "test-stop-1"
        # Open the chat stream (no read timeout so it would block until upstream ends)
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": "hi"}],
                             "stop_id": stop_id}).encode(),
            headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=30)

        # Read tokens in a background thread until the gateway closes the connection.
        got = {"n": 0, "data": b""}

        def reader():
            try:
                while True:
                    chunk = resp.read(1)
                    if not chunk:
                        break
                    got["data"] += chunk
                    got["n"] += 1
            except Exception:
                pass

        thr = threading.Thread(target=reader, daemon=True)
        thr.start()

        # Let a little stream through, then click Stop.
        time.sleep(0.6)
        sreq = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/api/chat/stop",
            data=json.dumps({"stop_id": stop_id}).encode(),
            headers={"Content-Type": "application/json"})
        sresp = urllib.request.urlopen(sreq, timeout=5)
        sjson = json.loads(sresp.read())
        print("stop response:", sjson)
        assert sjson.get("ok") is True and sjson.get("stopped") is True, "stop must report stopped=True"

        # The gateway should end the stream quickly (well under the ~full upstream time).
        thr.join(timeout=5)
        elapsed = time.time()
        assert not thr.is_alive(), "gateway stream did not end after Stop"
        body = got["data"].decode("utf-8", "replace")
        # It must have ended early: it cannot have streamed the whole (unbounded) sequence.
        # A few tokens arrived (we let 0.6s pass at 20 tok/s => ~12 token frames).
        assert got["n"] > 0, "no tokens were streamed before Stop"
        # The upstream must have seen the client (gateway) disconnect -> it stopped generating.
        # The gateway closes its upstream socket before ending the client stream, but the upstream
        # only notices on its next write (it sleeps 50ms per token), so poll briefly for the race.
        for _ in range(60):
            if SlowUpstream.client_gone:
                break
            time.sleep(0.05)
        assert SlowUpstream.client_gone is True, "gateway did not close the upstream socket"

        # A second stop with the same (now-finished) id must report stopped=False.
        sresp2 = urllib.request.urlopen(sreq, timeout=5)
        assert json.loads(sresp2.read()).get("stopped") is False, "stale id must report stopped=False"
        print("integration: Stop ended stream early and dropped upstream socket OK")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        # diagnostics
        print("DIAG upstream:", SlowUpstream.client_gone, "tokens:", SlowUpstream.tokens,
              "exc:", SlowUpstream.exc_type)
        try:
            out = gw.stdout.read()
            print("DIAG gateway tail:\n", out[-1500:] if out else "(none)")
        except Exception as e:
            print("DIAG gateway read err:", e)


def main():
    test_state_registry()
    test_stop_integration()
    print("\nTEST_STOP PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("TEST_STOP FAILED:", repr(e))
        sys.exit(1)
