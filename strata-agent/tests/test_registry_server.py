"""registry MCP server tests — Registry behind MCP tools, with test isolation.

Run:  C:/Users/sk/.workbuddy/binaries/python/versions/3.13.12/python.exe tests/test_registry_server.py

Two layers, on purpose:
  * direct call_tool() tests against a TEMP config/skills/backups/audit (the
    server's env overrides make that possible), so the real mcp_servers.json is
    provably never touched — same discipline as test_skillhub.py;
  * a real-subprocess stdio test: the server is spawned with STRATA_REGISTRY_*
    pointing at a temp tree and a mutation is driven over the wire, then the
    temp config on disk is read back. That is the only proof both the UTF-8
    contract and the isolation override hold end to end.

The probe test starts a real tiny MCP server as a subprocess (the same machinery
the management UI's Test button uses).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(PROJECT, "servers")
CONFIG = os.path.join(PROJECT, "config", "mcp_servers.json")
SKILLS = os.path.join(PROJECT, "skills")
PY = sys.executable

sys.path.insert(0, SERVERS)
from registry_server import RegistryServer  # noqa: E402


def _md5(path):
    with open(path, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def _tiny_server_text():
    """A minimal MCP server file that only needs _mcp_base.py beside it."""
    return (
        "import os, sys\n"
        "sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))\n"
        "from _mcp_base import McpServerBase\n"
        "\n"
        "\n"
        "class T(McpServerBase):\n"
        "    name = 'tiny'\n"
        "    tools = [{'name': 'ping', 'description': 'pong',\n"
        "              'inputSchema': {'type': 'object', 'properties': {}}}]\n"
        "\n"
        "    def call_tool(self, name, args):\n"
        "        if name != 'ping':\n"
        "            raise Exception('unknown tool: ' + name)\n"
        "        return 'pong'\n"
        "\n"
        "\n"
        "if __name__ == '__main__':\n"
        "    sys.exit(T().run())\n"
    )


class RegistryBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="registry-test-")
        self.config = os.path.join(self.tmp, "config", "mcp_servers.json")
        self.skills = os.path.join(self.tmp, "skills")
        self.backups = os.path.join(self.tmp, "backups")
        self.audit_path = os.path.join(self.tmp, "audit.jsonl")
        os.makedirs(os.path.dirname(self.config))
        # one builtin (entry file under <tmp>/servers) + one plain user entry
        os.makedirs(os.path.join(self.tmp, "servers"))
        with open(os.path.join(self.tmp, "servers", "builtin_demo.py"), "w") as f:
            f.write("# demo\n")
        with open(self.config, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {
                "builtin-demo": {"command": "python",
                                 "args": [os.path.join(self.tmp, "servers", "builtin_demo.py")]},
                "user-demo": {"command": "node", "args": ["demo.js"]},
            }}, f)
        self.srv = RegistryServer(config_path=self.config, skills_dir=self.skills,
                                  backup_dir=self.backups)
        # point the audit at the temp file too (the default would hit the real log)
        from audit import AuditLog
        self.srv.audit = AuditLog(self.audit_path)
        self.srv._registry = None
        self.cfg_before = (_md5(CONFIG), os.path.getmtime(CONFIG))
        self.skills_before = sorted(os.listdir(SKILLS)) if os.path.isdir(SKILLS) else []

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ok(self, res):
        d = json.loads(res)
        self.assertIsNone(d.get("error"), res)
        return d

    def _err(self, res):
        d = json.loads(res)
        self.assertIn("error", d, res)
        return d["error"]


class TestReads(RegistryBase):
    def test_list_servers_summary(self):
        d = self._ok(self.srv.call_tool("list_servers", {}))
        names = [s["name"] for s in d["servers"]]
        self.assertEqual(names, ["builtin-demo", "user-demo"])   # builtin sorts first
        by = {s["name"]: s for s in d["servers"]}
        self.assertEqual(by["builtin-demo"]["origin"], "builtin")
        self.assertEqual(by["user-demo"]["origin"], "user")
        # summaries stay summaries: no args/env/cwd leakage into the picker payload
        self.assertNotIn("args", by["user-demo"])
        self.assertNotIn("env", by["user-demo"])
        self.assertEqual(by["user-demo"]["n_args"], 1)

    def test_get_server_full(self):
        d = self._ok(self.srv.call_tool("get_server", {"name": "user-demo"}))
        s = d["server"]
        self.assertEqual(s["command"], "node")
        self.assertEqual(s["args"], ["demo.js"])
        self.assertEqual(s["origin"], "user")
        self.assertIsNone(s["skill"])

    def test_get_server_missing(self):
        self.assertIn("not found", self._err(self.srv.call_tool("get_server", {"name": "nope"})))

    def test_skills_empty_then_seeded(self):
        d = self._ok(self.srv.call_tool("list_skills", {}))
        self.assertEqual(d["skills"], [])
        self._err(self.srv.call_tool("get_skill", {"name": "whatever"}))


class TestServerMutations(RegistryBase):
    def test_add_update_delete_roundtrip(self):
        d = self._ok(self.srv.call_tool("add_server", {
            "name": "fetch", "spec": {"command": "python", "args": ["-u", "fetch.py"],
                                      "cwd": "C:/tmp", "env": {"TOKEN": "abc"}}}))
        self.assertIn("server", d)
        self.assertEqual(d["server"]["command"], "python")
        self.assertTrue(os.path.isfile(d["backup"]))                 # a backup was taken
        self.assertTrue(os.path.isfile(os.path.join(self.backups, "mcp_servers.json"))
                        or any(f.startswith("mcp_servers.") for f in os.listdir(self.backups)))
        got = self._ok(self.srv.call_tool("get_server", {"name": "fetch"}))["server"]
        self.assertEqual(got["env"], {"TOKEN": "abc"})

        # update replaces the whole entry (not a patch)
        self._ok(self.srv.call_tool("update_server", {"name": "fetch",
                                                      "spec": {"command": "node", "args": ["f.js"]}}))
        got = self._ok(self.srv.call_tool("get_server", {"name": "fetch"}))["server"]
        self.assertEqual(got["command"], "node")
        self.assertEqual(got.get("env"), {})                          # env really replaced

        self._ok(self.srv.call_tool("delete_server", {"name": "fetch"}))
        self._err(self.srv.call_tool("get_server", {"name": "fetch"}))

    def test_rejections(self):
        self._err(self.srv.call_tool("add_server", {"name": "../evil", "spec": {"command": "x"}}))
        self._err(self.srv.call_tool("add_server", {"name": "技能", "spec": {"command": "x"}}))
        self._err(self.srv.call_tool("add_server", {"name": "x", "spec": {}}))          # no command
        self._err(self.srv.call_tool("add_server", {"name": "user-demo", "spec": {"command": "x"}}))
        self._err(self.srv.call_tool("update_server", {"name": "ghost", "spec": {"command": "x"}}))
        self._err(self.srv.call_tool("delete_server", {"name": "ghost"}))

    def test_smuggled_keys_dropped(self):
        """A client must not be able to inject `_skill` and masquerade as a skill entry."""
        self._ok(self.srv.call_tool("add_server", {
            "name": "sneaky", "spec": {"command": "x", "_skill": "victim", "timeout": 5}}))
        got = self._ok(self.srv.call_tool("get_server", {"name": "sneaky"}))["server"]
        self.assertIsNone(got["skill"])
        self.assertNotIn("timeout", got)
        with open(self.config, "rb") as f:
            raw = json.loads(f.read().decode("utf-8"))
        self.assertNotIn("_skill", raw["mcpServers"]["sneaky"])

    def test_audit_trail_written(self):
        self._ok(self.srv.call_tool("add_server", {"name": "audited", "spec": {"command": "x"}}))
        with open(self.audit_path, encoding="utf-8") as f:
            lines = [json.loads(l) for l in f if l.strip()]
        self.assertTrue(any(r.get("type") == "mcp_add" and r.get("server") == "audited"
                            for r in lines), lines)


class TestSkillMutations(RegistryBase):
    def test_add_get_update_delete(self):
        spec = {"description": "demo skill",
                "tools": [{"mcp": "demo-srv", "command": "python",
                           "args": ["$SKILL_DIR/example_server.py"]}],
                "triggers": ["demo"], "requires_env": {}}
        d = self._ok(self.srv.call_tool("add_skill", {"name": "demo", "spec": spec}))
        self.assertEqual(d["skill"]["name"], "demo")
        self.assertTrue(os.path.isfile(os.path.join(self.skills, "demo.yaml")))
        # the expanded entry in the config has $SKILL_DIR resolved and the tag
        with open(self.config, encoding="utf-8") as f:
            entry = json.load(f)["mcpServers"]["demo-srv"]
        self.assertEqual(entry["_skill"], "demo")
        self.assertNotIn("$SKILL_DIR", " ".join(entry["args"]))
        self.assertTrue(entry["args"][0].startswith(self.skills))

        got = self._ok(self.srv.call_tool("get_skill", {"name": "demo"}))["skill"]
        self.assertEqual(got["servers"], ["demo-srv"])
        self.assertEqual(got["triggers"], ["demo"])

        # the expanded entry cannot be deleted directly — the skill owns it
        self._err(self.srv.call_tool("delete_server", {"name": "demo-srv"}))

        spec["description"] = "updated"
        self._ok(self.srv.call_tool("update_skill", {"name": "demo", "spec": spec}))
        got = self._ok(self.srv.call_tool("get_skill", {"name": "demo"}))["skill"]
        self.assertEqual(got["description"], "updated")

        self._ok(self.srv.call_tool("delete_skill", {"name": "demo"}))
        self.assertFalse(os.path.exists(os.path.join(self.skills, "demo.yaml")))
        with open(self.config, encoding="utf-8") as f:
            self.assertNotIn("demo-srv", json.load(f)["mcpServers"])
        self._err(self.srv.call_tool("get_skill", {"name": "demo"}))

    def test_skill_rejections(self):
        self._err(self.srv.call_tool("add_skill", {"name": "bad/name", "spec": {
            "tools": [{"mcp": "a", "command": "x"}]}}))
        self._err(self.srv.call_tool("add_skill", {"name": "demo", "spec": {"tools": []}}))
        self._err(self.srv.call_tool("add_skill", {"name": "demo", "spec": {
            "tools": [{"mcp": "user-demo", "command": "x"}]}}))     # name clash with mcpServers
        self._err(self.srv.call_tool("update_skill", {"name": "ghost", "spec": {
            "tools": [{"mcp": "a", "command": "x"}]}}))
        self._err(self.srv.call_tool("delete_skill", {"name": "ghost"}))


class TestProbe(RegistryBase):
    def test_probe_real_tiny_server(self):
        tiny = os.path.join(self.tmp, "tiny_server.py")
        with open(tiny, "w", encoding="utf-8") as f:
            f.write(_tiny_server_text())
        with open(os.path.join(SERVERS, "_mcp_base.py"), "rb") as f:
            base = f.read()
        with open(os.path.join(self.tmp, "_mcp_base.py"), "wb") as f:
            f.write(base)
        d = self._ok(self.srv.call_tool("test_server", {"name": "tiny",
                                                        "spec": {"command": PY, "args": [tiny]}}))
        self.assertTrue(d["ok"], d)
        self.assertEqual([t["name"] for t in d["tools"]], ["ping"])
        self.assertIsNone(d["error"])
        # a probe persists nothing
        with open(self.config, encoding="utf-8") as f:
            self.assertEqual(sorted(json.load(f)["mcpServers"]), ["builtin-demo", "user-demo"])

    def test_probe_failure_is_clean_error(self):
        d = json.loads(self.srv.call_tool("test_server", {"spec": {"command": "no-such-binary-xyz"}}))
        self.assertFalse(d["ok"])
        self.assertTrue(d["error"])
        self.assertEqual(d["tools"], [])

    def test_probe_immediate_exit_fails_fast(self):
        """A candidate that starts and exits before answering must fail in seconds.

        Regression: the reader thread hit EOF and woke nobody, so the first request
        sat out the full timeout_s (60s) before failing — the Tools tab's Test button
        and any probe of a broken candidate hung with it. _req now polls the child.
        """
        import time as _t
        t0 = _t.monotonic()
        d = json.loads(self.srv.call_tool("test_server", {"spec": {"command": PY, "args": ["-c", "pass"]}}))
        self.assertLess(_t.monotonic() - t0, 10, "an immediately-exiting candidate must fail fast")
        self.assertFalse(d["ok"])
        self.assertTrue(d["error"])


class TestRealConfigUntouched(RegistryBase):
    def test_no_tool_writes_the_real_config(self):
        for call in (("list_servers", {}),
                     ("get_server", {"name": "user-demo"}),
                     ("list_skills", {}),
                     ("add_server", {"name": "tmp-add", "spec": {"command": "x"}}),
                     ("update_server", {"name": "tmp-add", "spec": {"command": "y"}}),
                     ("delete_server", {"name": "tmp-add"})):
            self.srv.call_tool(*call)
        self.assertEqual(_md5(CONFIG), self.cfg_before[0])
        self.assertEqual(os.path.getmtime(CONFIG), self.cfg_before[1])
        now = sorted(os.listdir(SKILLS)) if os.path.isdir(SKILLS) else []
        self.assertEqual(now, self.skills_before)


class TestStdioWire(unittest.TestCase):
    """The server, spawned for real with isolation env, driven over the wire."""

    def test_handshake_tools_and_mutation_over_stdio(self):
        tmp = tempfile.mkdtemp(prefix="registry-wire-")
        cfg = os.path.join(tmp, "mcp_servers.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {"seed": {"command": "node", "args": ["s.js"]}}}, f)
        env = dict(os.environ,
                   STRATA_REGISTRY_CONFIG=cfg,
                   STRATA_REGISTRY_SKILLS=os.path.join(tmp, "skills"),
                   STRATA_REGISTRY_BACKUPS=os.path.join(tmp, "backups"),
                   STRATA_REGISTRY_AUDIT=os.path.join(tmp, "audit.jsonl"))
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "list_servers", "arguments": {}}},
            {"jsonrpc": "2.0", "id": 4, "method": "tools/call",
             "params": {"name": "add_server", "arguments": {
                 "name": "线上新增", "spec": {"command": "python", "args": ["a.py"]}}}},
            {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
             "params": {"name": "add_server", "arguments": {
                 "name": "wire-added", "spec": {"command": "python", "args": ["b.py"]}}}},
            {"jsonrpc": "2.0", "id": 6, "method": "tools/call",
             "params": {"name": "get_server", "arguments": {"name": "wire-added"}}},
        ]
        payload = b"".join((json.dumps(f, ensure_ascii=False).encode("utf-8") + b"\n") for f in frames)
        p = subprocess.run([PY, os.path.join(SERVERS, "registry_server.py")],
                           input=payload, capture_output=True, env=env, timeout=120)
        lines = [ln for ln in p.stdout.decode("utf-8").splitlines() if ln.strip()]
        msgs = [json.loads(ln) for ln in lines]
        by_id = {m.get("id"): m for m in msgs if "id" in m}

        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "registry")
        tools = sorted(t["name"] for t in by_id[2]["result"]["tools"])
        self.assertEqual(tools, ["add_server", "add_skill", "delete_server", "delete_skill",
                                 "get_server", "get_skill", "list_servers", "list_skills",
                                 "test_server", "update_server", "update_skill"])

        listed = json.loads(by_id[3]["result"]["content"][0]["text"])["servers"]
        self.assertEqual([s["name"] for s in listed], ["seed"])

        # a Chinese name is rejected by SAFE_NAME — over the wire, as a clean error
        added = json.loads(by_id[4]["result"]["content"][0]["text"])
        self.assertIn("error", added)

        # a valid name over the wire really lands on disk (isolation + persistence)
        ok_add = json.loads(by_id[5]["result"]["content"][0]["text"])
        self.assertIsNone(ok_add.get("error"), ok_add)
        self.assertTrue(os.path.isfile(ok_add["backup"]))
        with open(cfg, encoding="utf-8") as f:
            servers = json.load(f)["mcpServers"]
        self.assertIn("wire-added", servers)
        self.assertNotIn("线上新增", servers)          # the rejected one never landed
        self.assertEqual(servers["wire-added"]["command"], "python")
        got = json.loads(by_id[6]["result"]["content"][0]["text"])["server"]
        self.assertEqual(got["name"], "wire-added")
        with open(os.path.join(tmp, "audit.jsonl"), encoding="utf-8") as f:
            self.assertTrue(any(json.loads(l).get("type") == "mcp_add" for l in f if l.strip()))
        self.assertEqual(p.returncode, 0, p.stderr.decode("utf-8", "replace")[-500:])


class TestApprovalLockstep(unittest.TestCase):
    """server.py's _APPROVAL_TOOLS and approval.yaml must name the same set.

    Parasitic mode gates on _APPROVAL_TOOLS (serve/server.py), standalone mode on
    config/approval.yaml's require_approval. Two lists, one meaning: if one gains a
    tool the other lacks, the same model call is sensitive in one mode and free in
    the other. Parsed textually on purpose — importing server.py here would drag in
    the host's dependencies, which the managed test runtime does not have.
    """

    def test_the_two_lists_agree(self):
        with open(os.path.join(PROJECT, "serve", "server.py"), encoding="utf-8") as f:
            src = f.read()
        m = re.search(r"_APPROVAL_TOOLS = frozenset\(\{(.*?)\}\)", src, re.S)
        self.assertIsNotNone(m, "_APPROVAL_TOOLS block not found in serve/server.py")
        from_server = set(re.findall(r'"(registry__\w+)"', m.group(1)))

        with open(os.path.join(PROJECT, "config", "approval.yaml"), encoding="utf-8") as f:
            yaml = f.read()
        block = re.search(r"require_approval:(.*?)(?:\n\w|\Z)", yaml, re.S)
        self.assertIsNotNone(block, "require_approval block not found in approval.yaml")
        from_yaml = set(re.findall(r'"(registry__\w+)"', block.group(1)))

        self.assertEqual(from_yaml, from_server,
                         "serve/server.py and config/approval.yaml disagree about registry tools")
        # and the set is exactly the six mutations — not the reads, not the probe
        self.assertEqual(from_server, {
            "registry__add_server", "registry__update_server", "registry__delete_server",
            "registry__add_skill", "registry__update_skill", "registry__delete_skill"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
