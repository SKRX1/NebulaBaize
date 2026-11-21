#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_self_command_release_form.py - the @SELF / spawn-target differential (4a WinError 2)

Root cause, proved from the artifact's OWN diagnostics (run 44780930155, Windows):

    [gateway]  config-resolve diag: ROOT='...\\gateway.dist' exe='...\\gateway.dist\\python.exe'
    [executor] resolve diag: command='...\\gateway.dist\\python.exe' -> exe_exists=False
    [executor] server filesystem failed to start: [WinError 2] The system cannot find ...

The nine .pyd were all in the artifact and the shipped config verified GREEN in the
@SELF/@ROOT form - so neither the module list nor the token text was the problem. In a
Nuitka standalone build sys.executable is EMULATED as <dist>/python.exe, a path with no
file behind it; the program that really exists is gateway.exe. @SELF expanded to the
emulated name, so every one of the nine spawns pointed at a missing file.

What this test locks (every item is a call plus a branch that flips if the fix regresses):

  A1 the compiled shape from that log: root=<dist> holding gateway.exe, exe=<dist>/
     python.exe (NOT on disk) -> must resolve to <dist>/gateway.exe.
  A2 DIFFERENTIAL: the old one-liner ("@SELF = sys.executable") on the SAME input keeps
     the nonexistent emulated path -> proves the fallback is load-bearing.
  B1 source shape stays byte-for-byte: a real interpreter path (sys.executable, which
     does exist) is returned unchanged.
  B2 a renamed entry: only <dist>/mygate.exe exists and exe=<dist>/mygate is missing ->
     the same-stem branch must find mygate.exe (the gateway names alone would not).
  B3 nothing on disk at all -> return the emulated path verbatim so the executor's
     diagnostic names what is missing; never invent a path, never raise.
  C1 the wiring: _expand_release_tokens really CALLS self_command - with release_root
     pointed at a dist holding gateway.exe, an @SELF entry becomes that existing file.
  C2 the bare "python" alias resolves to something that exists on disk (same root cause;
     in a compiled build sys.executable alone would reproduce the WinError 2).

