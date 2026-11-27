"""Filesystem helpers for the sidebar's workspace features.

 * ``resolve_workspace_folder`` / ``open_folder`` back "打开文件夹".
 * ``list_dirs`` / ``browse_roots`` back the workspace picker's folder browser.

Kept dependency-free on purpose: the main server pulls in the model engine and
the MCP stack at import time, so a unit test for the path logic must be able to
import this module without dragging all of that in.
"""
import os
import re
import string
import subprocess
import sys
from pathlib import Path


# Mirror server.py's ROOT: this file lives in <root>/serve, so parents[1] is <root>.
ROOT = Path(__file__).resolve().parents[1]


def resolve_workspace_folder(raw, workspace_root=None):
    """Turn a workspace reference into an existing (or, for a safe bare name,
    freshly created) folder path -- or return None when it cannot be resolved.

    Rules:
      * an absolute path that already exists and is a directory -> that path
      * a relative / bare name -> resolved under ``workspace_root``; if it does
        not yet exist but is a *safe* single folder name (no separators, no
        "..", no leading dot) it is created as a direct child of the root and
        returned
      * anything else (absolute-but-missing, "..", a path with separators that
        would escape the root) -> None, so the caller can 400 cleanly instead
        of guessing or creating the wrong thing

    The self-healing branch exists because older clients stored only a bare
    workspace *name* (the user typed it into a text box) instead of a full
    folder path. A workspace is always a folder, so creating a missing safe one
    matches the user's intent ("open my workspace folder") and makes that legacy
    data work on first click.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    root = Path(workspace_root or ROOT)
    try:
        target = Path(raw).expanduser()
        if not target.is_absolute():
            target = root / target
        target = target.resolve()
    except (OSError, ValueError):
        return None
    if target.is_dir():
        return target
    # Self-heal legacy data: a missing safe bare name becomes a real folder.
    safe = (
        not os.path.isabs(raw)
        and "/" not in raw
        and "\\" not in raw
        and raw not in (".", "..")
        and not raw.startswith(".")
    )
    if safe:
        base = root.resolve()
        cand = (base / raw).resolve()
        # Never let a crafted name escape the root (defence in depth; ".." is
        # already excluded above, this guards against symlink tricks too).
        if str(cand).startswith(str(base)):
            try:
                cand.mkdir(parents=True, exist_ok=True)
                return cand
            except OSError:
                return None
    return None


def open_folder(target):
    """Reveal an existing folder in the OS file manager. The path is passed as a
    single argv element -- never through a shell -- so this can only ever open a
    folder view, never execute an arbitrary command built from the path.
    """
    target = Path(target)
    if os.name == "nt":
        os.startfile(str(target))            # Explorer; no shell, no command line
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)])
    else:
        subprocess.Popen(["xdg-open", str(target)])


# ---------------------------------------------------------------- folder browser
# Why this exists: the web app's "Browse" button used ``showDirectoryPicker()``,
# but the File System Access API deliberately never exposes a folder's absolute
# path -- a handle carries only its leaf name. A workspace needs the real path
# (the agent resolves relative paths against the *server's* cwd, so a leaf name
# silently points somewhere else), which means the picker cannot live in the
# browser. The server already owns the filesystem for the agent, so it lists the
# directories instead and the UI gets a true absolute path.

_DRIVE_ONLY = re.compile(r"^[A-Za-z]:$")


def _norm_dir(raw):
    """Normalise a user-supplied folder reference to an absolute Path, or None.

    ``C:`` alone is drive-*relative* on Windows ("wherever the process happens
    to be on C:"), so it is nudged to ``C:\\`` before resolving. A relative path
    resolves against the server's cwd, which is what a bare name has always
    meant here.
    """
    raw = (raw or "").strip()
    if not raw:
        return None
    if os.name == "nt" and _DRIVE_ONLY.match(raw):
        raw += os.sep
    try:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        return p.resolve()
    except (OSError, ValueError, RuntimeError):
        return None


def _is_hidden(entry):
    """Dot-prefixed, or Windows' FILE_ATTRIBUTE_HIDDEN. Only used to dim a row;
    hidden folders stay selectable (people do keep projects in them)."""
    try:
        if entry.name.startswith("."):
            return True
        if os.name == "nt":
            return bool(getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0) & 0x2)
    except OSError:
        pass
    return False


def list_dirs(path=None, workspace_root=None, file_ext=None):
    """One level of sub-directories, for the workspace picker's folder browser.

    Returns ``{"path", "parent", "dirs": [{"name","path","hidden"}], "exists",
    "readable"}``. A missing or unreadable folder comes back as a normal result
    with ``exists``/``readable`` false instead of raising, so the UI can say
    "this folder is gone" rather than showing an error dialog.

    ``path`` empty -> the caller wants somewhere to start; ``browse_roots`` is
    the endpoint for that, so an empty path here just reports exists=False.
    """
    p = _norm_dir(path)
    if p is None:
        return {"path": "", "parent": None, "dirs": [], "files": [], "exists": False, "readable": False}

    out = {"path": str(p), "parent": None, "dirs": [], "exists": p.is_dir(), "readable": False}
    if not out["exists"]:
        return out
    try:
        parent = p.parent
        if parent != p:                       # a drive root ("C:\\") is its own parent
            out["parent"] = str(parent)
    except (OSError, RuntimeError):
        pass
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if not e.is_dir():
                        continue
                except OSError:               # a dangling symlink or a race: skip it
                    continue
                out["dirs"].append({"name": e.name, "path": str(p / e.name), "hidden": _is_hidden(e)})
        out["readable"] = True
    except OSError:
        out["readable"] = False               # exists but denied (e.g. System Volume Information)
    out["dirs"].sort(key=lambda d: d["name"].casefold())
    if file_ext:                      # [A1 2026-11-27] the image-model picker needs FILES,
        # not just folders: list files whose name ends with this extension (e.g. ".gguf")
        # so a model .gguf can be picked directly instead of landing on a folder path.
        ext = tuple(x for x in file_ext.lower().split(",") if x) or file_ext.lower()
        out["files"] = []
        try:
            with os.scandir(p) as it:
                for e in it:
                    try:
                        if not e.is_file():
                            continue
                    except OSError:
                        continue
                    if e.name.lower().endswith(ext):
                        out["files"].append({"name": e.name, "path": str(p / e.name),
                                             "hidden": _is_hidden(e)})
        except OSError:
            pass                      # dir became unreadable mid-scan; dirs already listed
        out["files"].sort(key=lambda f: f["name"].casefold())
    return out


def browse_roots(workspace_root=None):
    """Where the folder browser can start: drive letters (Windows) or "/", plus
    the usual personal folders and this project's own workspace root.

    Deduplicated by resolved path so "项目根" and "工作区根" collapsing onto the
    same folder shows up once.
    """
    drives, places, seen = [], [], set()

    def push(bucket, target, label):
        try:
            p = Path(target).expanduser().resolve()
            if not p.is_dir() or str(p) in seen:
                return
            seen.add(str(p))
            bucket.append({"name": label, "path": str(p)})
        except (OSError, ValueError, RuntimeError):
            pass

    if os.name == "nt":
        for ch in string.ascii_uppercase:
            root = f"{ch}:{os.sep}"
            if os.path.exists(root):
                push(drives, root, f"{ch}:")
    else:
        push(drives, "/", "/")

    home = Path.home()
    push(places, home, home.name or str(home))
    push(places, home / "Desktop", "桌面")
    push(places, home / "Documents", "文档")
    if workspace_root:
        push(places, workspace_root, "工作区根目录")
    push(places, ROOT, "项目根目录")
    return {"drives": drives, "places": places, "home": str(home)}

