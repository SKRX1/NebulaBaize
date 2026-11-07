"""Full HTTP integration test for the gateway direct-mode agent loop.

Spins up a mock OpenAI-compatible upstream (returns tool-call SSE), starts the REAL gateway in
--agent mode pointed at it, then issues a real POST /v1/chat/completions and verifies the
returned SSE contains strata_mcp call/result events, a final [DONE], and that the local tool
(filesystem__write) actually created the file. This exercises the whole HTTP path that the
frontend will use.
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

MOCK_PORT = 8231
GW_PORT = 8232
TEST_FILE = os.path.join(WORKSPACE_ROOT, "__gw_http__", "x.txt")
CAP_FILE = os.path.join(WORKSPACE_ROOT, "__gw_cap__", "never.txt")        # a capped tool call must NEVER create this
MODELS_CFG = os.path.join(ROOT, "tests", "_scratch_gw_models.json")   # never the real models.json


class MockUpstream(BaseHTTPRequestHandler):
    counter = 0

    def do_POST(self):
        MockUpstream.counter += 1
        n = MockUpstream.counter
        if n == 1:
            seq = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1",
                    "function": {"name": "filesystem__write",
                                 "arguments": json.dumps({"path": TEST_FILE, "content": "http ok"})}}]}}]},
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


class MockOverflowUpstream(BaseHTTPRequestHandler):
    """Simulates the 8080 engine refusing a too-long prompt: HTTP 400 with a
    'exceeds the context window' body (Strata's "requests are never truncated")."""

    def do_POST(self):
        if self.path.rstrip("/").endswith("/v1/chat/completions"):
            body = json.dumps({
                "error": {
                    "message": ("request exceeds the context window: prompt (131000 tokens) "
                                "leaves no room to answer in the context (131072); "
                                "requests are never truncated"),
                    "type": "invalid_request_error",
                }
            }).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, *a):
        pass


class MockPerSessionUpstream(BaseHTTPRequestHandler):
    """Returns a plain content completion plus a `usage` chunk reporting a LARGE prompt size
    (125000 of 131072). The gateway records that per session id, so:
      - the FIRST turn of a session records the big number but the guard cannot trip it (no prior);
      - a LATER turn of the SAME session trips the proactive guard (correct);
      - a turn of a DIFFERENT (new) session must NOT trip it (the bug we fixed: the old code leaked
        the previous task's occupancy into a brand-new, empty task)."""

    def do_POST(self):
        if self.path.rstrip("/").endswith("/v1/chat/completions"):
            seq = [{"choices": [{"delta": {"content": "ok"}}]},
                   {"choices": [{"delta": {}}], "usage": {"prompt_tokens": 125000,
                                                         "completion_tokens": 3}}]
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


