# -*- coding: utf-8 -*-
"""Unit tests for the startup self-check (layer ⑥).

Drives every check with injectable fakes — no real MCP child, no socket, no
project files required — and asserts the report shape and the fail-fast logic.

Run: python tests/test_startup_selfcheck.py
"""
import json
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "runtime"))

from selfcheck import (  # noqa: E402
    run_selfcheck, check_config, check_mcp_tools, check_upstream,
    check_build_marker, check_models_contract, check_logs_dir, _check,
)


class FakeSrv:
    def __init__(self, tools):
        self.tools = tools


class FakeExecutor:
    def __init__(self, servers):
        self.servers = servers


def _good_config(path):
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"mcpServers": {"fs": {"command": "x"}, "shell": {"command": "y"}},
                   "mcp": {"timeout_s": 330}}, fh)


def _write_marker(dir_, with_marker=True):
    os.makedirs(dir_, exist_ok=True)
    with open(os.path.join(dir_, "app.js"), "w", encoding="utf-8") as fh:
        fh.write('window.__strataBuild = "x";\n' if with_marker else 'var a = 1;\n')


def _write_stub_sources(root):
    os.makedirs(os.path.join(root, "runtime"), exist_ok=True)
    os.makedirs(os.path.join(root, "serve"), exist_ok=True)
    with open(os.path.join(root, "runtime", "http_server.py"), "w", encoding="utf-8") as fh:
        fh.write('x = {"probe": 1, "path": 2}\n')
    with open(os.path.join(root, "serve", "model_registry.py"), "w", encoding="utf-8") as fh:
        fh.write('def public():\n    pass\ndef probe():\n    pass\n')


def check(name, cond, extra=""):
    if not cond:
        raise AssertionError(f"FAIL: {name} {extra}")
    print(f"  ok  {name}")


def main() -> int:
    try:
        tmp = tempfile.mkdtemp(prefix="selfcheck_")
        good_cfg = os.path.join(tmp, "good.json")
        _good_config(good_cfg)
        bad_cfg = os.path.join(tmp, "bad.json")
        with open(bad_cfg, "w", encoding="utf-8") as fh:
            fh.write("{not valid json")

        # ── config_valid ──
        check("missing config -> fail", not check_config(None)["ok"])
        check("unparseable config -> fail", not check_config(bad_cfg)["ok"])
        c = check_config(good_cfg)
        check("good config -> pass", c["ok"] and c["level"] == "INFO", c)

        # ── mcp_tool_floor ──
        bad_ex = FakeExecutor({"fs": FakeSrv([])})          # started, 0 tools
        chk = check_mcp_tools(bad_ex)
        check("empty server -> hard fail", not chk[0]["ok"] and chk[0]["level"] == "ERROR", chk)
        good_ex = FakeExecutor({"fs": FakeSrv([{"name": "a"}]),
                                "shell": FakeSrv([{"name": "b"}, {"name": "c"}])})
        chk = check_mcp_tools(good_ex)
        check("populated servers -> pass", chk[0]["ok"], chk)
        check("no executor -> info skip", check_mcp_tools(None)[0]["level"] == "INFO")

        # ── upstream_reach ──
        check("no upstream -> info skip",
              check_upstream(None)["level"] == "INFO")
        warn = check_upstream("http://127.0.0.1:1", require=False)   # nothing listening
        check("unreachable + not required -> WARN, ok=True",
              warn["ok"] and warn["level"] == "WARN", warn)
        fail = check_upstream("http://127.0.0.1:1", require=True)
        check("unreachable + required -> hard fail",
              not fail["ok"] and fail["level"] == "ERROR", fail)

        # ── build_marker ──
        web_ok = os.path.join(tmp, "web_ok")
        _write_marker(web_ok, with_marker=True)
        web_bad = os.path.join(tmp, "web_bad")
        _write_marker(web_bad, with_marker=False)
        check("app.js with marker -> pass", check_build_marker(web_ok)["ok"])
        check("app.js without marker -> fail", not check_build_marker(web_bad)["ok"])

        # ── models_contract ──
        src_ok = os.path.join(tmp, "src_ok")
        _write_stub_sources(src_ok)
        check("stub sources with contract -> pass", check_models_contract(src_ok)["ok"])
        check("no source_root -> info skip", check_models_contract(None)["level"] == "INFO")

        # ── logs_dir ──
        log_ok = os.path.join(tmp, "proj_ok")
        check("writable logs dir -> pass", check_logs_dir(log_ok)["ok"])

        # ── run_selfcheck aggregation ──
        rep = run_selfcheck(good_ex, upstream_url=None, web_dir=web_ok,
                            config_path=good_cfg, source_root=src_ok)
        check("full selfcheck with good inputs -> ok", rep["ok"], rep)
        rep_bad = run_selfcheck(bad_ex, upstream_url=None, web_dir=web_bad,
                                config_path=bad_cfg, source_root=src_ok)
        check("full selfcheck with bad inputs -> not ok", not rep_bad["ok"], rep_bad)
        check("report shape has checks list", isinstance(rep.get("checks"), list)
              and len(rep["checks"]) >= 6, rep)

        print("\nSTARTUP-SELFCHECK: all checks passed")
        return 0
    except AssertionError as e:
        print(f"\nSTARTUP-SELFCHECK: FAILED -> {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
