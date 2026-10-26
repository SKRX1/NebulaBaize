"""Shell MCP server: run commands, with a deny list (pure std lib)."""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase, smart_decode

DENY = ["rm -rf", "del /s /q", "rmdir /s", "shutil.rmtree", ":(){ :|:& };:"]

# Real absolute path (drive letter / UNC / POSIX root) -- a bare leaf name is not one.
_ABS_RE = re.compile(r"^(?:[a-zA-Z]:[\\/]|[\\/]{2}|/)")

# Default cap for a single command. 30s is the fast-fail default: ordinary commands
# finish in <5s and a hung one must not stall the whole agent. Long-but-legitimate tasks
# (model calls, builds, installs) can raise it per call through the `timeout` argument,
# up to _MAX_TIMEOUT. Keep _MAX_TIMEOUT below the executor's mcp.timeout_s in
# config/mcp_servers.json, otherwise the transport gives up before this server answers.
_TIMEOUT = 30
_MAX_TIMEOUT = 300
# Raised 800KB -> 2MB (2026-10-26): daily outputs almost never reach 2MB, so truncation
# -- and with it the multi-byte-boundary mojibake -- basically never fires now. The
# _trim_incomplete_utf8_tail guard below covers the rare case it does.
_MAX_OUTPUT_BYTES = 2_000_000


def _trim_incomplete_utf8_tail(data: bytes) -> bytes:
    """Drop a trailing INCOMPLETE UTF-8 multi-byte sequence so the decoder always sees
    whole characters.

    This runs ONLY on a truncated capture (see the truncation path in call_tool). A
    truncation can land mid-character; if the surviving bytes happen to also be valid
    GBK, smart_decode's GBK fallback would win and return a whole-segment mojibake
    (the 2026-10-26 finding: "星云智能体" truncated by 1 byte -> "鏄熶簯鏅鸿兘浣"). Trimming
    the dangling lead+continutions back to the last whole character keeps smart_decode
    on its UTF-8-first path. Complete sequences -- and whole non-UTF8 (GBK) captures --
    are returned untouched.

    Expected length by UTF-8 lead byte:
        0xC0-0xDF -> 2, 0xE0-0xEF -> 3, 0xF0-0xF7 -> 4 (RFC 3629).
    """
    if not data:
        return data
    n = len(data)
    i = n - 1
    while i >= 0 and (data[i] & 0xC0) == 0x80:   # walk back over continuation bytes
        i -= 1
    if i < 0:
        return data                              # all continuation -- pass through
    lead = data[i]
    if lead < 0x80:
        return data                              # plain ASCII -- always complete
    expected = (2 if lead < 0xE0 else            # 110xxxxx -> 2-byte
                3 if lead < 0xF0 else            # 1110xxxx -> 3-byte
                4)                               # 11110xxx -> 4-byte
    if (n - i) >= expected:
        return data                              # last char is whole -- nothing to trim
    return data[:i]                              # trim the incomplete trailing char


def _denied(cmd: str) -> bool:
    low = cmd.lower()
    return any(d in low for d in DENY)


def _unbalanced_quotes(cmd: str) -> bool:
    """True when double quotes are an odd count -> the shell would enter a continuation
    / hang waiting for the close quote. The classic trigger is a trailing backslash
    just before a closing quote (\") which escapes it. We run such commands anyway
    (the new stdin=DEVNULL makes them self-resolve), but flag them for the model."""
    return cmd.count('"') % 2 == 1


def _looks_background(cmd: str) -> bool:
    """True when the command launches a detached child (`start /b` / `start ""`).

    Such a child outlives this call, so its output can never come back through the
    capture. The result must point the caller at the log file instead of letting the
    model wait on it (the old `start /b ... & ping ... & type log` loop).
    """
    low = cmd.lower()
    if "start " not in low:
        return False
    return "/b" in low or 'start ""' in low


