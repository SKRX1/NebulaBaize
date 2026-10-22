"""Unit tests for the per-workspace permission gate in run_with_mcp.

The gate lives in the tool-execution hot path, so we exercise it with mocked
hub/svc (no engine, no live model) and assert exactly which tool calls run, are
denied by the user, or are blocked by the auto-review safety net.
"""
import threading
import unittest
import importlib.util
import os


def _load():
    here = os.path.dirname(os.path.abspath(__file__))
    spec = importlib.util.spec_from_file_location("server_mod", os.path.join(here, "server.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


server = _load()


class _Call:
    def __init__(self, name, cid, arguments):
        self.name = name
        self.id = cid
        self.arguments = arguments


class _Event:
    def __init__(self, kind, call=None):
        self.kind = kind
        self.call = call


class _Server:
    def __init__(self, name):
        self.name = name


class _Hub:
    def __init__(self, tool_name, args):
        self.settings = {"max_rounds": 5}
        self._tool = tool_name
        self._args = args
        self.calls = []  # (name, arguments) actually executed

    def routes(self):
        return {self._tool: (_Server("test-server"), self._tool)}

    def call(self, name, arguments, cancel):
        self.calls.append((name, arguments))
        return {"ok": True, "text": "TOOL RESULT", "chars": 11, "truncated": False, "ms": 3}


class _Svc:
    def __init__(self, args, tool_name="filesystem__write"):
        self.approval_pending = {}
        self._args = args
        self._tool = tool_name
        self._round = 0

    def prepare(self, *a, **k):
        return [], None, 0

    def run(self, ids, thinking, tools, max_new, sampling, cancel):
        # First round: the model asks to call the single MCP tool.
        # Later rounds: it has nothing more to do, so finish and stop the loop.
        self._round += 1
        if self._round == 1:
            yield "event", _Event("tool_call", _Call(self._tool, "c1", self._args))
            yield "done", {"completion_tokens": 5, "finish": "stop"}
        else:
            yield "done", {"completion_tokens": 1, "finish": "stop"}


def _run(perm, approve=None, tool_name="filesystem__write", args=None, destructive_shell=False):
    if destructive_shell:
        tool_name = "shell__run"
        args = {"command": "rm -rf /"}
    elif args is None:
        args = {"path": "x", "content": "y"}
    svc = _Svc(args, tool_name)
    hub = _Hub(tool_name, args)
    gen = server.run_with_mcp(
        svc, hub, [{"role": "user", "content": "do it"}], None, None, [], None, 0, 0,
        {"strata_permission": perm}, threading.Event(), {tool_name},
    )
    events = []
    for kind, x in gen:
        if kind == "approval":
            # Simulate the web app's POST /approval/respond (approve/deny each call).
            slot = svc.approval_pending[x["id"]]
            slot["decision"] = bool(approve)
            slot["event"].set()
        events.append((kind, x))
    return svc, hub, events


def _results(events):
    return [x for k, x in events if k == "mcp" and x.get("event") == "result"]


class TestPermissionGate(unittest.TestCase):
    def test_full_runs_without_approval(self):
        svc, hub, events = _run("full")
        self.assertNotIn("approval", [k for k, _ in events], "full tier must not ask for approval")
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])
        self.assertEqual(len(hub.calls), 1, "tool should have executed")

    def test_auto_safe_runs(self):
        svc, hub, events = _run("auto")
        self.assertNotIn("approval", [k for k, _ in events])
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])

    def test_auto_blocks_destructive_shell(self):
        svc, hub, events = _run("auto", destructive_shell=True)
        self.assertNotIn("approval", [k for k, _ in events], "auto tier blocks without prompting")
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["skipped"])
        self.assertEqual(len(hub.calls), 0, "destructive command must not run")

    def test_auto_allows_benign_shell(self):
        svc, hub, events = _run("auto", tool_name="shell__run", args={"command": "python build.py"})
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])
        self.assertEqual(len(hub.calls), 1)

    def test_manual_asks_and_runs_when_approved(self):
        svc, hub, events = _run("manual", approve=True)
        self.assertIn("approval", [k for k, _ in events], "manual tier must ask for approval")
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])
        self.assertEqual(len(hub.calls), 1)

    def test_manual_denied_is_skipped(self):
        svc, hub, events = _run("manual", approve=False)
        self.assertIn("approval", [k for k, _ in events])
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["skipped"])
        self.assertEqual(len(hub.calls), 0, "denied tool must not run")

    def test_unknown_tier_falls_back_to_full(self):
        svc, hub, events = _run("bogus-tier")
        self.assertNotIn("approval", [k for k, _ in events])
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])

    def test_missing_tier_falls_back_to_full(self):
        svc = _Svc({"path": "x", "content": "y"})
        hub = _Hub("filesystem__write", {"path": "x", "content": "y"})
        gen = server.run_with_mcp(
            svc, hub, [{"role": "user", "content": "do it"}], None, None, [], None, 0, 0,
            {}, threading.Event(), {"filesystem__write"},
        )
        events = list(gen)
        self.assertNotIn("approval", [k for k, _ in events])
        self.assertEqual(len(_results(events)), 1)


