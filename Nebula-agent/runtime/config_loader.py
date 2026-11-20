"""Shared config loader: JSON, PyYAML (if present), else a built-in indent-based YAML parser.

Pure standard library so the project stays dependency-free. The built-in parser covers the
constructs this project's configs actually use:

  - nested mappings by 2-space indentation
  - block sequences (`- item`), where an item may itself be a mapping
  - flow collections: `[ ... ]` and `{ ... }` (JSON-style, single-line)
  - quoted and bare scalars (str / int / float / bool / null)

It is intentionally small; deeply exotic YAML (anchors, multi-doc, block scalars) is not
targeted — for those, install PyYAML or use JSON. Used by approval.yaml, sandbox.yaml and
skills/*.yaml so config stays stdlib-only when PyYAML is absent.
"""
from __future__ import annotations

import json
import os
import sys


# What identifies "this project's directory" is not a directory name that could occur
# by coincidence one level up, but the two files the runtime cannot work without.
_ROOT_MARKERS = (os.path.join("config", "mcp_servers.json"),
                 os.path.join("web", "index.html"),
                 os.path.join("serve", "web", "index.html"))


def _holds_project(d: str) -> bool:
    """True when `d` really is a project/release root (one of the markers is inside)."""
    return bool(d) and any(os.path.isfile(os.path.join(d, m)) for m in _ROOT_MARKERS)


def project_root(module_file: str = "", exe_path: str = "") -> str:
    """Where this project keeps config/ web/ data/ -- derived from the layout, never stored.

    Two layouts exist and the naive two-dirnames expression only fits one of them:
      source checkout  : runtime/gateway.py, so the root IS two levels up, and <root>/config
                       exists to confirm it -- exactly today's behaviour, unchanged.
      Nuitka standalone: the MAIN module's __file__ is emulated as <dist>/gateway.py, one
                       level shallower than the source layout, so two dirnames land OUTSIDE
                       the release dir and every config/web/data path is wrong there (proved
                       by unpacking a CI artifact: "missing config" two directories up, and
                       the HTTP layer answering 404 for all of web/). In a build the
                       directory of sys.executable IS that release dir.

    Nothing is guessed from a "frozen" flag: the answer is whichever candidate really
    CONTAINS one of _ROOT_MARKERS. exe_path is a parameter only so this is testable
    without launching a compiled build; every real caller leaves it empty and gets
    sys.executable. If no candidate qualifies, fall back to the source expression.
    """
    src = os.path.dirname(os.path.dirname(os.path.abspath(module_file))) if module_file else ""
    if _holds_project(src):
        return src
    exe = exe_path or sys.executable
    exe_dir = os.path.dirname(os.path.abspath(exe)) if exe else ""
    if _holds_project(exe_dir):
        return exe_dir
    return src or exe_dir or os.getcwd()


def find_web_dir(root: str) -> str:
    """The frontend directory inside `root`, tolerating both layouts.

    A source checkout keeps it at serve/web/ (the single source of truth). A release ships
    it under the data-dir target name web/ (what --include-data-dir=dist/web=web produces;
    index.html references web/app.js accordingly). Checking which one EXISTS -- again not
    guessing a flag -- is what lets one codebase serve both.
    """
    for cand in (os.path.join(root, "serve", "web"), os.path.join(root, "web")):
        if os.path.isfile(os.path.join(cand, "index.html")):
            return cand
    return os.path.join(root, "serve", "web")   # source-shaped default when neither exists


def _scalar(tok: str):
    """Convert a scalar token to a Python value (str/int/float/bool/None)."""
    t = tok.strip()
    if len(t) >= 2 and t[0] in "\"'" and t[-1] == t[0]:
        return t[1:-1]
    low = t.lower()
    if low in ("null", "~", ""):
        return None
    if low == "true":
        return True
    if low == "false":
        return False
    # flow collection on its own (already handled elsewhere, but keep JSON-safe)
    if t.startswith("[") or t.startswith("{"):
        try:
            return json.loads(t)
        except Exception:
            return t
    # numeric
    try:
        return int(t)
    except ValueError:
        pass
    try:
        return float(t)
    except ValueError:
        pass
    return t