def _timeout_note(cmd: str, tmo: int) -> str:
    note = f"error: command timed out after {tmo}s and was killed."
    if _looks_background(cmd):
        note += (" Background child detected (`start /b`): it keeps running after this "
                 "call returns and its output is not captured here. Do NOT wait on it "
                 "with `ping`/sleep loops -- redirect it to a log file and read that "
                 "file in a separate call, or run the work in the foreground.")
    else:
        nxt = min(max(tmo * 4, 60), _MAX_TIMEOUT)
        note += (f" If the task legitimately needs longer, re-run ONCE with timeout={nxt}. "
                 "Do not retry the same command repeatedly.")
    if _unbalanced_quotes(cmd):
        note += (" (unbalanced double quotes: a trailing backslash before a \" escapes it "
                 "-- drop the trailing backslash on the path)")
    return note


def _kill_tree(pid: int) -> None:
    """Kill a process and its whole tree (Windows). Popen.kill() only kills the direct
    child, so a `start /b` grandchild (e.g. a long-running model-call script) would keep
    running forever after we report the shell command as "timed out" -- a silent leak
    that also holds file/port handles. taskkill /T reaps the entire subtree."""
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


def _workspace_cwd() -> str | None:
    """Run commands inside the user's CURRENT workspace.

    The host moves the active workspace to the end of the record file on every request, so
    the LAST absolute entry is the one the user is in now. The web UI's folder picker can
    only reveal a leaf name, so only *absolute* entries count. Without a workspace we return
    None and the command inherits the server's own cwd, exactly as before.

    This used to require *exactly one* recorded root, which never held after the user had
    opened a second workspace (the file is an append-only union that is never pruned) --
    so every `shell_exec` ran in the agent's install dir while the model believed it was in
    the project folder (2026-10-20: `CWD=E:\\WorkBuddy\\星云智能体\\strata-agent`).
    """
    af = os.environ.get("FS_ALLOW_FILE")
    if not af:
        return None
    roots = []
    try:
        with open(af, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and _ABS_RE.match(line):
                    roots.append(line)
    except OSError:
        return None
    for r in reversed(roots):                      # newest first
        if os.path.isdir(r):
            return r
    return None


def _child_env() -> dict:
    """The env for the command we run: force UTF-8 output from anything Python-based.

    Without this a nested `python -c "print('中文')"` writes GBK into the pipe, and a
    cmd.exe built-in writes the OEM codec; `smart_decode` copes with both, but pinning
    UTF-8 makes the whole chain agree on one encoding instead of guessing per command.
    """
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


class ShellServer(McpServerBase):
    name = "shell"
    tools = [
        {"name": "exec",
         "description": (
             "Run a shell command and return stdout/stderr. The command is killed after "
             f"`timeout` seconds (default {_TIMEOUT}, max {_MAX_TIMEOUT}); for a long task "
             "(model call, build, install) pass a larger timeout instead of backgrounding "
             "with `start /b` plus a `ping`/sleep wait, which never returns usable output."),
         "inputSchema": {"type": "object",
                         "properties": {
                             "command": {"type": "string"},
                             "timeout": {"type": "integer",
                                         "description": f"seconds, 1-{_MAX_TIMEOUT}, "
                                                        f"default {_TIMEOUT}"},
                         },
                         "required": ["command"]}},
    ]

    def call_tool(self, name, args):
        if name != "exec":
            raise Exception(f"unknown tool: {name}")
        cmd = args.get("command", "")
        if _denied(cmd):
            return f"error: command blocked by sandbox deny list: {cmd}"

        # Per-call timeout: default _TIMEOUT, clamped to [1, _MAX_TIMEOUT]. Without this
        # the model had no way to run a legitimately slow task and fell back to
        # `start /b` + `ping` sleep loops, which burned the whole budget and then looped.
        try:
            tmo = int(args.get("timeout", _TIMEOUT))
        except (TypeError, ValueError):
            tmo = _TIMEOUT
        tmo = max(1, min(tmo, _MAX_TIMEOUT))

        # Capture into temp FILES, not pipes. With a pipe, a background child started by
        # `start /b` inherits the write handle and keeps it open after the foreground
        # command returns -- `subprocess.run` then waits for an EOF that never comes, so
        # every "start /b ... & ping ... & type log" command burned its full timeout even
        # when the log was already written. A file handle has no EOF to wait on: wait()
        # returns as soon as the direct child exits.
        t0 = time.monotonic()
        try:
            with tempfile.TemporaryFile() as fo, tempfile.TemporaryFile() as fe:
                proc = subprocess.Popen(cmd, stdout=fo, stderr=fe, shell=True,
                                        env=_child_env(), cwd=_workspace_cwd(),
                                        stdin=subprocess.DEVNULL)
                # Stream stdout incrementally so a slow command shows live output in the
                # chat instead of blocking until it finishes. A background pump reads the
                # capture file and emits MCP progress notifications; the gateway forwards
                # them as SSE. The final authoritative result is still read whole below.
                stop = threading.Event()
                emitted = [False]
                pos = [0]

                def pump():
                    while not stop.is_set():
                        try:
                            fo.seek(pos[0])
                            chunk = fo.read()
                        except Exception:
                            chunk = b""
                        if chunk:
                            pos[0] += len(chunk)
                            emitted[0] = True
                            self.emit_progress(smart_decode(chunk))
                        if proc.poll() is not None:
                            if not emitted[0]:   # fast command: final result covers it
                                break
                            try:
                                fo.seek(pos[0])
                                rest = fo.read()
                            except Exception:
                                rest = b""
                            if rest:
                                pos[0] += len(rest)
                                self.emit_progress(smart_decode(rest))
                            break
                        time.sleep(0.3)

                thr = threading.Thread(target=pump, daemon=True)
                thr.start()
                # Poll instead of a single blocking `proc.wait`: it lets us honour a
                # cancellation (Stop button) mid-run and kill the whole process tree
                # immediately, instead of waiting for the timeout to expire.
                rc = None
                while True:
                    if self.cancelled():
                        _kill_tree(proc.pid)        # reaps start /b grandchildren too
                        stop.set()
                        thr.join(timeout=2)
                        return f"error: command cancelled by user: {cmd}"
                    try:
                        rc = proc.wait(timeout=0.1)
                        break
                    except subprocess.TimeoutExpired:
                        if time.monotonic() - t0 > tmo:
                            _kill_tree(proc.pid)    # reaps start /b grandchildren too
                            stop.set()
                            thr.join(timeout=2)
                            return _timeout_note(cmd, tmo)
                        continue
                stop.set()
                thr.join(timeout=2)
                fo.seek(0)
                fe.seek(0)
                out_b = fo.read(_MAX_OUTPUT_BYTES + 1)
                err_b = fe.read(_MAX_OUTPUT_BYTES + 1)
                exit_code = rc
        except OSError as e:
            return f"error: could not run command: {e}"
        elapsed = time.monotonic() - t0

        # Decode whole captures normally; only a capture that actually got truncated is
        # trimmed to a clean UTF-8 boundary first. A whole capture is decoded as-is so a
        # genuine GBK (cmd.exe built-in) stream is never mangled -- trim only ever sees a
        # truncated UTF-8 stream (the only thing that can land mid-character).
        trunc = ""
        if len(out_b) > _MAX_OUTPUT_BYTES:
            text = smart_decode(_trim_incomplete_utf8_tail(out_b[:_MAX_OUTPUT_BYTES]))
            trunc += f"\n…[stdout truncated to {_MAX_OUTPUT_BYTES} bytes]"
        else:
            text = smart_decode(out_b)
        if len(err_b) > _MAX_OUTPUT_BYTES:
            err = smart_decode(_trim_incomplete_utf8_tail(err_b[:_MAX_OUTPUT_BYTES]))
            trunc += f"\n…[stderr truncated to {_MAX_OUTPUT_BYTES} bytes]"
        else:
            err = smart_decode(err_b)
        result = text + trunc + (("\n[stderr]\n" + err) if err.strip() else "")
        if exit_code != 0:
            result += f"\n[exit {exit_code}]"
        result += f"\n[elapsed {elapsed:.1f}s]"
        if _unbalanced_quotes(cmd):
            result += ("\n[warn] unbalanced double quotes in the command "
                       "(a trailing backslash escapes the closing quote)")
        if _looks_background(cmd):
            result += ("\n[warn] this command started a background child (`start /b`). "
                       "Its output is not captured here -- read the redirected log file "
                       "in a separate call instead of waiting on it.")
        return result


if __name__ == "__main__":
    sys.exit(ShellServer().run())
