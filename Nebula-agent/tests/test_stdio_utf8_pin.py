#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_stdio_utf8_pin.py - the gateway's OWN stdout/stderr codec pin (closed-source CI).

Root cause, proved from the artifact's OWN traceback (CI run 44829615496, windows):

    File ".../http_server.py", line 4594, in run_server
    File "encodings/cp1252.py", line 19, in encode
    UnicodeEncodeError: 'charmap' codec can't encode character '\u2192' ...

Six earlier runs died at the 4a smoke with [WinError 2]; cea0d65 fixed @SELF, the smoke
then got FURTHER -- nine .pyd present, config verified, CLI parses -- and reached the point
where the gateway logs its own startup lines. executor.py already pins the MCP wire
(encoding=WIRE_ENCODING), which is why nine Chinese-speaking servers never tripped this.
The gateway process's own sys.stdout/sys.stderr were the one stream nobody pinned: when the
CI harness redirects them into a log file there is no console, and CPython picks the
machine's ANSI codec (cp1252). One arrow in a diagnostic line killed the process before it
ever listened. "A log pipe must never be able to kill the service."

The fixture clears PYTHONIOENCODING on purpose (see _clean_env): the CI runner's env has no
such variable (confirmed from the step-13 env dump of run 44829615496), and pin_stdio_utf8()
honours an explicit one -- so a test that inherits it (this workspace's own shell sets
utf-8) would exercise the honour-the-knob branch and never reach the reconfigure. T4 locks
that branch from the other side.

What this test locks (every item is a call plus a branch that flips if the fix regresses):

  T1 THE FIX: stdout/stderr bound to a byte pipe whose text layer says encoding 'ascii'
     (a stricter stand-in for cp1252 -- both refuse U+2192), pin_stdio_utf8() re-pins both
     to UTF-8, and a line containing U+2192 lands on disk as real UTF-8 bytes.
  T2 DIFFERENTIAL (load-bearing): the SAME pipe WITHOUT the call keeps raising
     UnicodeEncodeError on that text -> the pin is what makes T1 pass, not the codec.
  T3 errors="replace" is real: text carrying a lone surrogate (a STRICT utf-8 writer
     rejects it) writes without raising; the byte becomes U+FFFD.
  T4 the knob branch: with PYTHONIOENCODING set, pin returns None and leaves the codec
     alone. T4b DIFFERENTIAL: clearing it on the same pipe makes pin reconfigure -> shows
     the early return is load-bearing, not an always-None stub.
  T5 a stream with no reconfigure() (io.StringIO) is reported through the return value,
     never raised, never silently swallowed.
  T6 the WIRING: main() calls pin_stdio_utf8() BEFORE it touches argparse, so --help and
     every startup diagnostic travel through the pinned stream.

Pure stdlib, deterministic, no compiled build needed: the CI's redirected pipe is
reproduced by binding sys.stdout/sys.stderr to a file-backed TextIOWrapper.
"""
import ast
import io
import os
import sys
import tempfile

AGENT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(AGENT, "runtime"))
import gateway  # noqa: E402

# U+2192 "rightwards arrow" -- the exact character from the CI traceback. Written by its
# ASCII escape so this file stays pure ASCII (console code pages eat CJK; canary rule).
ARROW = "\u2192"

Fails = []


def ck(name, cond):
    # sys.__stdout__, not print(): the fixture rebinds sys.stdout to the pipe under test,
    # and a report line must not be captured by the very stream it is measuring.
    sys.__stdout__.write(("PASS " if cond else "FAIL ") + name + "\n")
    sys.__stdout__.flush()
    if not cond:
        Fails.append(name)


class _clean_env:
    """Pop PYTHONIOENCODING for the block (CI's shape), restore it after."""

    def __enter__(self):
        self.saved = os.environ.pop("PYTHONIOENCODING", None)
        return self

    def __exit__(self, *exc):
        if self.saved is not None:
            os.environ["PYTHONIOENCODING"] = self.saved
        return False


class Pipe:
    """A real byte pipe with a narrow-codec text layer on top -- the CI log file."""

    def __init__(self, path, encoding="ascii"):
        self.path = path
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC)
        self.raw = os.fdopen(self.fd, "wb", buffering=0)
        self.wrapper = io.TextIOWrapper(self.raw, encoding=encoding, errors="strict")

    def bind(self):
        self.saved = (sys.stdout, sys.stderr)
        sys.stdout = sys.stderr = self.wrapper

    def unbind(self):
        try:
            self.wrapper.flush()
        except Exception:
            pass
        sys.stdout, sys.stderr = self.saved

    def bytes_on_disk(self):
        self.wrapper.flush()
        return open(self.path, "rb").read()


def _pipe_pair(tag):
    d = tempfile.mkdtemp(prefix="stdio_pin_" + tag + "_")
    return Pipe(os.path.join(d, "out.log")), Pipe(os.path.join(d, "err.log"))


def _strict_writer_raises(text):
    """True when a strict utf-8 writer rejects `text` -- the control for T3a."""
    buf = io.BytesIO()
    w = io.TextIOWrapper(buf, encoding="utf-8", errors="strict")
    try:
        w.write(text)
        w.flush()
        return False
    except UnicodeEncodeError:
        return True


