"""End-to-end tests for the MCP/skill management API.

Boots a real gateway subprocess against an isolated temp config (never the project's own
config/mcp_servers.json, so a failure here cannot take the user's tools down), then drives
the REST endpoints over real HTTP.

Run: python tests/test_management_api.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNTIME = os.path.join(ROOT, "runtime")
PY = sys.executable

FAILURES: list[str] = []


def check(label: str, cond: bool, extra: str = ""):
    print(("  OK   " if cond else "  FAIL ") + label + (f"  {extra}" if extra else ""))
    if not cond:
        FAILURES.append(label)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Gateway:
    """A gateway subprocess serving the management API on an isolated config."""

    def __init__(self, root: str, port: int):
        self.base = f"http://127.0.0.1:{port}"
        self.proc = subprocess.Popen(
            [PY, "-u", os.path.join(RUNTIME, "gateway.py"), "--serve",
             "--port", str(port),
             "--config", os.path.join(root, "config", "mcp_servers.json"),
             "--skills-dir", os.path.join(root, "skills")],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            cwd=RUNTIME, env={**os.environ, "WEB_DIR": os.path.join(ROOT, "serve", "web")})

    def wait_ready(self, timeout: float = 40.0):
        """Poll until the management API answers — an empty mcpServers starts instantly."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                out = (self.proc.stdout.read() if self.proc.stdout else "")
                raise RuntimeError(f"gateway exited early ({self.proc.returncode}):\n{out}")
            try:
                with urllib.request.urlopen(self.base + "/api/servers", timeout=3):
                    return
            except urllib.error.HTTPError:
                return
            except Exception:
                time.sleep(0.4)
        raise RuntimeError("gateway did not become ready in time")

    def req(self, method: str, path: str, body=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method)
        if data:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=90) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except Exception:
                return e.code, {"raw": raw}

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def main() -> int:
    tmp = tempfile.mkdtemp(prefix="strata-mgmt-")
    cfg_path = os.path.join(tmp, "config", "mcp_servers.json")
    skills_dir = os.path.join(tmp, "skills")
    os.makedirs(os.path.dirname(cfg_path))
    os.makedirs(skills_dir)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump({"mcpServers": {}, "session": {"max_chars": 8000}}, f)

    gw = Gateway(tmp, free_port())
    try:
        gw.wait_ready()
        print(f"[test] gateway ready at {gw.base}  (isolated config: {tmp})\n")

        real_server = os.path.join(ROOT, "servers", "memory_server.py")
        spec = {"command": PY, "args": [real_server], "cwd": ROOT}

        # ── MCP servers ──────────────────────────────────────────────────────────
        print("=== MCP server: 新增 ===")
        code, r = gw.req("POST", "/api/servers", {"name": "probe1", "spec": spec})
        check("HTTP 200", code == 200, f"got {code}")
        check("返回条目名正确", r.get("server", {}).get("name") == "probe1")
        check("生成了备份", bool(r.get("backup")) and os.path.isfile(r["backup"]))
        check("origin 合法", r.get("server", {}).get("origin") in ("builtin", "user"),
              f"origin={r.get('server', {}).get('origin')}")

        print("\n=== MCP server: 试连真实进程（不落盘）===")
        code, r = gw.req("POST", "/api/servers/test", {"spec": spec})
        tools = [t["name"] for t in r.get("tools", [])]
        check("试连成功", r.get("ok") is True, f"tools={tools[:3]}")
        check("拿到工具清单", len(tools) > 0)
        _, lst = gw.req("GET", "/api/servers")
        check("试连未写盘（列表仍为 1 条）", len(lst["servers"]) == 1)

        print("\n=== MCP server: 试连失败应降级为 ok=false（非 500）===")
        code, r = gw.req("POST", "/api/servers/test",
                         {"spec": {"command": "no-such-command-xyz", "args": []}})
        check("HTTP 仍为 200", code == 200, f"got {code}")
        check("ok=false 且带错误", r.get("ok") is False and bool(r.get("error")))

        print("\n=== MCP server: 编辑 / 查询 / 删除 ===")
        code, r = gw.req("PUT", "/api/servers/probe1", {"spec": dict(spec, cwd=ROOT)})
        check("编辑成功", code == 200)
        code, r = gw.req("GET", "/api/servers/probe1")
        check("单个查询", code == 200 and r.get("server", {}).get("name") == "probe1")

        # ── Skills ───────────────────────────────────────────────────────────────
        print("\n=== 技能: 安装（yaml + mcpServers 双写）===")
        skill = {"description": "探测技能",
                 "tools": [{"mcp": "probe-skill-server", "command": PY,
                            "args": [os.path.join(ROOT, "servers", "websearch_server.py")]}],
                 "permissions": {"filesystem": ["read"]},
                 "triggers": ["probe"]}
        code, r = gw.req("POST", "/api/skills", {"name": "probe-skill", "spec": skill})
        check("安装成功", code == 200, f"got {code}")

        cfg = json.load(open(cfg_path, encoding="utf-8"))
        ent = cfg["mcpServers"].get("probe-skill-server")
        check("mcpServers 出现展开条目", ent is not None)
        check("展开条目带 _skill 标记", (ent or {}).get("_skill") == "probe-skill")
        check("$SKILL_DIR 已展开为绝对路径",
              "$SKILL_DIR" not in json.dumps(ent, ensure_ascii=False))
        check("yaml 已生成",
              os.path.isfile(os.path.join(skills_dir, "probe-skill.yaml")))
        yml = open(os.path.join(skills_dir, "probe-skill.yaml"), encoding="utf-8").read()
        check("yaml 保留 $SKILL_DIR（可移植）", "$SKILL_DIR" in yml or "$" not in yml)

        print("\n=== 技能: 保护生成的 server 条目 ===")
        code, r = gw.req("DELETE", "/api/servers/probe-skill-server")
        check("拒绝直接删除（400）", code == 400, f"got {code}")

        print("\n=== 技能: 删除（清理 yaml + 展开条目）===")
        code, r = gw.req("DELETE", "/api/skills/probe-skill")
        check("删除成功", code == 200)
        check("报告移除的条目", r.get("servers_removed") == ["probe-skill-server"])
        cfg = json.load(open(cfg_path, encoding="utf-8"))
        check("展开条目已清理", "probe-skill-server" not in cfg["mcpServers"])
        check("yaml 已删除",
              not os.path.isfile(os.path.join(skills_dir, "probe-skill.yaml")))

        # ── Guards ───────────────────────────────────────────────────────────────
        print("\n=== 输入校验 ===")
        code, _ = gw.req("POST", "/api/servers", {"name": "../../evil", "spec": {"command": "x"}})
        check("拒绝路径穿越式名称", code == 400)
        code, _ = gw.req("POST", "/api/servers", {"name": "nope", "spec": {"args": ["a"]}})
        check("拒绝缺 command 的条目", code == 400)
        code, _ = gw.req("POST", "/api/servers", {"name": "probe1", "spec": spec})
        check("拒绝重名", code == 400)
        code, r = gw.req("POST", "/api/servers",
                         {"name": "inj", "spec": {"command": "x", "_skill": "probe-skill"}})
        cfg = json.load(open(cfg_path, encoding="utf-8"))
        check("剥离注入的 _skill", "_skill" not in cfg["mcpServers"].get("inj", {}))
        gw.req("DELETE", "/api/servers/inj")

        # ── Reload ───────────────────────────────────────────────────────────────
        print("\n=== 热重载 ===")
        code, r = gw.req("POST", "/api/servers/reload", {})
        check("reload ok", r.get("ok") is True, f"{str(r)[:90]}")
        check("返回 server 清单", isinstance(r.get("servers"), list))

        print("\n=== 清理 ===")
        code, r = gw.req("DELETE", "/api/servers/probe1")
        check("删除 MCP server", code == 200)
        _, lst = gw.req("GET", "/api/servers")
        check("列表已空", len(lst["servers"]) == 0)

        # ── Backups ──────────────────────────────────────────────────────────────
        bdir = os.path.join(tmp, "config", ".backups")
        n = len([f for f in os.listdir(bdir) if f.startswith("mcp_servers.")]) \
            if os.path.isdir(bdir) else 0
        check("每次写入都留了备份", n >= 3, f"{n} 份")

    finally:
        gw.stop()
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAILED ({len(FAILURES)}):")
        for f in FAILURES:
            print("  - " + f)
        return 1
    print("MANAGEMENT API: ALL PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