class MockRoundCapUpstream(BaseHTTPRequestHandler):
    """Two turns that each end because the ROUND ran out of output budget (finish_reason=length):

      turn 1 -- pure reasoning, no content, no tool call   (the "它思考到一半就突然停了" case)
      turn 2 -- a tool call whose argument JSON stops mid-string (the "工具调用中突然断" case)

    Both used to end silently: the loop fell through to [DONE] with nothing produced and nothing
    said. finish_reason was never inspected, so a capped round was indistinguishable from a
    finished one.
    """
    counter = 0

    def do_POST(self):
        MockRoundCapUpstream.counter += 1
        n = MockRoundCapUpstream.counter
        if n == 1:
            seq = [{"choices": [{"delta": {"reasoning_content": "thinking hard. " * 20}}]},
                   {"choices": [{"delta": {}, "finish_reason": "length"}]}]
        else:
            args = json.dumps({"path": CAP_FILE, "content": "abc"})[:28]   # cut off on purpose
            seq = [{"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1",
                      "function": {"name": "filesystem__write", "arguments": args}}]}}]},
                   {"choices": [{"delta": {}, "finish_reason": "length"}]}]
        body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def wait_port(port, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/mcp", timeout=1)
            return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    # 1) mock upstream
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()

    # 2) real gateway in --agent mode
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS_CFG})
    with open(MODELS_CFG, "w", encoding="utf-8") as f:      # seeded, isolated registry
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"},
            {"id": "m2", "name": "M2", "kind": "local", "base_url": "", "model": "m2"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK_PORT}/v1", "--model", "x", "--port", str(GW_PORT)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_port(GW_PORT), "gateway did not come up"
        # 3) GET /mcp through the gateway (should expose local tools)
        r = urllib.request.urlopen(f"http://127.0.0.1:{GW_PORT}/mcp", timeout=5)
        mcp = json.loads(r.read())
        print("gateway /mcp:", [s["name"] for s in mcp["servers"]], "tools:", mcp["tools"])
        assert mcp["tools"] > 0

        # 3b) GET /workspace/list — the picker's folder browser. Direct mode answers locally:
        #     an absolute path must come back real (this is the "工作区显示不出完整路径" fix).
        import urllib.parse as _up
        r = urllib.request.urlopen(
            f"http://127.0.0.1:{GW_PORT}/workspace/list?path=" + _up.quote(ROOT), timeout=5)
        wl = json.loads(r.read())
        assert wl["listing"] and wl["listing"]["exists"] is True, "an existing folder must list"
        assert os.path.normcase(wl["listing"]["path"]) == os.path.normcase(ROOT), wl["listing"]["path"]
        assert any(d["name"] == "serve" for d in wl["listing"]["dirs"]), "sub-folders must appear"
        # no path -> roots to start from, no listing
        r = urllib.request.urlopen(f"http://127.0.0.1:{GW_PORT}/workspace/list", timeout=5)
        wr = json.loads(r.read())
        assert wr["listing"] is None and wr["drives"], "no path must return drive roots"
        print("gateway /workspace/list: existing folder + roots OK")

        # 3c) /api/models — the model switcher's contract. Two rules the UI depends on:
        #     a) GET and POST answer the SAME shape, `probe` included. A write that dropped
        #        `probe` blanked the status dot until the next poll ("必须点击才刷新").
        #     b) Omitting `models` keeps the list (省略=保留); an explicit [] still clears it.
        def _models(method="GET", payload=None):
            data = None if payload is None else json.dumps(payload).encode()
            rq = urllib.request.Request(f"http://127.0.0.1:{GW_PORT}/api/models", data=data,
                                        headers={"Content-Type": "application/json"}, method=method)
            with urllib.request.urlopen(rq, timeout=5) as rp:
                return json.loads(rp.read())

        g = _models()
        assert "probe" in g, "GET must report liveness"
        p1 = _models("POST", {"selected": "m2"})
        assert [m["id"] for m in p1["models"]] == ["m1", "m2"], "omitted models must be kept, not wiped"
        assert p1["selected"] == "m2"
        assert "probe" in p1, "POST must answer the same shape as GET (probe included)"
        p2 = _models("POST", {"models": []})
        assert p2["models"] == [], "an explicit empty list must still clear the registry"
        print("gateway /api/models: probe on both verbs, omitted models kept, [] clears")

        # 4) POST /v1/chat/completions -> agent loop should call the tool
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": "写个文件"}]}).encode(),
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
        call_evt = next((e for e in events if isinstance(e, dict) and e.get("strata_mcp", {}).get("event") == "call"), None)
        res_evt = next((e for e in events if isinstance(e, dict) and e.get("strata_mcp", {}).get("event") == "result"), None)
        print("call:", call_evt and call_evt["strata_mcp"]["name"], "| result ok:", res_evt and res_evt["strata_mcp"]["ok"])
        assert call_evt, "missing strata_mcp call"
        assert res_evt and res_evt["strata_mcp"]["ok"] is True, "tool should succeed"
        assert any(e == "[DONE]" for e in events), "missing [DONE]"
        assert not any(isinstance(e, dict) and e.get("error") for e in events), "error in stream"
        assert os.path.exists(TEST_FILE) and open(TEST_FILE, encoding="utf-8").read() == "http ok"
        print("\nFULL HTTP INTEGRATION PASSED")

        # 3d) /api/runtime-config — live tuning of the gateway's own agent-loop + executor
        #     caps. Uses an ISOLATED --config so the real mcp_servers.json is never written.
        test_runtime_config()

        # 3e) Context-window overflow: upstream 8080 returns HTTP 400 "exceeds the context window".
        #     Must become a recoverable `strata_notice` (code context_overflow), NOT a fatal error.
        test_context_overflow()

        # 3f) Proactive guard must NOT leak a previous task's occupancy into a brand-new session.
        test_context_guard_per_session()

        # 3g) Interruption log: every turn that did not finish cleanly is recorded with the
        #     phase it died in -- the evidence behind "it just stopped while thinking/in a tool".
        test_interrupt_log()

        # 3h) A round cut by the output cap must say WHY (resumable max_tokens notice) and must
        #     never run a tool whose arguments were truncated.
        test_round_cap()
        test_reasoning_effort()

    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(TEST_FILE)
            os.rmdir(os.path.dirname(TEST_FILE))
        except Exception:
            pass
        try:
            os.remove(MODELS_CFG)
        except Exception:
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


