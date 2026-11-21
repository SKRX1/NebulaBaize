"""Static guard: no module may reference an undefined global name.

Why this exists
---------------
`servers/browser_server.py` used `time.monotonic()` inside `_run_capture` with **no
`import time`**. Every call therefore raised `NameError`, the exception was swallowed by a
broad `except`, the capability probe failed for every candidate browser, and the tool
reported the highly misleading

    error: no usable browser found (set BROWSER_BINARY_PATH to a Chromium/Edge binary)

which sent the model (and the user) hunting for "install a browser" instead of the missing
import. `py_compile` cannot catch this: it is valid syntax. Only *running* the code on the
failure path would — and that path is exactly the one the skip-on-no-browser test hid.

So this suite does a cheap AST pass over every Python module in `servers/` and `runtime/`
and fails on any `Name` load that is not: defined anywhere in the module, a module-level
binding, a builtin, or a dunder. Zero dependencies, runs in milliseconds, catches the whole
class of "forgot to import" bugs.

Run standalone: python tests/test_undefined_names.py
"""
from __future__ import annotations

import ast
import builtins
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_DIRS = ["servers", "runtime"]
EXTRA_OK = {
    "__file__", "__name__", "__doc__", "__package__", "__spec__", "__loader__",
    "__builtins__", "__class__", "__debug__", "__all__", "__path__", "__annotations__",
}
BUILTINS = set(dir(builtins)) | EXTRA_OK


def _args_names(args: ast.arguments) -> set[str]:
    out = set()
    for group in (args.posonlyargs, args.args, args.kwonlyargs):
        out |= {a.arg for a in group}
    if args.vararg:
        out.add(args.vararg.arg)
    if args.kwarg:
        out.add(args.kwarg.arg)
    return out


def defined_names(tree: ast.AST) -> tuple[set[str], bool]:
    """Every name bound ANYWHERE in the module (any scope) + whether it star-imports.

    Deliberately over-approximate on scope: we only want to catch names that are bound
    *nowhere*, which is unambiguously a bug. Scope-precise analysis would produce false
    positives (e.g. a name bound conditionally) for no benefit here.
    """
    names: set[str] = set()
    star_import = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, (ast.Store, ast.Del)):
                names.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            names.add(node.name)
            names |= _args_names(node.args)
        elif isinstance(node, ast.Lambda):
            names |= _args_names(node.args)
        elif isinstance(node, ast.ClassDef):
            names.add(node.name)
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            names |= set(node.names)
        elif isinstance(node, ast.Import):
            for a in node.names:
                names.add(a.asname or a.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.name == "*":
                    star_import = True
                else:
                    names.add(a.asname or a.name)
        elif isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return names, star_import


def undefined_names(path: str) -> list[tuple[int, str]]:
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()
    tree = ast.parse(src, filename=path)
    names, star_import = defined_names(tree)
    if star_import:
        return []  # can't reason statically; never a false red
    bad: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            if node.id not in names and node.id not in BUILTINS:
                bad.append((node.lineno, node.id))
    return sorted(set(bad))


def main() -> int:
    checked = 0
    failures = 0
    for d in SCAN_DIRS:
        root = os.path.join(HERE, d)
        if not os.path.isdir(root):
            continue
        for fn in sorted(os.listdir(root)):
            if not fn.endswith(".py"):
                continue
            path = os.path.join(root, fn)
            checked += 1
            bad = undefined_names(path)
            if bad:
                failures += 1
                print(f"UNDEFINED NAMES in {d}/{fn}:")
                for lineno, name in bad:
                    print(f"  line {lineno}: {name!r} is never imported/assigned")
    assert checked > 0, "no modules were scanned (wrong working directory?)"
    assert failures == 0, f"{failures} module(s) reference undefined names"
    print(f"UNDEFINED-NAMES OK: {checked} modules, no undefined globals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
