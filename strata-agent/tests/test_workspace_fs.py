"""Unit test for serve/workspace_fs.py — the sidebar "打开文件夹" path logic.

This is the root-cause fix for the bug where clicking 打开文件夹 on a task/workspace
copied a bare filename instead of a real folder path: legacy sessions stored only a
workspace *name* (the user typed it into a text box) rather than a full folder path.
resolve_workspace_folder() now resolves a safe bare name to a real folder under the
workspace root (creating it if missing) and rejects anything it cannot safely open.

Run: python tests/test_workspace_fs.py
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SERVE = HERE.parent / "serve"
sys.path.insert(0, str(SERVE))

import workspace_fs  # noqa: E402
from workspace_fs import resolve_workspace_folder, open_folder  # noqa: E402


class ResolveTests(unittest.TestCase):
    def test_absolute_existing_dir_is_returned(self):
        with tempfile.TemporaryDirectory() as d:
            got = resolve_workspace_folder(d, workspace_root="/no/such/root")
            self.assertEqual(Path(got), Path(d).resolve())

    def test_bare_name_is_created_under_root(self):
        with tempfile.TemporaryDirectory() as root:
            got = resolve_workspace_folder("My Project", workspace_root=root)
            self.assertIsNotNone(got)
            self.assertTrue(Path(got).is_dir())
            self.assertEqual(Path(got), (Path(root) / "My Project").resolve())

    def test_second_call_returns_same_existing_folder(self):
        with tempfile.TemporaryDirectory() as root:
            first = resolve_workspace_folder("ws", workspace_root=root)
            second = resolve_workspace_folder("ws", workspace_root=root)
            self.assertEqual(Path(first), Path(second))
            self.assertTrue(Path(first).is_dir())

    def test_absolute_missing_returns_none(self):
        got = resolve_workspace_folder("C:/no/such/dir/xyzzy", workspace_root="/tmp")
        self.assertIsNone(got)

    def test_dotdot_returns_none(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(resolve_workspace_folder("../escape", workspace_root=root))

    def test_separator_returns_none(self):
        # We only auto-create direct children of the root; a path with a separator
        # that is not absolute must not be guessed/created.
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(resolve_workspace_folder("a/b", workspace_root=root))

    def test_leading_dot_returns_none(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(resolve_workspace_folder(".hidden", workspace_root=root))

    def test_empty_and_none_return_none(self):
        self.assertIsNone(resolve_workspace_folder("", workspace_root="/tmp"))
        self.assertIsNone(resolve_workspace_folder(None, workspace_root="/tmp"))

    def test_relative_missing_with_separator_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(resolve_workspace_folder("nested/deep", workspace_root=root))


class OpenTests(unittest.TestCase):
    def test_open_folder_invokes_os_on_windows(self):
        if os.name != "nt":
            self.skipTest("os.startfile only exists on Windows")
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.object(workspace_fs.os, "startfile") as m:
                open_folder(d)
                m.assert_called_once_with(d)

    def test_open_folder_invokes_open_on_mac(self):
        if os.name == "nt":
            self.skipTest("Popen(['open']) only on darwin")
        with mock.patch.object(workspace_fs.subprocess, "Popen") as m, \
             mock.patch.object(workspace_fs.sys, "platform", "darwin"):
            open_folder("/tmp/x")
            m.assert_called_once_with(["open", "/tmp/x"])

    def test_open_folder_invokes_xdg_on_linux(self):
        if os.name == "nt":
            self.skipTest("Popen(['xdg-open']) only on linux")
        with mock.patch.object(workspace_fs.subprocess, "Popen") as m, \
             mock.patch.object(workspace_fs.sys, "platform", "linux"):
            open_folder("/tmp/x")
            m.assert_called_once_with(["xdg-open", "/tmp/x"])


class ListDirsTests(unittest.TestCase):
    def test_existing_dir_lists_subdirs_sorted(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, "b").mkdir()
            Path(root, "a").mkdir()
            Path(root, "file.txt").write_text("x")
            out = workspace_fs.list_dirs(root)
            self.assertTrue(out["exists"])
            self.assertTrue(out["readable"])
            names = [d["name"] for d in out["dirs"]]
            self.assertEqual(names, ["a", "b"])             # files excluded, casefold-sorted

    def test_parent_paths_back_to_ancestor(self):
        with tempfile.TemporaryDirectory() as root:
            child = Path(root, "child")
            child.mkdir()
            out = workspace_fs.list_dirs(str(child))
            self.assertEqual(Path(out["parent"]), Path(root).resolve())

    def test_missing_dir_reports_exists_false_not_exception(self):
        out = workspace_fs.list_dirs("/no/such/folder/xyzzy")
        self.assertFalse(out["exists"])
        self.assertFalse(out["readable"])
        self.assertEqual(out["dirs"], [])

    def test_empty_path_yields_no_listing(self):
        out = workspace_fs.list_dirs("")
        self.assertFalse(out["exists"])
        self.assertIsNone(out["parent"])

    def test_drive_only_is_nudged_to_root(self):
        if os.name != "nt":
            self.skipTest("drive-letter handling is Windows-only")
        out = workspace_fs.list_dirs("C:")          # drive-relative -> nudge to C:\
        self.assertEqual(out["path"].upper().rstrip("\\") + "\\", "C:\\")
        self.assertIsNone(out["parent"])           # a drive root has no parent

    def test_hidden_flagged(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, ".secret").mkdir()
            out = workspace_fs.list_dirs(root)
            hid = {d["name"]: d["hidden"] for d in out["dirs"]}
            self.assertTrue(hid.get(".secret"))


class BrowseRootsTests(unittest.TestCase):
    def test_roots_contain_drive_or_posix_and_places(self):
        r = workspace_fs.browse_roots()
        self.assertIn("drives", r)
        self.assertIn("places", r)
        if os.name == "nt":
            self.assertTrue(any(d["name"] == "C:" for d in r["drives"]))
        else:
            self.assertTrue(any(d["name"] == "/" for d in r["drives"]))
        self.assertTrue(any(p["name"] for p in r["places"]))

    def test_places_dedupe_by_resolved_path(self):
        with tempfile.TemporaryDirectory() as root:
            r = workspace_fs.browse_roots(workspace_root=root)
            paths = [p["path"] for p in r["places"]]
            self.assertEqual(len(paths), len(set(paths)))   # no duplicate folders


if __name__ == "__main__":
    unittest.main(verbosity=2)
