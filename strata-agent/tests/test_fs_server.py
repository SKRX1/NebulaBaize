"""Regression tests for servers/fs_server.py -- the filesystem MCP tool.

The bug these pin down is the intermittent `filesystem_write` failure users saw as

    filesystem error: [Errno 13] Permission denied: 'E:\\WorkBuddy\\星云智能体\\strata-agent'

`write` called `_safe("")` when the model omitted `path` (or spelled it `file_path`,
`filename`, ...), and an empty path resolves to the relative base -- the sandbox root --
so the code ended up doing `open(<a directory>, "w")`. Windows answers that with
`PermissionError`, which reads like an ACL problem, so the model retried the identical
call instead of learning it had named a folder. It "worked on the third try" only when
the model happened to emit a real file name.

Every test that touches disk runs against a throwaway FS_ROOT, so a bad call can never
reach the real workspace.

Run: python tests/test_fs_server.py
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
SERVER = ROOT / "servers" / "fs_server.py"
PY = sys.executable


class FsServerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        env = dict(os.environ)
        env.update({
            "FS_ROOT": str(self.root),
            "FS_ALLOW": str(self.root),
            # a missing allow-file: a real workspace selection must never redirect a
            # relative path out of the temp root
            "FS_ALLOW_FILE": str(self.root / "_no_such_roots.txt"),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        })
        self.proc = subprocess.Popen(
            [PY, str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=env, cwd=str(ROOT),
            text=True, encoding="utf-8")
        self.rpc("initialize", {})

    def tearDown(self):
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                stream.close()
            except Exception:
                pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()
        self.tmp.cleanup()

    # -- helpers ---------------------------------------------------------
    def rpc(self, method, params, rid=1):
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": rid, "method": method, "params": params},
            ensure_ascii=False) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        self.assertTrue(line, "server closed the connection")
        return json.loads(line)

    def call(self, tool, args):
        """-> (error message or None, text result or None)"""
        r = self.rpc("tools/call", {"name": tool, "arguments": args})
        if r.get("error"):
            return r["error"]["message"], None
        out = r.get("result", {}).get("content") or []
        text = out[0]["text"] if out else ""
        return None, text

    def files(self):
        return sorted(p.relative_to(self.root).as_posix()
                      for p in self.root.rglob("*") if p.is_file())

    # -- the bug: a folder where a file was expected ----------------------
    def test_directory_target_is_refused_with_a_hint(self):
        (self.root / "sub").mkdir()
        for path in (".", str(self.root), "sub", str(self.root / "sub")):
            with self.subTest(path=path):
                err, _ = self.call("write", {"path": path, "content": "x"})
                self.assertIsNotNone(err, "a directory must never be written to")
                self.assertIn("directory", err)
                self.assertIn("file name", err)
                # the old symptom: an OS-level permission error that hides the cause
                self.assertNotIn("Permission denied", err)
                self.assertNotIn("Errno 13", err)
        self.assertEqual(self.files(), [], "a refused write must not create anything")

    def test_missing_path_is_an_argument_error(self):
        err, _ = self.call("write", {"content": "x"})
        self.assertIsNotNone(err)
        self.assertIn("no file path", err)
        self.assertIn("content", err)             # names what the model actually sent
        self.assertNotIn("Permission denied", err)

    def test_blank_path_is_an_argument_error(self):
        for path in ("", "   "):
            with self.subTest(path=path):
                err, _ = self.call("write", {"path": path, "content": "x"})
                self.assertIsNotNone(err)
                self.assertIn("no file path", err)
        self.assertEqual(self.files(), [])

    def test_separator_only_path_names_the_root_and_is_refused(self):
        # "/" and "\" survive the blank check, then strip to "" and resolve to the
        # sandbox root -- i.e. a directory. Still a clear error, never an OS errno.
        for path in ("/", "\\"):
            with self.subTest(path=path):
                err, _ = self.call("write", {"path": path, "content": "x"})
                self.assertIsNotNone(err)
                self.assertIn("directory", err)
                self.assertNotIn("Permission denied", err)
        self.assertEqual(self.files(), [])

    def test_file_path_alias_is_accepted(self):
        # Schema drift: a model that saw `file_path` elsewhere must not silently
        # resolve to the root -- it should just work.
        err, text = self.call("write", {"file_path": "alias.txt", "content": "ok"})
        self.assertIsNone(err, err)
        self.assertEqual(text, "wrote alias.txt")
        self.assertEqual((self.root / "alias.txt").read_text(encoding="utf-8"), "ok")

    def test_filename_alias_is_accepted(self):
        err, _ = self.call("write", {"filename": "n.txt", "content": "y"})
        self.assertIsNone(err, err)
        self.assertEqual((self.root / "n.txt").read_text(encoding="utf-8"), "y")

    # -- ordinary behaviour that must keep working -----------------------
    def test_write_creates_missing_parents(self):
        err, text = self.call("write", {"path": "a/b/c.txt", "content": "hi"})
        self.assertIsNone(err, err)
        self.assertEqual(text, "wrote a/b/c.txt")
        self.assertEqual((self.root / "a" / "b" / "c.txt").read_text(encoding="utf-8"), "hi")

    def test_write_overwrites_existing_file(self):
        (self.root / "f.txt").write_text("old", encoding="utf-8")
        err, _ = self.call("write", {"path": "f.txt", "content": "new"})
        self.assertIsNone(err, err)
        self.assertEqual((self.root / "f.txt").read_text(encoding="utf-8"), "new")

    def test_missing_content_does_not_create_an_empty_file(self):
        err, _ = self.call("write", {"path": "empty.txt"})
        self.assertIsNotNone(err)
        self.assertIn("content", err)
        self.assertFalse((self.root / "empty.txt").exists(),
                         "an empty file reported as success is worse than an error")

    def test_structured_content_is_encoded_as_json(self):
        err, _ = self.call("write", {"path": "t.json", "content": {"a": 1, "b": "中"}})
        self.assertIsNone(err, err)
        self.assertEqual(json.loads((self.root / "t.json").read_text(encoding="utf-8")),
                         {"a": 1, "b": "中"})

    def test_read_roundtrips_utf8(self):
        (self.root / "cn.txt").write_text("中文 ✓", encoding="utf-8")
        err, text = self.call("read", {"path": "cn.txt"})
        self.assertIsNone(err, err)
        self.assertEqual(text, "中文 ✓")

    def test_read_on_directory_points_at_the_list_tool(self):
        (self.root / "d").mkdir()
        err, _ = self.call("read", {"path": "d"})
        self.assertIsNotNone(err)
        self.assertIn("directory", err)
        self.assertIn("list", err)

    def test_read_missing_path_is_an_argument_error(self):
        err, _ = self.call("read", {})
        self.assertIsNotNone(err)
        self.assertIn("no file path", err)

    def test_list_returns_root_entries(self):
        (self.root / "b.txt").write_text("x", encoding="utf-8")
        (self.root / "a").mkdir()
        err, text = self.call("list", {})
        self.assertIsNone(err, err)
        self.assertEqual(text.splitlines(), ["a", "b.txt"])

    def test_delete_removes_only_files(self):
        (self.root / "gone.txt").write_text("x", encoding="utf-8")
        err, text = self.call("delete", {"path": "gone.txt"})
        self.assertIsNone(err, err)
        self.assertEqual(text, "deleted gone.txt")
        self.assertFalse((self.root / "gone.txt").exists())
        err, text = self.call("delete", {"path": "gone.txt"})
        self.assertIsNone(err, err)
        # The not-found line now also says where it looked: a model that guessed a path
        # needs to see the resolved location, not just "not found" (2026-10-20).
        self.assertTrue(text.startswith("not found: gone.txt"), text)
        self.assertIn(str(self.root), text, text)

    def test_sandbox_escape_is_rejected(self):
        err, _ = self.call("write", {"path": str(self.root.parent / "outside.txt"),
                                     "content": "x"})
        self.assertIsNotNone(err)
        self.assertIn("escapes sandbox", err)


class LockRetryTest(unittest.TestCase):
    """`_with_lock_retry` rides out the transient Windows PermissionError.

    Antivirus / an editor / a dev server can hold a file for a few hundred ms around a
    write. That is a different failure from naming a directory, and it is the only one
    where retrying the *same* call is the right move.
    """

    def setUp(self):
        sys.path.insert(0, str(ROOT / "servers"))
        import importlib
        self.mod = importlib.import_module("fs_server")
        self.addCleanup(sys.path.remove, str(ROOT / "servers"))

    def test_retries_transient_permission_error_then_succeeds(self):
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 3:
                raise PermissionError(13, "Permission denied")
            return "ok"

        with mock.patch.object(self.mod.time, "sleep"):
            self.assertEqual(self.mod._with_lock_retry(flaky), "ok")
        self.assertEqual(len(calls), 3)

    def test_gives_up_after_the_last_attempt(self):
        calls = []

        def always():
            calls.append(1)
            raise PermissionError(13, "Permission denied")

        with mock.patch.object(self.mod.time, "sleep"):
            with self.assertRaises(PermissionError):
                self.mod._with_lock_retry(always)
        self.assertEqual(len(calls), 4)          # initial try + 3 retries

    def test_non_permission_errors_are_not_retried(self):
        calls = []

        def boom():
            calls.append(1)
            raise FileNotFoundError(2, "No such file")

        with self.assertRaises(FileNotFoundError):
            self.mod._with_lock_retry(boom)
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
