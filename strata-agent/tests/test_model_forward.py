"""model_forward: talking to a model this process did not load.

Two contracts the UI depends on:
  - the request we send upstream carries its model name and NONE of our `strata_*` bookkeeping
  - when the upstream asks for one of OUR MCP tools, the loop runs here: the tool is executed, the
    result is appended as a `tool` message, and the upstream is asked again - and the client sees
    the same `strata_mcp` events the local engine would have produced.

A fake OpenAI-compatible endpoint stands in for the real one, so this runs with no model and no GPU.

Run standalone: python tests/test_model_forward.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "serve"))

import model_forward as mf  # noqa: E402
import model_registry as mr  # noqa: E402

FAIL = []


def check(label, cond, extra=""):
    print("  " + ("OK   " if cond else "FAIL ") + label + (("  " + str(extra)) if extra else ""))
    if not cond:
        FAIL.append(label)


REQUESTS = []          # every chat body the fake endpoint received
SEEN_AUTH = []
ALWAYS_TOOLS = False    # when set, the fake keeps asking for a tool (to exercise the round cap)


class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _sse(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for e in events:
            self.wfile.write(("data: " + json.dumps(e) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):
        if self.path.split("?")[0].rstrip("/").endswith("/models"):
            body = json.dumps({"object": "list", "data": [{"id": "gpt-4o"}, {"id": "qwen2.5"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        REQUESTS.append(body)
        SEEN_AUTH.append(self.headers.get("Authorization"))
        first = bool(body.get("tools")) and (ALWAYS_TOOLS or len(REQUESTS) == 1)
        if first:                                  # ask for one of OUR tools
            self._sse([
                {"choices": [{"index": 0, "delta": {"reasoning_content": "看一下文件"}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": 0, "id": "call_1", "type": "function",
                     "function": {"name": "fs__read_file", "arguments": ""}}]}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {"tool_calls": [
                    {"index": 0, "function": {"arguments": '{"path":"a.txt"}'}}]}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
            ])
        else:
            self._sse([
                {"choices": [{"index": 0, "delta": {"content": "读完了。"}, "finish_reason": None}]},
                {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                 "usage": {"prompt_tokens": 12, "completion_tokens": 4}},
            ])


srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = f"http://127.0.0.1:{srv.server_address[1]}/v1"

ENTRY = {"id": "fake", "name": "Fake", "kind": "custom", "base_url": BASE, "model": "gpt-4o",
         "api_key": "sk-test", "tools": True}

print("\n=== T1: our bookkeeping is stripped, its model name goes in ===")
body = mf.upstream_body(ENTRY, {"model": "fake", "messages": [{"role": "user", "content": "hi"}],
                                "strata_mcp": True, "strata_permission": "full", "strata_workspace": "E:\\x"})
check("the upstream model name is used", body["model"] == "gpt-4o", body.get("model"))
check("no strata_* field leaks upstream",
      not [k for k in body if str(k).startswith("strata_")], list(body))
check("messages survive", body["messages"][0]["content"] == "hi")

print("\n=== T2: plain text streams back as our chunks ===")
REQUESTS.clear()
got = list(mf.stream_chat({**ENTRY, "tools": False}, {"model": "fake", "messages": [{"role": "user", "content": "hi"}]}))
text = "".join((c.get("choices") or [{}])[0].get("delta", {}).get("content") or "" for c in got)
check("the answer text came through  " + json.dumps(text), text == "读完了。")
check("the model reported is the upstream one", all(c.get("model") == "gpt-4o" for c in got))
fin = [(c.get("choices") or [{}])[0].get("finish_reason") for c in got][-1]
check("it ends with finish_reason=stop  " + json.dumps(fin), fin == "stop")
check("the key went upstream", SEEN_AUTH and SEEN_AUTH[-1] == "Bearer sk-test", SEEN_AUTH[-1:])

print("\n=== T3: a tool call runs HERE, then the upstream is asked again ===")
REQUESTS.clear()
runs = []
got = list(mf.stream_chat(ENTRY, {"model": "fake", "messages": [{"role": "user", "content": "读一下"}],
                                  "tools": [{"type": "function", "function": {"name": "fs__read_file"}}]},
                          run_tool=lambda name, args: (runs.append((name, args)) or
                                                       {"ok": True, "text": "file-content", "chars": 12,
                                                        "truncated": False, "ms": 5}),
                          mcp_names={"fs__read_file"}, max_rounds=3))
check("two round trips to the upstream  " + str(len(REQUESTS)), len(REQUESTS) == 2)
check("the tool really ran  " + json.dumps(runs), runs == [("fs__read_file", {"path": "a.txt"})])
mcp = [c["strata_mcp"] for c in got if "strata_mcp" in c]
check("the client is told it started", any(e.get("event") == "start" and e.get("name") == "fs__read_file" for e in mcp))
check("and told how it ended", any(e.get("event") == "result" and e.get("ok") is True for e in mcp))
msgs = REQUESTS[-1]["messages"]
check("the second round carries the assistant's tool_calls",
      msgs[-2].get("role") == "assistant" and msgs[-2].get("tool_calls"), msgs[-2].get("role"))
check("and the tool result as a tool message",
      msgs[-1].get("role") == "tool" and msgs[-1].get("content") == "file-content", msgs[-1])
text = "".join((c.get("choices") or [{}])[0].get("delta", {}).get("content") or "" for c in got)
check("the final answer still arrives  " + json.dumps(text), text == "读完了。")

print("\n=== T4: the round cap is honoured ===")
REQUESTS.clear()
ALWAYS_TOOLS = True
got = list(mf.stream_chat(ENTRY, {"model": "fake", "messages": [{"role": "user", "content": "loop"}],
                                  "tools": [{"type": "function", "function": {"name": "fs__read_file"}}]},
                          run_tool=lambda n, a: {"ok": True, "text": "x", "chars": 1, "truncated": False, "ms": 1},
                          mcp_names={"fs__read_file"}, max_rounds=1))
check("it stops after the cap instead of looping forever  " + str(len(REQUESTS)), len(REQUESTS) == 2)
check("the client is told the cap was hit",
      any(c.get("strata_mcp", {}).get("event") == "limit" for c in got))

print("\n=== T5: an unreachable endpoint is reported, not swallowed ===")
got = list(mf.stream_chat({**ENTRY, "base_url": "http://127.0.0.1:9/v1", "tools": False},
                          {"model": "fake", "messages": [{"role": "user", "content": "hi"}]}))
text = "".join((c.get("choices") or [{}])[0].get("delta", {}).get("content") or "" for c in got)
check("the failure is visible in the answer  " + json.dumps(text[:40]), "Error" in text or "error" in text)

print("\n=== T6: 测试连接 probes the right URL and reports the models ===")
ok, msg = mr.probe({"base_url": BASE, "model": "gpt-4o", "api_key": "sk-test"})
check("it connected  " + json.dumps(msg), ok is True)
ok2, msg2 = mr.probe({"base_url": "http://127.0.0.1:9/v1", "model": "x"})
check("an unreachable endpoint reports failure  " + json.dumps(msg2), ok2 is False)

srv.shutdown()
print("")
print("MODEL FORWARD: " + (f"{len(FAIL)} FAILED" if FAIL else "ALL PASSED"))
sys.exit(1 if FAIL else 0)
