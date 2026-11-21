"""skillhub MCP server tests — round 1 (search/stage/probe/incoming/discard).

Run:  C:/Users/sk/.workbuddy/binaries/python/versions/3.13.12/python.exe tests/test_skillhub.py

Two layers, on purpose:
  * direct call_tool() tests for logic, guards and the git/local/template paths
    (the git test clones a local repo over file://, so it needs no network);
  * a real-subprocess stdio test: the server is spawned and spoken to over the
    wire with a Chinese query, which is the only proof the UTF-8 contract holds.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(PROJECT, "servers")
CONFIG = os.path.join(PROJECT, "config", "mcp_servers.json")
PY = sys.executable

sys.path.insert(0, SERVERS)
from skillhub_server import SkillHubServer  # noqa: E402


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


class SkillHubBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="skillhub-test-")
        self.incoming = os.path.join(self.tmp, "_incoming")
        self.srv = SkillHubServer(incoming_dir=self.incoming)
        self.cfg_before = (_md5(CONFIG), os.path.getmtime(CONFIG))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ok(self, res):
        d = json.loads(res)
        # probe results legitimately carry "error": null — only a non-null error is a failure
        self.assertIsNone(d.get("error"), res)
        return d

    def _j(self, res):
        return json.loads(res)


class TestSearch(SkillHubBase):
    def test_chinese_query_finds_template(self):
        d = self._ok(self.srv.call_tool("search", {"query": "模板"}))
        self.assertGreaterEqual(d["count"], 1)
        names = [h["name"] for h in d["hits"]]
        self.assertIn("strata-skill-template", names)

    def test_english_query_finds_official(self):
        d = self._ok(self.srv.call_tool("search", {"query": "fetch"}))
        self.assertIn("mcp-server-fetch", [h["name"] for h in d["hits"]])
        hit = [h for h in d["hits"] if h["name"] == "mcp-server-fetch"][0]
        self.assertEqual(hit["trust"], "official")
        self.assertIn("pip install", hit["needs"])

    def test_empty_query_lists_all(self):
        d = self._ok(self.srv.call_tool("search", {}))
        self.assertEqual(d["count"], 5)

    def test_no_match(self):
        d = self._ok(self.srv.call_tool("search", {"query": "zzz-not-a-thing"}))
        self.assertEqual(d["count"], 0)


class TestStageAndProbe(SkillHubBase):
    def test_template_stage_and_probe(self):
        d = self._ok(self.srv.call_tool("stage", {"name": "strata-skill-template"}))
        self.assertEqual(d["kind"], "template")
        self.assertEqual(d["trust"], "builtin")
        self.assertEqual(d["warnings"], [])
        dest = d["dir"]
        for f in ("server.py", "_mcp_base.py", "skill.yaml", "draft.json", "meta.json"):
            self.assertTrue(os.path.isfile(os.path.join(dest, f)), f)
        self.assertTrue(os.path.isfile(os.path.join(self.incoming, "README.txt")))

        p = self._ok(self.srv.call_tool("probe", {"name": "strata-skill-template"}))
        self.assertTrue(p["ok"], p)
        self.assertIn("hello", [t["name"] for t in p["tools"]])

    def test_bad_names_rejected(self):
        for bad in ("../evil", "a/b", "", "..", "技能", "a b", "_incoming"):
            d = self._j(self.srv.call_tool("stage", {"name": bad}))
            self.assertIn("error", d, f"{bad!r} should be rejected")

    def test_local_source_stage_and_probe(self):
        repo = os.path.join(self.tmp, "localsrc")
        os.makedirs(repo)
        with open(os.path.join(repo, "server.py"), "wb") as f:
            f.write(_tiny_server_text().encode("utf-8"))
        with open(os.path.join(SERVERS, "_mcp_base.py"), "rb") as f:
            base = f.read()
        with open(os.path.join(repo, "_mcp_base.py"), "wb") as f:
            f.write(base)
        d = self._ok(self.srv.call_tool("stage", {"name": "tiny-local", "source": repo}))
        self.assertEqual(d["trust"], "unverified")
        p = self._ok(self.srv.call_tool("probe", {"name": "tiny-local"}))
        self.assertTrue(p["ok"], p)
        self.assertEqual([t["name"] for t in p["tools"]], ["ping"])

    def test_git_source_with_subdir_offline(self):
        """The git path, exercised for real against a local repo over file:// (no network)."""
        repo = os.path.join(self.tmp, "gitrepo")
        pkg = os.path.join(repo, "pkg")
        os.makedirs(pkg)
        with open(os.path.join(pkg, "server.py"), "wb") as f:
            f.write(_tiny_server_text().encode("utf-8"))
        with open(os.path.join(SERVERS, "_mcp_base.py"), "rb") as f:
            base = f.read()
        with open(os.path.join(pkg, "_mcp_base.py"), "wb") as f:
            f.write(base)
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                   GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        for cmd in (["git", "init", "-q", repo],
                    ["git", "-C", repo, "add", "-A"],
                    ["git", "-C", repo, "commit", "-qm", "init"]):
            r = subprocess.run(cmd, capture_output=True, env=env)
            self.assertEqual(r.returncode, 0, r.stderr)
        from pathlib import Path
        url = Path(repo).as_uri()                      # file:///...
        d = self._ok(self.srv.call_tool("stage", {"name": "tiny-git", "source": url, "subdir": "pkg"}))
        self.assertEqual(d["kind"], "git")
        staged_files = os.listdir(os.path.join(d["dir"], "src", "pkg"))
        self.assertIn("server.py", staged_files)
        p = self._ok(self.srv.call_tool("probe", {"name": "tiny-git"}))
        self.assertTrue(p["ok"], p)
        self.assertEqual([t["name"] for t in p["tools"]], ["ping"])

    def test_probe_unstaged_is_clean_error(self):
        d = self._j(self.srv.call_tool("probe", {"name": "never-staged"}))
        self.assertIn("error", d)

    def test_restage_refreshes(self):
        self.srv.call_tool("stage", {"name": "strata-skill-template"})
        first = _md5(os.path.join(self.incoming, "strata-skill-template", "server.py"))
        d = self._ok(self.srv.call_tool("stage", {"name": "strata-skill-template"}))
        self.assertEqual(d["kind"], "template")        # no duplicate dirs, no crash on re-stage


