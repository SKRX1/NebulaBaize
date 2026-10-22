"""Filesystem MCP server: read/write/list files in a sandboxed root (pure std lib).

Sandbox roots (a path is allowed if it lives inside ANY of them):
  - FS_ROOT        : primary root (default: the server's cwd)
  - FS_ALLOW       : extra allowed roots, ';'-separated (env)
  - FS_ALLOW_FILE  : a file of extra allowed roots, one per line (read fresh on every call);
                     lets the host inject the user's selected workspace at request time.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase, smart_decode

ROOT = os.path.abspath(os.environ.get("FS_ROOT", os.getcwd()))
_ALLOW_ENV = [os.path.abspath(p) for p in (os.environ.get("FS_ALLOW") or "").split(";") if p.strip()]
_ALLOW_FILE = os.environ.get("FS_ALLOW_FILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "fs_allowed_roots.txt")

# Looks like a real absolute path: a drive letter (C:\ / C:/), a UNC share (\\host),
# or a POSIX root (/). A bare folder name (e.g. "打砖块3") is NOT absolute.
_ABS_RE = re.compile(r"^(?:[a-zA-Z]:[\\/]|[\\/]{2}|/)")

# Keys a model may use for "the file I mean". The schema says `path`, but a model that
# has seen another filesystem tool (Claude's `file_path`, or a `filename`/`file` wording)
# mixes them up. Before, a miss fell through to "" and resolved to the sandbox root, so
# the OS answered `[Errno 13] Permission denied: '<root>'` -- see FsServer._target.
_PATH_KEYS = ("path", "file_path", "filepath", "filename", "file", "target")


def _first_string(args: dict, keys) -> str:
    """The first non-blank string among `keys` ('' when the caller named no target)."""
    for k in keys:
        v = args.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ""


def _with_lock_retry(fn, *a, **kw):
    """Run a file operation again when a *transient* Windows lock vetoes it.

    Windows reports `PermissionError` (WinError 5) when antivirus, an editor or a dev
    server holds the file for a few hundred ms around a write. Those clear on their own,
    so retrying turns a spurious tool error into a success instead of making the model
    redo the whole call. A directory target is a caller mistake and is rejected before
    we get here, so this only ever sees real files.
    """
    delays = (0.15, 0.35, 0.7)
    attempt = 0
    while True:
        try:
            return fn(*a, **kw)
        except PermissionError:
            if attempt >= len(delays):
                raise
            time.sleep(delays[attempt])
            attempt += 1



def _workspace_roots() -> list[str]:
    """The workspace root(s) the host injected via FS_ALLOW_FILE -- absolute ones only.

    A bare leaf name (the browser's folder picker can only reveal the leaf) is ignored
    here: resolving it would silently point at a non-existent directory under the server
    cwd. Only real absolute paths are treated as a workspace.
    """
    out = []
    try:
        with open(_ALLOW_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and _ABS_RE.match(line):
                    out.append(os.path.abspath(line))
    except FileNotFoundError:
        pass
    return out


def _current_workspace() -> str | None:
    """The workspace the user is in NOW: the newest (last) absolute record.

    The host *moves* the active workspace to the end of the record file on every request,
    so "last" means "current". A bare leaf name (which a browser folder picker can leak in)
    is skipped, so the newest *usable* entry wins.
    """
    ws = _workspace_roots()
    for r in reversed(ws):
        if os.path.isdir(r):
            return r
    return ws[-1] if ws else None


def _relative_base() -> str:
    """Base directory for RELATIVE paths.

    Resolve relative paths against the CURRENT workspace -- that is the user's mental model
    ("work inside my workspace"). Absolute paths are never affected.

    This used to require *exactly one* recorded root. That rule was structurally broken: the
    host appends every workspace the user ever opens and never prunes, so from the second
    workspace onward the condition was permanently false and the base silently collapsed to
    ROOT (this agent's install dir). The model was told "work in 打砖块2" while every relative
    path landed in strata-agent/ -- see the 2026-10-20 report (`list 游戏开发/打砖块2` ->
    `strata-agent\\游戏开发\\打砖块2`, WinError 3). Newest-wins is also what makes switching
    back to an older workspace work.
    """
    return _current_workspace() or ROOT


def _allowed_roots() -> list[str]:
    roots = [ROOT, *_ALLOW_ENV]
    try:
        with open(_ALLOW_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    roots.append(os.path.abspath(line))
    except FileNotFoundError:
        pass
    return roots


def _where(p: str, ap: str) -> str:
    """A one-line "what actually happened" tail for every path error.

    Without it a failure reads `[WinError 3] 系统找不到指定的路径`, which tells the model
    nothing about *why*: it re-issues the same call under a different spelling and burns
    rounds guessing which directory the tools are pinned to (2026-10-20). Naming the
    resolved path and the base makes the retry correct on the first try.
    """
    return f"resolved to '{ap}'; relative paths resolve against '{_relative_base()}'"


def _into_base(p: str, base: str) -> str | None:
    """Re-anchor a path that needlessly re-states the workspace it is already in.

    A model that saw the workspace as "游戏开发/打砖块2" (relative to a higher root) writes
    exactly that, and the plain resolution lands on `<base>\\游戏开发\\打砖块2`, which is not
    there -- the 2026-10-20 report. When the first segments of a RELATIVE path equal the tail
    of the base, drop them: `游戏开发/打砖块2` -> base, `游戏开发/打砖块2/a.js` ->
    `<base>\\a.js`. Only 2+ matching segments (or one that consumes the whole path) qualify,
    so a genuine sub-folder of the same name is left alone.
    """
    if _ABS_RE.match(p):
        return None
    segs = [s for s in re.split(r"[\\/]+", p.strip().strip("/\\")) if s and s != "."]
    bsegs = [s for s in re.split(r"[\\/]+", base.strip().strip("/\\")) if s]
    if not segs or not bsegs:
        return None
    for k in range(min(len(segs), len(bsegs)), 1, -1):
        if [s.lower() for s in segs[:k]] == [s.lower() for s in bsegs[-k:]]:
            return os.path.abspath(os.path.join(base, *segs[k:]))
    return None


class FsServer(McpServerBase):
    name = "filesystem"
    tools = [
        {"name": "read",
         "description": "Read a text file inside an allowed root. 'path' must name a file "
                        "(e.g. \"serve/web/app.js\"), not a folder.",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
        {"name": "write",
         "description": "Write or append a text file inside an allowed root. 'path' must be a "
                        "file path that includes the file NAME (e.g. \"serve/web/app.js\"), "
                        "never a folder. Use mode='overwrite' (default) to replace the file, "
                        "or mode='append' to add to its end (create it if it does not exist). "
                        "For LARGE content split it into several calls with mode='append' "
                        "(first call overwrite, the rest append) instead of one huge call that "
                        "may exceed the per-turn output limit.",
         "inputSchema": {"type": "object", "properties": {
             "path": {"type": "string"},
             "content": {"type": "string"},
             "mode": {"type": "string", "enum": ["overwrite", "append"]}},
             "required": ["path", "content"]}},
        {"name": "list", "description": "List files in a directory (relative to an allowed root)",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}}},
        {"name": "delete", "description": "Delete a file inside an allowed root",
         "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    ]

    def _target(self, args, tool) -> tuple[str, str]:
        """Resolve the file a call names -- and fail *clearly* when it names no file.

        A call with no `path` (or one spelled `file_path`) used to fall through to ""
        and resolve against the relative base, which is the sandbox root. The write then
        died in `open()` with `[Errno 13] Permission denied: '<root>'`: a message that
        reads like an ACL problem, so the model retried the identical call instead of
        learning it had passed a folder. Retrying "a few times until it worked" was just
        the model eventually emitting a file name. Both slips now get an error that says
        what to fix, so one retry is enough.
        """
        p = _first_string(args, _PATH_KEYS)
        if not p:
            raise Exception(
                f"{tool}: no file path given. Pass 'path' with a file NAME inside the "
                f"workspace (e.g. \"serve/web/app.js\"), not a folder. "
                f"Relative paths resolve against '{_relative_base()}'. "
                f"arguments={sorted(args) or '{}'}")
        ap = self._safe(p)
        if tool in ("read", "write") and os.path.isdir(ap):
            hint = ("use the 'list' tool to see what is inside it" if tool == "read"
                    else "append the file name")
            raise Exception(f"{tool}: '{p}' is a directory, not a file -- {hint} "
                            f"({_where(p, ap)}).")
        return p, ap

    def _safe(self, path: str) -> str:
        # Absolute paths pass through unchanged (os.path.join drops the base when the
        # second operand is absolute). Relative paths resolve against the CURRENT
        # workspace (see _relative_base), else against ROOT.
        base = _relative_base()
        ap = os.path.abspath(os.path.join(base, path.lstrip("/\\")))
        if not os.path.exists(ap):
            ap = _into_base(path, base) or ap          # self-heal a re-stated workspace prefix
        for r in _allowed_roots():
            r = os.path.abspath(r)
            if ap == r or ap.startswith(r + os.sep):
                return ap
        raise Exception(f"path escapes sandbox root: {_where(path, ap)}; "
                        f"allowed roots: {', '.join(_allowed_roots()[:4])}")

    def call_tool(self, name, args):
        if name == "read":
            p, ap = self._target(args, "read")
            if not os.path.exists(ap):
                raise Exception(f"read: '{p}' does not exist ({_where(p, ap)})")
            # Read bytes and sniff the codec: files on a Chinese Windows are not all
            # UTF-8 -- a legacy GBK HTML/CSV read as UTF-8 came back as a wall of
            # U+FFFD. smart_decode prefers UTF-8 and falls back to GBK.
            with open(ap, "rb") as f:
                return smart_decode(f.read())
        if name == "write":
            p, ap = self._target(args, "write")
            content = args.get("content")
            if content is None:
                content = args.get("text")
            if content is None:
                # Silently writing "" here used to "succeed" and leave an empty file,
                # which is worse than an error: the caller thinks the write landed.
                raise Exception(
                    f"write: missing 'content'. arguments={sorted(args) or '{}'}")
            if not isinstance(content, str):
                content = (json.dumps(content, ensure_ascii=False, indent=2)
                           if isinstance(content, (dict, list)) else str(content))
            mode = str(args.get("mode") or "overwrite").strip().lower()
            if mode not in ("overwrite", "append"):
                raise Exception(
                    f"write: mode must be 'overwrite' or 'append', got '{mode}'. "
                    f"arguments={sorted(args) or '{}'}")
            _with_lock_retry(os.makedirs, os.path.dirname(ap) or ap, exist_ok=True)

            if mode == "append":
                def _flush():                    # append: never truncates, safe to re-try
                    with open(ap, "a", encoding="utf-8") as f:
                        f.write(content)
                _with_lock_retry(_flush)
                return f"appended {len(content)} chars to {p}"
            else:
                def _flush():                    # overwrite: retried as a whole (re-truncates)
                    with open(ap, "w", encoding="utf-8") as f:
                        f.write(content)
                _with_lock_retry(_flush)
                return f"wrote {p}"
        if name == "list":
            p = _first_string(args, _PATH_KEYS)
            ap = self._safe(p)
            # `os.listdir` on a file raises `[WinError 267] 目录名称无效` and on a missing
            # path `[WinError 3]`. Both are 0.0s dead ends that name neither the mistake
            # nor the base -- the model retried with another spelling instead of switching
            # tool (2026-10-20: `list c01.txt`). Say what it is and which tool to use.
            if not os.path.exists(ap):
                raise Exception(f"list: '{p}' does not exist ({_where(p, ap)}). "
                                f"Pass a path relative to that base, or an absolute path.")
            if not os.path.isdir(ap):
                raise Exception(f"list: '{p}' is a file, not a folder -- use the 'read' "
                                f"tool for it ({_where(p, ap)}).")
            return "\n".join(sorted(os.listdir(ap)))
        if name == "delete":
            p, ap = self._target(args, "delete")
            if not os.path.exists(ap) or not os.path.isfile(ap):
                return f"not found: {p} ({_where(p, ap)})"
            _with_lock_retry(os.remove, ap)
            return f"deleted {p}"
        raise Exception(f"unknown tool: {name}")


if __name__ == "__main__":
    sys.exit(FsServer().run())