Pure stdlib, deterministic, no compiled build needed: the compiled shape is produced by
passing the same parameters the running build would compute.
"""
import os
import shutil
import sys
import tempfile

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(AGENT, "runtime"))
import registry  # noqa: E402

fails = []


def ck(name, ok, detail=""):
    print("%-5s %s %s" % ("PASS" if ok else "FAIL", name, detail))
    if not ok:
        fails.append(name)


def mk_dist(base, name, entry="gateway.exe"):
    """A release-shaped directory: holds a config marker (so release_root()/project_root()
    would accept it) plus the entry program, EXCEPT the emulated python.exe - which is
    exactly the artifact from the log."""
    d = os.path.join(base, name)
    os.makedirs(os.path.join(d, "config"), exist_ok=True)
    open(os.path.join(d, "config", "mcp_servers.json"), "w",
         encoding="utf-8").write('{"mcpServers":{}}')
    if entry:
        open(os.path.join(d, entry), "w", encoding="utf-8").write("binary stub")
    return d


def main() -> int:
    base = tempfile.mkdtemp(prefix="selfcmd_")
    try:
        # ---- A1 the compiled shape from the CI log ------------------------------
        dist = mk_dist(base, "gateway.dist")
        emu = os.path.join(dist, "python.exe")          # Nuitka's emulated name
        ck("A1 setup: the emulated python.exe really is absent, gateway.exe really is present",
           (not os.path.exists(emu)) and os.path.isfile(os.path.join(dist, "gateway.exe")),
           "emu_exists=%s" % os.path.exists(emu))
        got = registry.self_command(root=dist, exe=emu)
        want = os.path.join(dist, "gateway.exe")
        ck("A1 compiled form: emulated exe missing on disk -> resolves to the gateway.exe "
           "that IS there", os.path.normcase(got) == os.path.normcase(want),
           "got=%r want=%r" % (got, want))
        ck("A1b the resolved spawn target exists on disk (that is the whole contract)",
           os.path.isfile(got), "got=%r" % got)

        # ---- A2 DIFFERENTIAL: the old rule on the same input -------------------
        old_answer = emu                                 # what "@SELF = sys.executable" gave
        ck("A2 DIFFERENTIAL: the old one-liner keeps the nonexistent emulated path "
           "-> the fallback is load-bearing",
           old_answer != got and not os.path.isfile(old_answer),
           "old=%r exists=%s (must NOT equal the fixed answer)" % (old_answer, os.path.isfile(old_answer)))

        # ---- B1 source shape unchanged ----------------------------------------
        real = registry.self_command(root=dist, exe=sys.executable)
        ck("B1 source form: a real interpreter path is returned byte-for-byte unchanged",
           real == sys.executable, "got=%r want=%r" % (real, sys.executable))
        noarg = registry.self_command()                  # what callers actually run
        ck("B1b called with no args (the source case) -> the running interpreter itself",
           noarg == sys.executable and os.path.isfile(noarg), "got=%r" % noarg)

        # ---- B2 same-stem branch (a renamed entry must still be found) --------
        odd = mk_dist(base, "renamed.dist", entry="mygate.exe")
        got2 = registry.self_command(root=odd, exe=os.path.join(odd, "mygate"))
        ck("B2 a renamed entry: exe='<dist>/mygate' (missing) + only mygate.exe on disk -> "
           "the same-stem branch finds it",
           os.path.normcase(got2) == os.path.normcase(os.path.join(odd, "mygate.exe")),
           "got=%r" % got2)

        # ---- B3 nothing exists: honest fallback, never a guess ----------------
        empty = mk_dist(base, "noentry.dist", entry=None)
        emu3 = os.path.join(empty, "python.exe")
        got3 = registry.self_command(root=empty, exe=emu3)
        ck("B3 nothing on disk anywhere -> return the emulated path verbatim so the "
           "executor's diagnostic names the missing file (never invent one)",
           got3 == emu3, "got=%r want=%r" % (got3, emu3))

        # ---- C1 the wiring: token expansion really calls self_command ---------
        # release_root() derives from __file__, so a test points it at the dist the way a
        # compiled build would; _expand_release_tokens takes that root and must land on the
        # file that exists, not on the emulated name.
        # Two globals have to move together to reproduce a compiled build, and leaving out
        # either one describes a source run instead -- that is exactly how this item first
        # read RED: release_root() so @ROOT lands on the dist, AND sys.executable, which in
        # a Nuitka build IS the emulated <dist>/python.exe that has no file behind it. With
        # only the first patched, self_command() sees the real interpreter of this test
        # process, takes its "exists on disk" fast path, and never reaches the fallback the
        # fix is about.
        live = registry.release_root
        live_exe = sys.executable
        try:
            registry.release_root = lambda: dist
            sys.executable = emu                     # the emulated, non-existent name
            servers = {"filesystem": {"command": "@SELF",
                                      "args": ["--server", "fs_server"], "cwd": "@ROOT"}}
            registry._expand_release_tokens(servers)
            ent = servers["filesystem"]
            ck("C1 @SELF in a compiled-shaped config expands to the gateway.exe that "
               "exists (not the emulated python.exe)",
               os.path.normcase(ent["command"]) == os.path.normcase(want)
               and os.path.isfile(ent["command"]),
               "command=%r exists=%s (sys.executable was emulated to %r)"
               % (ent["command"], os.path.isfile(ent["command"]), emu))
            ck("C1b @ROOT still expands to the release root (unchanged half of the fix)",
               os.path.normcase(ent["cwd"]) == os.path.normcase(dist), "cwd=%r" % ent["cwd"])
        finally:
            registry.release_root = live
            sys.executable = live_exe

        # ---- C2 the bare "python" alias resolves to an existing program ------
        # Source shape on purpose (sys.executable restored above): the alias must keep
        # working for a source checkout; the compiled shape is self_command's own contract.
        merged = registry.resolve_servers({"mcpServers": {"shell": {"command": "python"}}})
        cmd = merged["shell"]["command"]
        ck("C2 the bare 'python' alias resolves to a program that exists on disk "
           "(sys.executable alone would reproduce the WinError 2 in a compiled build)",
           os.path.normcase(cmd) == os.path.normcase(sys.executable) and os.path.isfile(cmd),
           "command=%r" % cmd)

        # ---- D the contract is documented where the next reader will hit it ---
        src = open(os.path.join(AGENT, "runtime", "registry.py"), encoding="utf-8").read()
        ck("D self_command is defined, exported, and actually called from BOTH @SELF and "
           "the bare-python alias (no second sys.executable path left in the file's "
           "spawn-target logic)",
           "def self_command" in src and "me = self_command(root)" in src
           and 'entry["command"] = self_command()' in src,
           "saw definition+both call sites = %s" % (
               "def self_command" in src and "me = self_command(root)" in src))
    finally:
        shutil.rmtree(base, ignore_errors=True)

    print("\nSELF-COMMAND-RELEASE-FORM:", "ALL GREEN" if not fails else "RED: " + ", ".join(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