def test_runtime_config():
    """GET/POST /api/runtime-config: live tuning of the gateway's own caps, persisted to an
    isolated config file (never the real mcp_servers.json). Also confirms the endpoint is 404
    outside direct mode (proxy), so the UI hides the card there."""
    MOCK = 8234
    GW = 8233
    PROXY = 8243
    CFG = os.path.join(ROOT, "tests", "_scratch_rt_cfg.json")
    src = os.path.join(ROOT, "config", "mcp_servers.json")
    with open(src, encoding="utf-8") as f:
        json.dump(json.load(f), open(CFG, "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)

    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS_CFG})
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW),
         "--config", CFG],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW, "/mcp"), "runtime-config gateway did not come up"
        base = f"http://127.0.0.1:{GW}/api/runtime-config"

        def get():
            with urllib.request.urlopen(base, timeout=5) as r:
                return json.loads(r.read())

        def post(setmap):
            rq = urllib.request.Request(base, data=json.dumps({"set": setmap}).encode(),
                                        headers={"Content-Type": "application/json"}, method="POST")
            with urllib.request.urlopen(rq, timeout=5) as r:
                return json.loads(r.read())

        doc = get()
        assert set(doc.keys()) >= {"keys", "file", "mode"}, doc
        names = {k["key"] for k in doc["keys"]}
        assert {"max_rounds", "turn_budget_s", "idle_timeout_s",
                "timeout_s", "server_timeout_s", "max_result_chars"} <= names, names
        by = {k["key"]: k for k in doc["keys"]}
        # 往返一致性契约：断言 GET == 复制源 CFG 自己的值（config有该键就用它，
        # 没有才用schema默认）。改config值永久免疫，测试测的是"网关如实反映配置"这条真契约。
        src_mcp = json.load(open(CFG, encoding="utf-8")).get("mcp", {})
        for _k, _dflt in (("max_rounds", 1000), ("timeout_s", 330), ("max_result_chars", 30000)):
            _want = src_mcp.get(_k, _dflt)
            assert by[_k]["value"] == _want, (_k, by[_k]["value"], "expected", _want)
        print("runtime-config GET: 6 keys, live default values OK")

        res = post({"max_rounds": 123, "timeout_s": 400})
        assert set(res["changed"]) == {"max_rounds", "timeout_s"}, res
        by2 = {k["key"]: k for k in get()["keys"]}
        assert by2["max_rounds"]["value"] == 123, by2["max_rounds"]
        assert by2["timeout_s"]["value"] == 400, by2["timeout_s"]
        print("runtime-config POST: applied live, GET reflects new values")

        rq = urllib.request.Request(base, data=json.dumps({"set": {"max_rounds": -1}}).encode(),
                                    headers={"Content-Type": "application/json"}, method="POST")
        try:
            urllib.request.urlopen(rq, timeout=5)
            assert False, "negative value should 400"
        except urllib.error.HTTPError as e:
            assert e.code == 400, e.code
        print("runtime-config POST: negative value rejected (400)")

        with open(CFG, encoding="utf-8") as f:
            saved = json.load(f)
        assert saved["mcp"]["max_rounds"] == 123, saved["mcp"]
        assert saved["mcp"]["timeout_s"] == 400, saved["mcp"]
        print("runtime-config POST: persisted to isolated config mcp block")

        # Outside direct mode the endpoint must 404 so the UI hides the card.
        gw2 = subprocess.Popen(
            [PY, "gateway.py", "--serve",
             "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(PROXY),
             "--config", CFG],
            cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        try:
            assert wait_http(PROXY, "/"), "proxy gateway did not come up"
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{PROXY}/api/runtime-config", timeout=5)
                assert False, "proxy mode must 404 runtime-config"
            except urllib.error.HTTPError as e:
                assert e.code == 404, e.code
            print("runtime-config: 404 in proxy mode (UI hides card)")
        finally:
            gw2.terminate()
            try:
                gw2.wait(timeout=5)
            except Exception:
                gw2.kill()
        print("RUNTIME-CONFIG TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        for p in (CFG, CFG + ".bak-rt"):
            try:
                os.remove(p)
            except Exception:
                pass


def test_context_overflow():
    """Regression: when the upstream (8080) refuses with HTTP 400 'exceeds the context window', the
    gateway must emit a recoverable `strata_notice` (code context_overflow) and still end with [DONE] --
    NOT wrap it as a fatal 'upstream error: Bad Request' red box that kills the turn.

    Reproduces the user's "流式工作时 2 次都报错" case: a long session's prompt outgrew the 131072
    context window and 8080 returned 400. Previously the gateway turned that into a fatal error; now
    it is a resumable notice so the user can compact history and continue."""
    MOCK = 8235
    GW = 8236
    MODELS = os.path.join(ROOT, "tests", "_scratch_gw_overflow_models.json")
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockOverflowUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS})
    with open(MODELS, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW, "/mcp"), "overflow gateway did not come up"
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW}/v1/chat/completions",
            data=json.dumps({"messages": [{"role": "user", "content": "继续之前的长对话"}]}).encode(),
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
        notice_evt = next((e for e in events if isinstance(e, dict)
                           and e.get("strata_notice", {}).get("code") == "context_overflow"), None)
        print("overflow notice:", notice_evt)
        assert notice_evt, "expected a recoverable context_overflow notice (got none)"
        assert notice_evt.get("strata_notice", {}).get("resumable") is True, "notice must be resumable"
        assert not any(isinstance(e, dict) and e.get("error") for e in events), "no fatal error in stream"
        assert any(e == "[DONE]" for e in events), "stream must still end with [DONE]"
        print("CONTEXT-OVERFLOW NOTICE TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(MODELS)
        except Exception:
            pass


def test_context_guard_per_session():
    """Regression for the 'new empty workspace shows 90%+ context' bug.

    The proactive context guard used a single server-global `last_prompt_tokens`. After a long task
    filled the window, that value leaked into a brand-new task in the same gateway process, so the
    guard fired a bogus 'context ~92%' notice on the very first turn of a fresh (empty) conversation.

    Now occupancy is tracked PER SESSION. This test verifies:
      (a) a new session never trips the guard (no prior usage for its id) -> reaches the upstream;
      (b) the SAME session's later turn still trips it (the guard still works where it should)."""
    MOCK = 8237
    GW = 8238
    MODELS = os.path.join(ROOT, "tests", "_scratch_gw_per_session_models.json")
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockPerSessionUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS})
    with open(MODELS, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def chat(session_id):
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW}/v1/chat/completions",
            data=json.dumps({"strata_session": session_id,
                             "messages": [{"role": "user", "content": "hi"}]}).encode(),
            headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=30)
        raw = resp.read().decode("utf-8", "replace")
        evs = []
        for block in raw.split("\n\n"):
            block = block.strip()
            if not block.startswith("data:"):
                continue
            p = block[5:].strip()
            if p == "[DONE]":
                evs.append("[DONE]")
            else:
                try:
                    evs.append(json.loads(p))
                except Exception:
                    pass
        return evs

    try:
        assert wait_http(GW, "/mcp"), "per-session gateway did not come up"
        # (1) Session A turn 1: records a big number, guard cannot trip (no prior) -> reaches upstream.
        a1 = chat("A")
        a1_overflow = any(isinstance(e, dict) and e.get("strata_notice", {}).get("code") == "context_overflow"
                          for e in a1)
        assert not a1_overflow, "first turn of a session must NOT trip the guard"
        assert any(isinstance(e, dict) and e.get("usage", {}).get("prompt_tokens") == 125000 for e in a1), \
            "usage chunk must be forwarded so occupancy is recorded for session A"
        # (2) Session B (brand-new, empty task): must NOT see the guard, must reach the upstream.
        b1 = chat("B")
        b1_overflow = any(isinstance(e, dict) and e.get("strata_notice", {}).get("code") == "context_overflow"
                          for e in b1)
        assert not b1_overflow, ("BUG REGRESSED: a fresh task inherits the previous task's occupancy "
                                 "and trips the context guard")
        assert any(e == "[DONE]" for e in b1), "fresh task must complete normally"
        # (3) Session A turn 2 (same conversation, now has a large prior): guard SHOULD trip.
        a2 = chat("A")
        a2_overflow = any(isinstance(e, dict) and e.get("strata_notice", {}).get("code") == "context_overflow"
                          for e in a2)
        assert a2_overflow, "the guard must still fire for a genuinely over-full SAME session"
        print("CONTEXT-GUARD PER-SESSION TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(MODELS)
        except Exception:
            pass


def test_interrupt_log():
    """GET/POST /api/interrupt-log: the diagnostic trail for "the stream just stopped".

    The frontend records every turn that did not finish cleanly, together with the phase it
    died in (thinking / answering / which tool). Verifies, against a REAL gateway subprocess:
      (a) POST appends one JSON line and the file is created (dir included);
      (b) GET tails it back, newest last, with ?n= honoured and capped;
      (c) a junk body is 400 rather than a silent no-op;
      (d) the path is isolated via STRATA_INTERRUPT_LOG — the real log is never touched."""
    MOCK = 8244
    GW = 8245
    LOG = os.path.join(ROOT, "tests", "_scratch_interrupt_log.jsonl")
    for p in (LOG, LOG + ".1"):
        try:
            os.remove(p)
        except OSError:
            pass
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS_CFG, "STRATA_INTERRUPT_LOG": LOG})
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def post(payload):
        rq = urllib.request.Request(f"http://127.0.0.1:{GW}/api/interrupt-log",
                                    data=json.dumps(payload).encode(),
                                    headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(rq, timeout=5) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def get(n=None):
        url = f"http://127.0.0.1:{GW}/api/interrupt-log" + (f"?n={n}" if n else "")
        with urllib.request.urlopen(url, timeout=5) as r:
            return json.loads(r.read())

    try:
        assert wait_http(GW, "/mcp"), "interrupt-log gateway did not come up"
        # (a) append two entries
        for i, phase in enumerate(("thinking", "tool")):
            st, body = post({"entry": {"ts": f"2026-10-20T01:0{i}:00Z", "kind": "truncated",
                                       "phase": phase, "tool": "shell_run" if phase == "tool" else None}})
            assert st == 200 and body.get("ok"), (st, body)
            assert body.get("path") == LOG, body
        with open(LOG, encoding="utf-8") as f:
            lines = [ln for ln in f.read().split("\n") if ln.strip()]
        assert len(lines) == 2, lines
        assert json.loads(lines[1])["phase"] == "tool", lines
        print("interrupt-log POST: appended 2 JSON lines OK")

        # (b) GET tails it back, newest last; ?n= is honoured
        doc = get()
        assert doc["count"] == 2 and doc["path"] == LOG, doc
        assert [e["phase"] for e in doc["entries"]] == ["thinking", "tool"], doc
        assert len(get(1)["entries"]) == 1, "?n=1 must tail a single entry"
        assert len(get(9999)["entries"]) == 2, "?n= is capped, not unbounded"
        print("interrupt-log GET: tail + ?n= OK")

        # (c) a junk body is rejected loudly
        st, body = post({"nope": 1})
        assert st == 400, (st, body)
        print("interrupt-log POST: missing entry -> 400 OK")
        print("INTERRUPT-LOG TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        for p in (LOG, LOG + ".1"):
            try:
                os.remove(p)
            except OSError:
                pass


def test_round_cap():
    """Regression for "它思考到一半就突然停了" / "工具调用中就断了" (2026-10-20).

    Root cause: the per-round output budget was a hardcoded 4096 tokens -- and the composer's own
    max_tokens was ignored -- while the gateway never inspected the upstream's finish_reason. A
    round that spent the whole budget on reasoning therefore ended with no answer text and no tool
    call, and the loop fell through to [DONE]: from the user's seat "it silently stopped".

    Contract asserted here:
      (a) a capped round becomes a RESUMABLE strata_notice(code=max_tokens) -- a reason, not silence;
      (b) a tool call whose arguments were cut off is NOT executed (never run a real action with
          missing inputs) and is reported back to the model instead;
      (c) the terminal marker is the bare OpenAI `data: [DONE]` on the wire, not `data: "[DONE]"`
          (the quoted form matched no client, so every healthy turn looked like a dropped socket).
    """
    MOCK = 8237
    GW = 8238
    MODELS = os.path.join(ROOT, "tests", "_scratch_gw_cap_models.json")
    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockRoundCapUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS})
    with open(MODELS, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW, "/mcp"), "round-cap gateway did not come up"

        def turn(payload):
            rq = urllib.request.Request(
                f"http://127.0.0.1:{GW}/v1/chat/completions",
                data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
            raw = urllib.request.urlopen(rq, timeout=60).read().decode("utf-8", "replace")
            evs = []
            for block in raw.split("\n\n"):
                block = block.strip()
                if not block.startswith("data:"):
                    continue
                p = block[5:].strip()
                if p == "[DONE]":
                    evs.append({"__done__": True})
                    continue
                try:
                    evs.append(json.loads(p))
                except Exception:
                    pass
            return raw, evs

        # (1) reasoning-only round that hits the cap -> a resumable notice, not silence
        raw1, evs1 = turn({"messages": [{"role": "user", "content": "写个打砖块游戏"}],
                           "strata_session": "cap-1"})
        notice = next((e["strata_notice"] for e in evs1
                       if isinstance(e, dict) and e.get("strata_notice", {}).get("code") == "max_tokens"), None)
        print("round-cap notice:", notice)
        assert notice, "a capped round must explain itself (strata_notice code=max_tokens)"
        assert notice.get("resumable") is True, "the notice must be resumable (继续 carries on)"
        assert int(notice.get("max_tokens") or 0) > 4096, \
            f"the per-round budget must be generous, got {notice.get('max_tokens')}"
        assert not any(isinstance(e, dict) and e.get("error") for e in evs1), "not a fatal error"
        assert "data: [DONE]\n\n" in raw1, "terminal marker must be the bare OpenAI form"
        assert 'data: "[DONE]"' not in raw1, "the quoted form is invisible to every client"

        # (2) an argument JSON that was cut off must not be executed with empty args
        _, evs2 = turn({"messages": [{"role": "user", "content": "写文件"}], "strata_session": "cap-2"})
        results = [e["strata_mcp"] for e in evs2
                   if isinstance(e, dict) and isinstance(e.get("strata_mcp"), dict)
                   and e["strata_mcp"].get("event") == "result"]
        print("capped tool results:", [(r.get("state"), r.get("ok")) for r in results])
        assert results, "the skipped call must still be reported back to the UI/model"
        assert all(r.get("state") != "done" for r in results), "a cut-off call must never 'succeed'"
        assert any(r.get("truncated") for r in results), "it must be flagged as truncated"
        assert not os.path.exists(CAP_FILE), "a truncated write must not touch the filesystem"
        print("ROUND-CAP TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(MODELS)
        except Exception:
            pass


def test_reasoning_effort():
    """Regression for "抽屉里的思维强度选择器完全没效果" (2026-10-20).

    Root cause: the gateway assembled the upstream request itself and pinned
    `"reasoning_effort": "medium"`, throwing away the value the client sent -- so picking
    off/low/medium/high in the composer changed nothing at all.

    Contract asserted here:
      (a) the caller's reasoning_effort reaches the upstream VERBATIM (normalised case/space);
      (b) an UNKNOWN value is dropped instead of forwarded -- the upstream validates this field
          and answers HTTP 400, which would surface as a fatal red box mid-turn;
      (c) omitting the key entirely simply lets the upstream pick its own default (no key sent).
    """
    MOCK = 8241
    GW = 8242
    MODELS = os.path.join(ROOT, "tests", "_scratch_gw_effort_models.json")

    class MockEffortUpstream(BaseHTTPRequestHandler):
        """Records the exact JSON body the gateway forwards, then answers a text-only turn."""
        seen = []

        def do_POST(self):
            try:
                n = int(self.headers.get("Content-Length") or 0)
                MockEffortUpstream.seen.append(json.loads(self.rfile.read(n).decode("utf-8")))
            except Exception:
                MockEffortUpstream.seen.append({})
            seq = [{"choices": [{"delta": {"content": "ok"}}]}, {"choices": [{"delta": {}}]}]
            body = ("".join(f"data: {json.dumps(d)}\n\n" for d in seq) + "data: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    mock = ThreadingHTTPServer(("127.0.0.1", MOCK), MockEffortUpstream)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    env = dict(os.environ)
    env.update({"FS_ROOT": ROOT, "FS_ALLOW": WORKSPACE_ROOT,
                "FS_ALLOW_FILE": FS_ALLOW_FILE,
                "STRATA_MODELS_CONFIG": MODELS})
    with open(MODELS, "w", encoding="utf-8") as f:
        json.dump({"selected": "m1", "models": [
            {"id": "m1", "name": "M1", "kind": "local", "base_url": "", "model": "m1"}]}, f)
    gw = subprocess.Popen(
        [PY, "gateway.py", "--serve", "--agent",
         "--url", f"http://127.0.0.1:{MOCK}/v1", "--model", "x", "--port", str(GW)],
        cwd=RT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        assert wait_http(GW, "/mcp"), "reasoning-effort gateway did not come up"

        def ask(**extra):
            payload = {"messages": [{"role": "user", "content": "hi"}],
                       "strata_session": "effort-%d" % len(MockEffortUpstream.seen)}
            payload.update(extra)
            rq = urllib.request.Request(f"http://127.0.0.1:{GW}/v1/chat/completions",
                                        data=json.dumps(payload).encode(),
                                        headers={"Content-Type": "application/json"})
            return urllib.request.urlopen(rq, timeout=60).read().decode("utf-8", "replace")

        # (a) what the picker asks for must arrive at the engine
        raw = ask(reasoning_effort="high")
        fwd = MockEffortUpstream.seen[-1]
        print("forwarded (asked high):", fwd.get("reasoning_effort"))
        assert fwd.get("reasoning_effort") == "high", \
            f"the client's choice must reach the upstream, got {fwd.get('reasoning_effort')!r}"
        assert "data: [DONE]\n\n" in raw, "the turn still has to end cleanly"

        ask(reasoning_effort=" OFF ")
        fwd = MockEffortUpstream.seen[-1]
        print("forwarded (asked ' OFF '):", fwd.get("reasoning_effort"))
        assert fwd.get("reasoning_effort") == "off", "value must be normalised, not rejected"

        ask(reasoning_effort="low")
        fwd = MockEffortUpstream.seen[-1]
        assert fwd.get("reasoning_effort") == "low", \
            f"low must not be overwritten by a hardcoded medium, got {fwd.get('reasoning_effort')!r}"

        # (b) an unknown value must be dropped, not forwarded into a 400 that kills the turn
        raw = ask(reasoning_effort="bogus_value")
        fwd = MockEffortUpstream.seen[-1]
        print("forwarded (asked bogus):", fwd.get("reasoning_effort"))
        assert "reasoning_effort" not in fwd, "an invalid effort must never reach the upstream"
        assert not any("upstream error" in b for b in (raw,)), \
            "an invalid effort must not turn into a fatal error for the user"

        # (c) nothing asked -> nothing pinned; the engine keeps its own default
        ask()
        fwd = MockEffortUpstream.seen[-1]
        assert "reasoning_effort" not in fwd, \
            "with no request the gateway must not pin a level of its own"

        # (d) the composer's per-level LENGTH cap must reach the engine too. Without this the
        #     three levels only changed the *mode* (reasoning_effort) and never how long the
        #     model was allowed to think -- the engine's own cap is 0/unlimited, so 低/中/高
        #     all thought for as long as they liked.
        ask(reasoning_effort="medium", reasoning_budget_tokens=4096)
        fwd = MockEffortUpstream.seen[-1]
        print("forwarded (asked medium + 4096):", fwd.get("reasoning_effort"),
              fwd.get("reasoning_budget_tokens"))
        assert fwd.get("reasoning_budget_tokens") == 4096, \
            f"the level's token cap must reach the upstream, got {fwd.get('reasoning_budget_tokens')!r}"
        assert fwd.get("reasoning_effort") == "medium", "effort and budget must travel together"

        # (e) 0 / negative / garbage == "no cap": the engine treats <=0 as unlimited, so the
        #     gateway must simply omit the key rather than forward a meaningless 0.
        for bad in (0, -5, "abc"):
            ask(reasoning_effort="low", reasoning_budget_tokens=bad)
            fwd = MockEffortUpstream.seen[-1]
            assert "reasoning_budget_tokens" not in fwd, \
                f"a non-positive/invalid budget ({bad!r}) must be dropped, got {fwd.get('reasoning_budget_tokens')!r}"
            assert fwd.get("reasoning_effort") == "low", "dropping the cap must not drop the effort"

        # (f) 跟随模型 sends neither -> the engine's default (uncapped) wins
        ask()
        fwd = MockEffortUpstream.seen[-1]
        assert "reasoning_budget_tokens" not in fwd and "reasoning_effort" not in fwd, \
            "follow-the-model must send neither effort nor budget"
        print("REASONING-BUDGET TEST PASSED")
        print("REASONING-EFFORT TEST PASSED")
    finally:
        gw.terminate()
        try:
            gw.wait(timeout=5)
        except Exception:
            gw.kill()
        mock.shutdown()
        try:
            os.remove(MODELS)
        except Exception:
            pass


if __name__ == "__main__":
    main()
