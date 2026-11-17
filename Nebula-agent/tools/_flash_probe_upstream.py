r"""
Flash-crash main-channel probe (REAL process, no stubs).

Goal: falsifiably prove the "generation barely started -> client cancels -> frontend logs
a stopped fast-stop record" path is a REAL end-to-end channel through the gateway, not just
a pure-function stub. Three legs must all light green for VERDICT=PASS:

  P1  The mock upstream really received the forwarded chat request (stream:true + a user msg)
      -- proves the gateway proxied the client's stream to the engine.
  P2  A node client that mirrors app.js streamAssistant (fetch(stream)+body.getReader()), reads
      at least ONE token frame, then calls controller.abort(). The next read() must reject with
      AbortError -- this is EXACTLY the condition app.js uses to set m.stopped=true (L7266).
  P3  The mock upstream observed the client disconnect mid-stream (client_gone=True, tokens>0)
      and saw its own write fail -> gateway really closed the upstream socket (engine stops).

Ports kept off the live instances: MOCK=8251, GW=8252 (avoid subprocess collision per project rule).
Pure-stdlib on the Python side; node is only the faithful browser fetch/abort leg.
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
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(ROOT))
FS_ALLOW_FILE = os.path.join(WORKSPACE_ROOT, "fs_allowed_roots.txt")
RT = os.path.join(ROOT, "runtime")
PY = sys.executable
NODE = "node"
MOCK_PORT = 8251
GW_PORT = 8252
CLIENT_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_flash_probe_client.mjs")

STATE = {"forwarded": None, "client_gone": False, "tokens": 0, "exc_type": ""}
LOCK = threading.Lock()


class MockUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            body = {"_unparsed": True}
        with LOCK:
            STATE["forwarded"] = {
                "stream": body.get("stream"),
                "has_user": any(m.get("role") == "user" for m in body.get("messages", [])),
                "stop_id": body.get("stop_id"),
            }
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        cnt = 0
        try:
            while True:  # no [DONE]: stream until the client disconnects
                d = {"choices": [{"delta": {"content": "tok%d " % cnt}}]}
                self.wfile.write(("data: " + json.dumps(d) + "\n\n").encode())
                self.wfile.flush()
                cnt += 1
                time.sleep(0.05)   # ~20 tok/s so an early cancel still lets >=1 frame land
        except Exception as e:
            with LOCK:
                STATE["client_gone"] = True
                STATE["tokens"] = cnt
                STATE["exc_type"] = type(e).__name__

    def log_message(self, *a):
        pass


def _wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/mcp" % port, timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE})
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", "http://127.0.0.1:%d/v1" % MOCK_PORT, "--model", "x", "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    p2 = {"abort_error": False}
    try:
        assert _wait_port(GW_PORT), "gateway did not come up on %d" % GW_PORT

        # node client mirrors app.js streamAssistant fetch->reader->abort path (P2 leg)
        proc = subprocess.run(
            [NODE, CLIENT_JS, str(GW_PORT)], capture_output=True, text=True, timeout=40, cwd=ROOT)
        print("node stdout:\n" + proc.stdout.strip())
        for line in proc.stdout.splitlines():
            if "P2_ABORT_ERROR_OK" in line:
                p2["abort_error"] = True

        # give the upstream a moment to notice its write failed (50ms-per-token sleep)
        for _ in range(60):
            with LOCK:
                if STATE["client_gone"]:
                    break
            time.sleep(0.05)

    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()

    print("\n===== PROBE RESULT =====")
    f = STATE["forwarded"] or {}
    p1 = bool(f.get("stream")) and bool(f.get("has_user"))
    p2ok = p2["abort_error"]
    p3 = bool(STATE["client_gone"]) and STATE["tokens"] > 0
    print("P1 upstream-forwarded(stream+user):", "PASS" if p1 else "FAIL", "->", f)
    print("P2 reader AbortError -> m.stopped=true:", "PASS" if p2ok else "FAIL")
    print("P3 client_gone & gateway closed upstream (tokens>0):", "PASS" if p3 else "FAIL",
          "(tokens=%d exc=%s)" % (STATE["tokens"], STATE["exc_type"]))

    verdict = p1 and p2ok and p3
    print("VERDICT:", "PASS - main channel real end-to-end" if verdict else "FAIL")
    sys.exit(0 if verdict else 2)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("PROBE CRASH:", repr(e))
        sys.exit(1)