def _strip_comment(line: str) -> str:
    # strip trailing comments that are not inside quotes
    out, in_q = [], None
    for ch in line:
        if in_q:
            out.append(ch)
            if ch == in_q:
                in_q = None
        elif ch in "\"'":
            in_q = ch
            out.append(ch)
        elif ch == "#":
            break
        else:
            out.append(ch)
    return "".join(out)


def _tokenize(text: str):
    """Return a list of (indent, content) for non-empty, non-comment lines."""
    toks = []
    for raw in text.splitlines():
        stripped = _strip_comment(raw.rstrip())
        if not stripped.strip():
            continue
        indent = len(stripped) - len(stripped.lstrip(" "))
        toks.append((indent, stripped.strip()))
    return toks


def _parse_block(toks, i, indent):
    """Parse a block starting at toks[i] whose entries sit at `indent`.

    Returns (value, next_index). Decides mapping-vs-sequence from the first line.
    """
    if i >= len(toks):
        return None, i
    # sequence?
    if toks[i][1].startswith("- "):
        return _parse_sequence(toks, i, indent)
    return _parse_mapping(toks, i, indent)


def _parse_mapping(toks, i, indent):
    result = {}
    while i < len(toks):
        ind, content = toks[i]
        # Was: `if ind < indent or not content.startswith((" ", "")) and ind != indent`.
        # `startswith("")` is always True, so that second clause could never fire and
        # the test reduced to `ind < indent` — dead logic that reads like it does
        # something. A block entry belongs to this mapping only at exactly `indent`.
        if ind != indent:
            break
        if content.startswith("- "):
            break  # sequence belongs to parent key, not here
        key, sep, val = content.partition(":")
        if not sep:
            break
        key = key.strip()
        val = val.strip()
        if val:
            result[key] = _scalar(val)
            i += 1
            continue
        # empty value -> nested block (map or seq) on following deeper-indented lines
        i += 1
        if i < len(toks) and toks[i][0] > indent:
            child_indent = toks[i][0]
            value, i = _parse_block(toks, i, child_indent)
            result[key] = value
        else:
            result[key] = None
    return result, i


def _parse_sequence(toks, i, indent):
    result = []
    while i < len(toks):
        ind, content = toks[i]
        if ind != indent or not content.startswith("- "):
            break
        item = content[2:].strip()
        fully_quoted = len(item) >= 2 and item[0] in "\"'" and item[-1] == item[0]
        if item and ":" in item and not fully_quoted:
            # an inline mapping that may itself have deeper children on following lines
            key, _, val = item.partition(":")
            entry = {key.strip(): _scalar(val.strip()) if val.strip() else None}
            i += 1
            # absorb any deeper-indented mapping keys belonging to this list item
            while i < len(toks) and toks[i][0] > indent:
                ci, cc = toks[i]
                k2, s2, v2 = cc.partition(":")
                if s2:
                    entry[k2.strip()] = _scalar(v2.strip()) if v2.strip() else None
                i += 1
            result.append(entry)
        else:
            result.append(_scalar(item))
            i += 1
    return result, i


def _minimal_yaml(text: str) -> dict:
    toks = _tokenize(text)
    if not toks:
        return {}
    value, _ = _parse_block(toks, 0, toks[0][0])
    return value if isinstance(value, dict) else {}


def load_config(path: str) -> dict:
    if not path or not os.path.isfile(path):
        return {}
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()
    # JSON native
    s = text.lstrip()
    if s.startswith("{"):
        return json.loads(text)
    # YAML via library
    try:
        import yaml  # type: ignore
        return yaml.safe_load(text) or {}
    except Exception:
        pass
    # fallback: built-in indent-based parser (handles nested maps/seqs/flow)
    return _minimal_yaml(text)