class TestRegistryApproval(unittest.TestCase):
    """The registry mutations are toolbox changes: even `auto` must ask.

    server.py's _APPROVAL_TOOLS and config/approval.yaml's require_approval are two
    lists of the same set (parasitic vs standalone mode). The lockstep test below
    fails if one gains a tool the other lacks — the two modes must never disagree
    about what is sensitive.
    """

    MUTATIONS = ["registry__add_server", "registry__update_server", "registry__delete_server",
                 "registry__add_skill", "registry__update_skill", "registry__delete_skill"]
    READS = ["registry__list_servers", "registry__get_server", "registry__list_skills",
             "registry__get_skill", "registry__test_server"]

    def test_needs_approval_covers_exactly_the_mutations(self):
        for m in self.MUTATIONS:
            self.assertTrue(server._needs_approval(m), m)
        for r in self.READS:
            self.assertFalse(server._needs_approval(r), r)
        self.assertFalse(server._needs_approval("filesystem__write"))
        self.assertFalse(server._needs_approval(""))

    def test_auto_asks_for_registry_mutation_and_runs_when_approved(self):
        svc, hub, events = _run("auto", approve=True, tool_name="registry__add_server",
                                args={"name": "x", "spec": {"command": "python"}})
        self.assertIn("approval", [k for k, _ in events],
                      "a toolbox change must ask even in the auto tier")
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertTrue(res[0]["ok"])
        self.assertEqual(len(hub.calls), 1)

    def test_auto_denied_registry_mutation_is_skipped(self):
        svc, hub, events = _run("auto", approve=False, tool_name="registry__delete_server",
                                args={"name": "x"})
        self.assertIn("approval", [k for k, _ in events])
        res = _results(events)
        self.assertEqual(len(res), 1)
        self.assertFalse(res[0]["ok"])
        self.assertTrue(res[0]["skipped"])
        self.assertEqual(len(hub.calls), 0, "a denied mutation must not run")

    def test_auto_registry_read_runs_freely(self):
        for tool in self.READS:
            svc, hub, events = _run("auto", tool_name=tool, args={})
            self.assertNotIn("approval", [k for k, _ in events], tool)
            res = _results(events)
            self.assertEqual(len(res), 1, tool)
            self.assertTrue(res[0]["ok"], tool)
            self.assertEqual(len(hub.calls), 1, tool)

    def test_full_registry_mutation_runs_without_approval(self):
        svc, hub, events = _run("full", tool_name="registry__add_skill",
                                args={"name": "x", "spec": {"tools": []}})
        self.assertNotIn("approval", [k for k, _ in events])
        self.assertEqual(len(hub.calls), 1)

    def test_lockstep_with_approval_yaml(self):
        """The standalone mode's list (config/approval.yaml) must name the same set."""
        import re
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for cand in (os.path.join(root, "config", "approval.yaml"),
                     os.path.join(os.path.dirname(root), "config", "approval.yaml")):
            if os.path.isfile(cand):
                text = open(cand, encoding="utf-8").read()
                listed = set(re.findall(r'"(registry__\w+)"', text))
                self.assertEqual(listed, set(server._APPROVAL_TOOLS),
                                f"{cand} and server.py disagree about registry tools")
                return
        self.skipTest("config/approval.yaml not found next to this tree")


if __name__ == "__main__":
    unittest.main()
