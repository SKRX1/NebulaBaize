"""End-to-end reproduction of the reported bug: choosing a LOCAL instance, typing its service
address (a non-empty base_url = a sibling on another port), and ticking "tool calls" used to
make tools UNAVAILABLE, while leaving the address empty kept them working.

Root cause (now fixed): the gateway's route sent a local entry that had a base_url to a plain
proxy -- assuming a sibling "runs its own tools" -- so the checked tools never ran here. The fix
routes such a request to the gateway's OWN agent loop, pointed at that base_url (it honours
_model_override), which is exactly what "由本机执行 MCP 工具" promises.

What this integration test proves against a REAL gateway subprocess (not just the pure predicate
in test_local_sibling_loop.py):
  - a request aimed at a local entry WITH a base_url, tools not turned off, reaches the agent
    loop: the stream carries strata_mcp call + result events and the local tool actually writes
    the file. A plain proxy would forward the mock's own stream and inject NO strata_mcp events,
    so the presence of those events IS the load-bearing signal the fix works.
  - the LLM in that loop is the entry's base_url (the mock), proving _model_override is honoured
    (the request went to the sibling, not to the gateway's default upstream).
  - the same entry with tools:false is NOT looped: no strata_mcp events (the checkbox OFF is
    honoured, the request is proxied as before).

Isolated registry + isolated output file; the real models.json and filesystem are untouched.
Run standalone: python tests/test_local_sibling_e2e.py
"""
from __future__ import annotations

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

MOCK_PORT = 8251
GW_PORT = 8252
E2E_FILE = os.path.join(WORKSPACE_ROOT, "__gw_local_sibling__", "hit.txt")
MODELS_CFG = os.path.join(ROOT, "tests", "_scratch_local_sibling_models.json")
TOOL = "filesystem__write"


class MockUpstream(BaseHTTPRequestHandler):
    """The first turn emits a tool call for a LOCAL MCP tool; the second finishes the turn.
    Records every body it receives so the test can confirm the loop used THIS base + model."""
    seen = []
    counter = 0

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            MockUpstream.seen.append(json.loads(self.rfile.read(n).decode("utf-8")))
        except Exception:
            MockUpstream.seen.append({})
        MockUpstream.counter += 1
        if MockUpstream.counter == 1:
            seq = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1",
                    "function": {"name": TOOL, "arguments": json.dumps(
                        {"path": E2E_FILE, "content": "sibling ok"})}}]}}]},
                   {"choices": [{"delta": {}}]}]
        else:
            seq = [{"choices": [{"delta": {"content": "done"}}]}, {"choices": [{"delta": {}}]}]
        body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def wait_port(port, timeout=25):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def write_models(tools_flag):
    """A local entry WITH a base_url = the mock. tools_flag True/False is the only difference
    between the two turns (the load-bearing single-variable flip)."""
    entry = {"id": "sib", "name": "Sib", "kind": "local",
             "base_url": f"http://127.0.0.1:{MOCK_PORT}/v1", "model": "sib-model"}
    if tools_flag is not None:
        entry["tools"] = tools_flag
    with open(MODELS_CFG, "w", encoding="utf-8") as f:
        json.dump({"selected": "sib", "models": [entry]}, f)


def stream_chat(gw_port, session_id):
    req = urllib.request.Request(
        f"http://127.0.0.1:{gw_port}/v1/chat/completions",
        data=json.dumps({"model": "sib", "stream": True, "strata_session": session_id,
                         "messages": [{"role": "user", "content": "write a file"}]}).encode(),
        headers={"Content-Type": "application/json"})
    raw = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    evs = []
    for block in raw.split("\n\n"):
        block = block.strip()
        if not block.startswith("data:"):
            continue
        p = block[5:].strip()
        if p == "[DONE]":
            continue
        try:
            evs.append(json.loads(p))
        except Exception:
            pass
    return evs


def main():
    for p in (E2E_FILE,):
        try:
            os.remove(p)
        except OSError:
            pass
    os.makedirs(os.path.dirname(E2E_FILE), exist_ok=True)

    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS_CFG})
    # the gateway's DEFAULT upstream is also the mock, so even the self path would reach it;
    # what distinguishes the turns is ONLY the entry's tools flag (the load-bearing flip).
    write_models(tools_flag=True)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK_PORT}/v1", "--model", "default-model",
         "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_port(GW_PORT), "gateway did not come up"

        # ---- turn 1: local entry WITH a base_url + tools:true -> the loop runs HERE ----
        evs = stream_chat(GW_PORT, "sib-on")
        call = next((e["strata_mcp"] for e in evs
                     if isinstance(e, dict) and isinstance(e.get("strata_mcp"), dict)
                     and e["strata_mcp"].get("event") == "call"), None)
        res = next((e["strata_mcp"] for e in evs
                    if isinstance(e, dict) and isinstance(e.get("strata_mcp"), dict)
                    and e["strata_mcp"].get("event") == "result"), None)
        print("turn-1 call:", call and call.get("name"), "| result ok:", res and res.get("ok"))
        assert call is not None, ("BUG: a local entry with a base_url + tools:true must run our "
                                  "tools (no strata_mcp call means it was sent to a plain proxy)")
        assert res is not None and res.get("ok") is True, "the local tool should have run"
        assert os.path.exists(E2E_FILE) and open(E2E_FILE, encoding="utf-8").read() == "sibling ok", \
            "the local tool must actually write the file (proves the loop executed it here)"
        # the loop pointed the LLM at the entry's base_url + model, not the gateway default
        fwd = MockUpstream.seen[-1]
        assert fwd.get("model") == "sib-model", \
            f"the loop must use the entry's model name, got {fwd.get('model')!r}"
        assert any(t.get("function", {}).get("name") == TOOL or t.get("name") == TOOL
                   for t in (fwd.get("tools") or [])), "the loop must offer our MCP tools upstream"
        print("turn-1: local-with-address + tools:true ran our tools against the sibling base  [load-bearing]")

        # ---- turn 2: the SAME entry, tools:false -> NOT looped, proxied as before ----
        try:
            os.remove(E2E_FILE)
        except OSError:
            pass
        MockUpstream.counter = 0   # reset so the mock emits a tool call again -- but it must be IGNORED
        MockUpstream.seen = []
        write_models(tools_flag=False)   # the checkbox OFF; the registry is re-read per request
        evs2 = stream_chat(GW_PORT, "sib-off")
        call2 = next((e for e in evs2 if isinstance(e, dict)
                      and isinstance(e.get("strata_mcp"), dict)
                      and e["strata_mcp"].get("event") in ("call", "result")), None)
        print("turn-2 has strata_mcp events:", call2 is not None)
        assert call2 is None, ("tools:false must NOT run our tools: the request must be proxied "
                               "unchanged (the checkbox OFF is honoured)")
        assert not os.path.exists(E2E_FILE), "with tools off the local tool must not have run"
        print("turn-2: the SAME entry with tools:false is proxied, tools off  [load-bearing]")

        print("\nLOCAL-SIBLING E2E PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        for p in (E2E_FILE, MODELS_CFG):
            try:
                os.remove(p)
            except OSError:
                pass
        try:
            os.rmdir(os.path.dirname(E2E_FILE))
        except OSError:
            pass


if __name__ == "__main__":
    main()
