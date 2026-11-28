#!/usr/bin/env python3
"""Apply the Strata host patch. On Strata 0.1.45+ the host already carries MCP image
content through to the vision model natively, so the only remaining job of this script is
the C1 auto-replay anchor in START-HERE.bat (re-runs this script after each upgrade). The
pre-0.1.45 multimodal patches (A1/A2/B1) were removed — see PATCHES.

Strata's own client (serve/mcp.py) flattens MCP image content blocks to text in
result_text() ("not shown to the model"), so parasite mode cannot feed a picture to
a vision model. Its frontend already reads image parts in tool messages, so the only
fix lives in the client: carry the image blocks through as structured template items.

This is a HOST patch to third-party files. Strata-main is NOT a git clone, so every
Strata upgrade rewrites serve/ and wipes the patch. Keep the authoritative copy of
this script in the workspace and re-run it after each upgrade (deploy_host_patch.bat).

The patch is anchored, not whole-file, so it re-applies ONLY our lines and never
overwrites unrelated upstream changes. Matching is per-line (row-ending agnostic).

    python tools/apply_host_patch.py            # apply (with backup)
    python tools/apply_host_patch.py --check     # report patch status, change nothing
    python tools/apply_host_patch.py --dry-run    # show what WOULD be done, write nothing
    python tools/apply_host_patch.py --quiet       # apply silently (called from START-HERE.bat)
    python tools/apply_host_patch.py --root "E:\\Program Files\\Strata-main"

Each patch is a (find-lines -> replace-lines) block. Every patched line carries MARK;
the first MARK-bearing replace line is that patch's idempotency marker. A find block
that matches 0 times (upstream moved it) or >1 time (ambiguous) is NOT applied; the
script says so and you fix the anchor by hand. Exit code 0 = everything applied.

ENCODING (read and write MUST be symmetric): a .bat whose text (or the path baked into
it) is non-ASCII is written as GBK (cp936) so cmd.exe's default code page reads it back
correctly; everything else is UTF-8. Reading mirrors this exactly (read as bytes, try
UTF-8, fall back to GBK) so a file written GBK is read back intact and idempotency keeps
working. This prevents the Chinese-path mojibake that made a START-HERE.bat call line
silently point at a non-existent file.

BOOTSTRAP NOTE: After the FIRST upgrade, START-HERE.bat itself is rewritten and the
auto-replay call is gone. Run deploy_host_patch.bat once by hand after that first
upgrade. From then on, the START-HERE.bat anchor keeps the chain alive permanently.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import time
from pathlib import Path

DEFAULT_ROOT = Path(r"E:\Program Files\Strata-main")

# A sentinel embedded in every patched line; the idempotency + self-check marker.
MARK = "STRATA-MULTIMODAL-PATCH"

# ---- patch table: each entry = (file, [find lines], [replace lines]) --------------
# Lines are written WITHOUT trailing newline; matching uses the stripped line so CRLF
# vs LF never breaks an anchor. Indentation must match the source exactly.

MCP = "serve/mcp.py"
SERVER = "serve/server.py"
BAT = "START-HERE.bat"

# Self-referencing absolute path (used in the START-HERE.bat anchor).
SELF_PATH = Path(__file__).resolve()

PATCHES: list[tuple[str, list[str], list[str]]] = [
    # (A1/A2/B1) REMOVED for Strata 0.1.45+ — upstream now carries MCP image content
    # through to the vision model natively. On 0.1.45, mcp.call() returns the raw result
    # dict whose "content" array already includes image blocks, and server.py no longer
    # flattens results to text (our B1 anchor `results.append(r["text"])` is gone). These
    # parasite-mode patches targeted the pre-0.1.45 client; here they would be dead code
    # (A1/A2) or fail to anchor (B1). C1 (auto-replay) stays so future upgrades still run
    # this script. To restore on a pre-0.1.45 Strata, recover these blocks from
    # tools/_backup or project git history.

    # (C1) START-HERE.bat: auto-replay patch after every setup/upgrade.
    # The ::LABEL line is both the bat comment AND the idempotency marker.
    # It runs silently (>nul 2>nul) so normal starts are not spammed.
    (BAT,
     ['if errorlevel 1 pause', 'exit /b'],
     ['if errorlevel 1 pause',
      f'::{MARK}',
      f'".venv\\Scripts\\python.exe" "{SELF_PATH}" --quiet >nul 2>nul',
      'exit /b']),
]


def _marker_for(replace: list[str]) -> str:
    """The idempotency marker: the first MARK-bearing line, else the first line."""
    for line in replace:
        if MARK in line:
            return line.strip()
    return replace[0].strip()


def _load(path: Path) -> list[str]:
    """Read a file as lines. Mirror _write_file: try UTF-8, fall back to GBK, so a file
    written GBK (a .bat with a non-ASCII path) decodes back intact and idempotency holds."""
    data = path.read_bytes()
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        text = data.decode("gbk")
    return text.splitlines()


def _needs_gbk(path: Path, text: str) -> bool:
    return path.suffix.lower() == ".bat" and any(ord(c) > 127 for c in text)


def _write_file(path: Path, lines: list[str]) -> str:
    """Write the file; use GBK for a .bat that needs it (so cmd reads it back right),
    UTF-8 otherwise. Returns the encoding used. Must stay symmetric with _load."""
    text = "\n".join(lines) + "\n"
    enc = "gbk" if _needs_gbk(path, text) else "utf-8"
    path.write_bytes(text.encode(enc))
    return enc


def _find_block(lines: list[str], block: list[str]) -> list[int]:
    b = [x.strip() for x in block]
    return [i for i in range(len(lines) - len(block) + 1)
            if [lines[i + j].strip() for j in range(len(block))] == b]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    ap.add_argument("--check", action="store_true", help="report patch status, change nothing")
    ap.add_argument("--dry-run", action="store_true", dest="dry_run",
                    help="show what would be applied, write nothing")
    ap.add_argument("--quiet", action="store_true", help="suppress routine output (for START-HERE.bat)")
    args = ap.parse_args()

    def out(msg: str = "") -> None:
        if not args.quiet or args.check or args.dry_run:
            print(msg)

    root = args.root
    if not root.exists():
        out(f"[root missing] {root}")
        return 2

    by_file: dict[str, list[tuple[list[str], list[str]]]] = {}
    for fname, find, repl in PATCHES:
        by_file.setdefault(fname, []).append((find, repl))

    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = Path(__file__).resolve().parent / "_backup" / stamp
    pending = 0          # patches still to apply
    any_change = False
    anchor_broke = False  # an anchor could not be matched
    if args.dry_run:
        print("=== DRY-RUN: would apply the patches below, writing nothing ===")

    for fname, plist in by_file.items():
        path = root / fname.replace("/", "\\")
        if not path.exists():
            out(f"[MISSING FILE] {fname}")
            anchor_broke = True
            continue
        new_lines = _load(path)
        file_changes = 0
        for find, repl in plist:
            marker = _marker_for(repl)
            label = find[0].strip()[:48]
            if any(l.strip() == marker for l in new_lines):
                out(f"  [applied] {fname}  ({label}...)")
                continue
            hits = _find_block(new_lines, find)
            if len(hits) != 1:
                why = "ANCHOR MISSING (upstream moved it)" if not hits else "ANCHOR AMBIGUOUS"
                out(f"  [{why}] {fname}  anchor={label!r}")
                anchor_broke = True
                continue
            i = hits[0]
            if args.check:
                out(f"  [pending] {fname}  ({label}...)")
                pending += 1
            elif args.dry_run:
                enc = "gbk" if _needs_gbk(path, "\n".join(repl)) else "utf-8"
                out(f"  [would apply] {fname} @ line {i + 1}  (write as {enc})")
                for r in repl:
                    out(f"        + {r.strip()}")
                pending += 1
            else:
                new_lines[i:i + len(find)] = repl
                file_changes += 1
        if file_changes and not (args.check or args.dry_run):
            backup.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, backup / Path(fname).name)
            enc = _write_file(path, new_lines)
            print(f"  [PATCHED] {fname}  ({file_changes} hunk(s), wrote {enc}) -> backup {backup}")
            any_change = True

    if anchor_broke:
        status, code = "INCOMPLETE (an anchor needs attention above)", 1
    elif pending:
        verb = "would apply" if args.dry_run else "PENDING (run without --check/--dry-run to apply)"
        status, code = f"{pending} patch(es) {verb}", 1
    else:
        status, code = "ALL APPLIED", 0
    if not args.quiet:
        print(f"Host patch status: {status}")
    if not args.check and not args.dry_run and any_change:
        print("Done. Verify syntax: py_compile the changed files.")
    return code


if __name__ == "__main__":
    sys.exit(main())
