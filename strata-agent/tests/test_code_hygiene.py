"""Static hygiene guard: ratcheted high-frequency real-bug patterns.

Sister guard to test_undefined_names.py — both are the GREEN GATE the agent runs when it
claims "done" (see config/mcp_servers.json -> verify.command). This one adds the bug
classes that a multi-round fix loop needs something to actually guard:

  1. TODO residue  — a hard line. No allowance. Any new TODO/FIXME/XXX/HACK in real code
     (outside the file's own module docstring) is RED. This is the "left unimplemented"
     pain point; today the tree is clean (count 0) so it guards without nagging.
  2. Stub functions — def/async def whose entire body is just pass/.../docstring: an
     "I have not filled this in yet" function.
  3. Silent except swallow — an except handler whose body is only pass/continue (the
     error is eaten with no handling/log).

2 and 3 use a RATCHET BASELINE (tests/_hygiene_baseline.json): the current known-good
counts per file are recorded once, so the guard is GREEN today and only goes RED when a
file ADDS new hits beyond its baseline. Ratchet by per-file COUNT (not line number) so
drifting line numbers never cause a false red. Regenerate with --bless after you
intentionally accept new hits.

Run standalone:  python tests/test_code_hygiene.py        (check; exit 0 => green)
                 python tests/test_code_hygiene.py --bless  (write baseline = current state)
"""
from __future__ import annotations

import ast
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # package root
SCAN_DIRS = ["servers", "runtime"]
BASELINE = os.path.join(HERE, "tests", "_hygiene_baseline.json")
MARKERS = ("TODO", "FIXME", "XXX", "HACK")


def _is_stub_body(body) -> bool:
    """A body that is exactly one pass / Ellipsis / bare-docstring => an unfilled stub."""
    if len(body) != 1:
        return False
    n = body[0]
    if isinstance(n, ast.Pass):
        return True
    if isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant):
        return n.value.value is Ellipsis or isinstance(n.value.value, str)
    return False


def _swallows(handler: ast.ExceptHandler) -> bool:
    """Body is only pass/continue (or a lone docstring/comment) => silently eats the error."""
    stmts = [s for s in handler.body
             if not (isinstance(s, ast.Expr) and isinstance(s.value, ast.Constant))]
    if not stmts:
        return True
    return all(isinstance(s, (ast.Pass, ast.Continue)) for s in stmts)


def scan() -> dict:
    """Return {stub:{file:count}, swallow:{file:count}, todo_total:int, todo:[...]}.
    Per-file counts so a drifting line number can't change the ratchet verdict."""
    stub: dict[str, int] = {}
    swallow: dict[str, int] = {}
    todo_total = 0
    todo: list[str] = []
    for d in SCAN_DIRS:
        root = os.path.join(HERE, d)
        if not os.path.isdir(root):
            continue
        for fn in sorted(os.listdir(root)):
            if not fn.endswith(".py") or fn.endswith(".bak"):
                continue
            path = os.path.join(root, fn)
            with open(path, "r", encoding="utf-8") as f:
                src = f.read()
            try:
                tree = ast.parse(src, filename=path)
            except SyntaxError:
                continue  # a parse error is not this guard's job (py_compile owns that)
            rel = f"{d}/{fn}"
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and _is_stub_body(node.body):
                    stub[rel] = stub.get(rel, 0) + 1
                if isinstance(node, ast.ExceptHandler) and _swallows(node):
                    swallow[rel] = swallow.get(rel, 0) + 1
            docend = 0
            if (tree.body and isinstance(tree.body[0], ast.Expr)
                    and isinstance(getattr(tree.body[0], "value", None), ast.Constant)
                    and isinstance(tree.body[0].value.value, str)):
                docend = tree.body[0].end_lineno or 1  # skip the file's own docstring
            for i, line in enumerate(src.splitlines(), 1):
                if i <= docend:
                    continue
                for m in MARKERS:
                    if m in line:
                        todo_total += 1
                        todo.append(f"{rel}:{i} {m}")
                        break
    return {"stub": stub, "swallow": swallow, "todo_total": todo_total, "todo": todo}


def main() -> int:
    bless = "--bless" in sys.argv
    cur = scan()

    if bless:
        with open(BASELINE, "w", encoding="utf-8") as f:
            json.dump({"stub": cur["stub"], "swallow": cur["swallow"],
                       "todo_total": cur["todo_total"]}, f, indent=2, sort_keys=True)
        print(f"BLESSED baseline: stub_files={len(cur['stub'])} "
              f"swallow_files={len(cur['swallow'])} todo_total={cur['todo_total']}")
        return 0

    if not os.path.exists(BASELINE):
        print("NO BASELINE YET — run `python tests/test_code_hygiene.py --bless` first")
        return 1

    with open(BASELINE, "r", encoding="utf-8") as f:
        base = json.load(f)

    regressions: list[str] = []

    # 1. TODO residue: hard line — any occurrence is red (baseline records the floor, today 0)
    if cur["todo_total"] > base.get("todo_total", 0):
        for t in cur["todo"]:
            regressions.append(f"TODO residue: {t}")

    # 2/3. ratchet by per-file count: only NEW hits beyond the file's baseline are red
    for label, key in (("stub function", "stub"), ("silent except swallow", "swallow")):
        for rel, cnt in sorted(cur[key].items()):
            if cnt > base.get(key, {}).get(rel, 0):
                extra = cnt - base.get(key, {}).get(rel, 0)
                regressions.append(f"NEW {label} in {rel}: {cnt} (baseline "
                                   f"{base.get(key, {}).get(rel, 0)})")

    assert regressions == [], "hygiene regression:\n  " + "\n  ".join(regressions)
    print(f"CODE-HYGIENE OK: stub_files={len(cur['stub'])} "
          f"swallow_files={len(cur['swallow'])} todo_total={cur['todo_total']} "
          f"(all within ratchet baseline)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