def run_T1_T2_T3():
    with _clean_env():
        # ---- T2 (the control, run FIRST): without the pin the pipe keeps raising.
        out, _e = _pipe_pair("ctrl")
        out.bind()
        raised = None
        try:
            print("diag: ROOT='D:\\dist' -> will-load-config " + ARROW)
        except UnicodeEncodeError as exc:
            raised = exc
        out.unbind()
        ck("T2 differential: an unpinned narrow pipe raises on U+2192 (CI bug reproduced)",
           isinstance(raised, UnicodeEncodeError))

        # ---- T1 (the fix) on a FRESH pair: T2's wrapper is now poisoned by its failure.
        out2, _e2 = _pipe_pair("fix")
        out2.bind()
        try:
            note = gateway.pin_stdio_utf8()
            ck("T1a pin reports no degradation on real streams", note is None)
            ck("T1b sys.stdout really became utf-8 (the reconfigure landed)",
               getattr(sys.stdout, "encoding", "").lower().replace("-", "") == "utf8")
            ck("T1c sys.stderr pinned too (the CI traceback came from stderr)",
               getattr(sys.stderr, "encoding", "").lower().replace("-", "") == "utf8")
            print("diag: ROOT='D:\\dist' -> will-load-config " + ARROW + " ok")
            data = out2.bytes_on_disk()
            ck("T1d writing U+2192 no longer raises (it reached the log)",
               ARROW.encode("utf-8") in data)
            ck("T1e the bytes on disk are UTF-8 (e2 86 92), not a codec accident",
               data.count(b"\xe2\x86\x92") == 1)

            # ---- T3: a lone surrogate is what errors="replace" is for. A STRICT writer
            # raises on it (the failure mode this pin exists to prevent); the pinned
            # stream must not. Note the ENCODE-side table: utf-8/replace maps a surrogate
            # to an ASCII b'?', NOT to U+FFFD (that is the decode side).
            raised3 = None
            try:
                print("tail:\ud800" + ARROW)
            except UnicodeEncodeError as exc:
                raised3 = exc
            data = out2.bytes_on_disk()
            ck("T3a errors='replace' swallows a lone surrogate without raising",
               raised3 is None)
            ck("T3b strict utf-8 on the same text DOES raise (proves T3a is replace's work)",
               _strict_writer_raises("tail:\ud800" + ARROW))
            ck("T3c both U+2192 of the two writes landed intact",
               data.count(b"\xe2\x86\x92") == 2)
            ck("T3d the surrogate became an encode-side b'?', not a crash",
               b"tail:?" in data)
        finally:
            out2.unbind()


def run_T4():
    out, _e = _pipe_pair("knob")
    out.bind()
    try:
        saved = os.environ.get("PYTHONIOENCODING")
        os.environ["PYTHONIOENCODING"] = "ascii"
        try:
            note = gateway.pin_stdio_utf8()
            ck("T4a explicit PYTHONIOENCODING -> pin honours it (returns None, no reconfigure)",
               note is None and sys.stdout.encoding == "ascii")
        finally:
            # ---- T4b DIFFERENTIAL: same pipe, knob removed -> pin now acts.
            os.environ.pop("PYTHONIOENCODING", None)
            if saved is not None:
                # keep the outer value restorable after the block
                pass
            note2 = gateway.pin_stdio_utf8()
            ck("T4b differential: clearing the knob makes the pin reconfigure (the branch is real)",
               getattr(sys.stdout, "encoding", "").lower().replace("-", "") == "utf8")
            if saved is not None:
                os.environ["PYTHONIOENCODING"] = saved
            else:
                os.environ.pop("PYTHONIOENCODING", None)
    finally:
        out.unbind()


def run_T5():
    with _clean_env():
        saved = (sys.stdout, sys.stderr)
        sys.stdout = sys.stderr = io.StringIO()      # no .reconfigure() exists on it
        try:
            note = gateway.pin_stdio_utf8()
            ck("T5 an unconfigurable stream is REPORTED (not raised, not swallowed)",
               isinstance(note, str) and "stdout" in note and "stderr" in note)
        finally:
            sys.stdout, sys.stderr = saved


def run_T6():
    """The wiring, from the AST: main() calls pin_stdio_utf8() before argparse."""
    src = open(os.path.join(AGENT, "runtime", "gateway.py"), encoding="utf-8").read()
    tree = ast.parse(src)
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "main")
    pins, args = [], []
    for node in ast.walk(main):
        if not isinstance(node, ast.Call):
            continue
        f = node.func
        if isinstance(f, ast.Name) and f.id == "pin_stdio_utf8":
            pins.append(node.lineno)
        if isinstance(f, ast.Attribute) and f.attr == "ArgumentParser":
            args.append(node.lineno)
    ck("T6 main() calls pin_stdio_utf8() before argparse (%s < %s)" % (pins, args),
       bool(pins) and bool(args) and min(pins) < min(args))


def main():
    run_T1_T2_T3()
    run_T4()
    run_T5()
    run_T6()
    print("STDIO-UTF8-PIN: " + ("ALL GREEN" if not Fails else "RED -> " + ", ".join(Fails)))
    return 0 if not Fails else 1


if __name__ == "__main__":
    sys.exit(main())
