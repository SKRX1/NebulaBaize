# -*- coding: utf-8 -*-
"""GET/POST /api/prompt-book — the prompt book (positive+negative pairs with a params
snapshot) + the dual-written seed book, in ONE file: config/prompt_book.json, so both ride
into git and the daily bundle backup (localStorage alone never does).

Verifies, against a REAL gateway subprocess (the interrupt-log test's harness pattern):
  (a) GET on a fresh (isolated via STRATA_PROMPT_BOOK) file returns two empty lists;
  (b) POST stores a prompt pair (with params) + a seed entry and GET reads them back;
  (c) POST replaces wholesale — a POST missing one list is 400, never a silent partial write;
  (d) the .bak keeps the previous document (backup-before-write);
  (e) caps trim the POSTed lists (the frontend's own caps mirrored server-side).
"""
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(ROOT))
FS_ALLOW_FILE = os.path.join(WORKSPACE_ROOT, "fs_allowed_roots.txt")
RT = os.path.join(ROOT, "runtime")
PY = __import__("sys").executable

MOCK = 8261
GW = 8262
BOOK = os.path.join(ROOT, "tests", "_scratch_prompt_book.json")


class MockUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(404); self.end_headers()
    def log_message(self, *a):
        pass


def wait_http(port, path="/mcp"):
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2)
            return True
        except Exception:
            time.sleep(0.25)
    return False


def main():
    for p in (BOOK, BOOK + ".bak"):
        try:
            os.remove(p)
        except OSError:
            pass
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT, "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_PROMPT_BOOK": BOOK})
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--url", f"http://127.0.0.1:{MOCK}/v1",
         "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def get():
        with urllib.request.urlopen(f"http://127.0.0.1:{GW}/api/prompt-book", timeout=5) as r:
            return json.loads(r.read())

    def post(payload):
        rq = urllib.request.Request(f"http://127.0.0.1:{GW}/api/prompt-book",
                                    data=json.dumps(payload).encode(),
                                    headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(rq, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    try:
        assert wait_http(GW, "/api/prompt-book"), "gateway did not come up"

        # (a) fresh file -> two empty lists
        doc = get()
        assert doc == {"prompts": [], "seeds": []}, doc
        print("prompt-book GET: fresh file -> empty lists OK")

        # (b) the pair + params snapshot + a seed entry, round-tripped
        pair = {"name": "fox", "positive": "a red fox, cinematic", "negative": "blurry",
                "params": {"steps": "12", "cfg": "2.5", "sampling": "euler_a",
                           "scheduler": "karras", "eta": "0.4", "seed": "777"}}
        seed = {"seed": 777, "prompt": "a red fox, cinematic", "ts": 1}
        st, saved = post({"prompts": [pair], "seeds": [seed]})
        assert st == 200, (st, saved)
        doc = get()
        assert doc["prompts"][0]["positive"] == pair["positive"], doc
        assert doc["prompts"][0]["negative"] == pair["negative"], doc
        assert doc["prompts"][0]["params"]["scheduler"] == "karras", doc
        assert doc["seeds"][0]["seed"] == 777, doc
        print("prompt-book POST+GET: pair + params snapshot + seed entry OK")

        # (c) a POST missing one list -> 400, never a silent partial write
        st, body = post({"prompts": []})
        assert st == 400, (st, body)
        print("prompt-book POST: missing seeds list -> 400 OK")

        # (d) the previous document survived in .bak (backup-before-write)
        post({"prompts": [], "seeds": []})
        with open(BOOK + ".bak", encoding="utf-8") as f:
            bak = json.load(f)
        assert bak["prompts"] and bak["prompts"][0]["name"] == "fox", bak
        print("prompt-book .bak: previous doc kept OK")

        # (e) server-side caps trim (200 prompts / 50 seeds)
        st, saved = post({"prompts": [{"name": str(i)} for i in range(250)],
                          "seeds": [{"seed": i} for i in range(80)]})
        assert st == 200 and len(saved["prompts"]) == 200 and len(saved["seeds"]) == 50, saved
        print("prompt-book caps: 250->200 prompts, 80->50 seeds OK")
        print("PROMPT-BOOK TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        for p in (BOOK, BOOK + ".bak"):
            try:
                os.remove(p)
            except OSError:
                pass


if __name__ == "__main__":
    main()