class TestIncomingDiscard(SkillHubBase):
    def test_list_and_discard(self):
        self.srv.call_tool("stage", {"name": "strata-skill-template"})
        d = self._ok(self.srv.call_tool("incoming", {}))
        self.assertEqual([c["name"] for c in d["candidates"]], ["strata-skill-template"])
        cand = d["candidates"][0]
        self.assertIn("draft", cand)
        self.assertEqual(cand["draft"]["_meta"]["status"].split(" ")[0], "staged")

        r = self._ok(self.srv.call_tool("discard", {"name": "strata-skill-template"}))
        self.assertEqual(r["discarded"], "strata-skill-template")
        self.assertEqual(r["remaining"], [])
        self.assertFalse(os.path.isdir(os.path.join(self.incoming, "strata-skill-template")))
        self.assertTrue(os.path.isfile(os.path.join(self.incoming, "README.txt")))

    def test_discard_guards(self):
        for bad in ("../..", "..", "", "nope-not-here"):
            d = self._j(self.srv.call_tool("discard", {"name": bad}))
            self.assertIn("error", d, f"{bad!r} should be refused")
        self.assertTrue(os.path.isdir(self.incoming) or not os.path.exists(self.incoming))


class TestConfigUntouched(SkillHubBase):
    def test_no_tool_writes_the_config(self):
        for call in (("search", {"query": "x"}),
                     ("stage", {"name": "strata-skill-template"}),
                     ("probe", {"name": "strata-skill-template"}),
                     ("incoming", {}),
                     ("discard", {"name": "strata-skill-template"})):
            self.srv.call_tool(*call)
        self.assertEqual(_md5(CONFIG), self.cfg_before[0])
        self.assertEqual(os.path.getmtime(CONFIG), self.cfg_before[1])


class TestStdioWire(unittest.TestCase):
    """The server, spawned for real, spoken to over stdio with a Chinese query."""

    def test_handshake_and_chinese_roundtrip(self):
        tmp = tempfile.mkdtemp(prefix="skillhub-wire-")
        env = dict(os.environ, SKILLHUB_INCOMING=os.path.join(tmp, "_incoming"))
        frames = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
            {"jsonrpc": "2.0", "id": 3, "method": "tools/call",
             "params": {"name": "search", "arguments": {"query": "模板"}}},
        ]
        payload = b"".join((json.dumps(f, ensure_ascii=False).encode("utf-8") + b"\n") for f in frames)
        p = subprocess.run([PY, os.path.join(SERVERS, "skillhub_server.py")],
                           input=payload, capture_output=True, env=env, timeout=60)
        lines = [ln for ln in p.stdout.decode("utf-8").splitlines() if ln.strip()]
        msgs = [json.loads(ln) for ln in lines]
        by_id = {m.get("id"): m for m in msgs if "id" in m}

        self.assertEqual(by_id[1]["result"]["serverInfo"]["name"], "skillhub")
        tools = [t["name"] for t in by_id[2]["result"]["tools"]]
        self.assertEqual(sorted(tools), ["discard", "incoming", "probe", "search", "stage"])

        text = by_id[3]["result"]["content"][0]["text"]
        hits = json.loads(text)["hits"]
        self.assertIn("strata-skill-template", [h["name"] for h in hits])   # Chinese query worked
        self.assertEqual(p.returncode, 0, p.stderr.decode("utf-8", "replace")[-500:])


if __name__ == "__main__":
    unittest.main(verbosity=2)
