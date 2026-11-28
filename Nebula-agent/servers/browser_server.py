"""Browser MCP server: render / screenshot / console via a Chromium-based headless CLI.

Pure standard library — it only shells out to a Chromium binary that is already installed,
so it adds ZERO new Python dependencies and honours the project's stdlib-first rule.
It picks the best *working* browser on this machine:

  - System Edge (the user's primary, intended browser on Windows) — tried first.
  - Playwright's ``chrome-headless-shell`` — a self-contained headless Chromium that works
    headlessly even in sandboxes that block the full Chrome/Edge *renderer* process.
  - Playwright's full chromium / system chrome as further fallbacks.

A quick capability probe (``_can_render``) is run before a binary is accepted, so a browser
that merely launches but cannot actually render (renderer blocked) is skipped in favour of
one that can. This is the rendering layer that lets an HTML page enter the
"render -> read console/DOM -> fix -> re-render" self-correcting loop.

Three actions:
  render(target)      -> the post-JS DOM (--dump-dom): shows what the page ACTUALLY renders,
                          not the raw text. Proves JS ran and mutated the DOM.
  screenshot(target, out) -> a PNG of the rendered page (--screenshot).
  console(target)     -> captured console lines / JS errors (--enable-logging=stderr).

Plus one action that does NOT use a browser at all:

  sim(page, ...)      -> run the page's own <script> in a deterministic browser-environment
                          shim under Node (servers/pagesim/), step N animation frames, inject
                          keyboard/pointer input, and read back state via probe expressions.

`sim` exists because the agent kept hand-writing a Node "sandbox" stub per session to verify a
game (run frames, read `state.score`). A hand-rolled stub is always one API short, so each
round died on a different missing global -- `ReferenceError: location is not defined` (user bug
report 2026-10-20), then `document.createElement`, then `getContext`... Renaming that from
"the agent's fault" to a *tool gap*: the shim here implements the whole surface once, reports
anything it had to fake, and names an unknown global precisely.

`target` is a file path (relative to the browser's own root or an absolute path) or an
http(s) URL. A throwaway --user-data-dir keeps runs isolated so we never touch the user's
live Edge profile.
"""
from __future__ import annotations

import base64
import difflib
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import unquote

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _mcp_base import McpServerBase, smart_decode  # noqa: E402


def _candidate_browsers():
    """Yield candidate Chromium binaries in preference order (de-duplicated).

    Ordering is "the browser the user actually has, most likely first": an explicit
    override, then system Edge, then Playwright's self-contained headless shell, then
    Playwright's full chromium, then whatever `chrome`/`chromium` is on PATH.
    """
    seen: set[str] = set()

    def _uniq(paths):
        for p in paths:
            if not p:
                continue
            key = os.path.normcase(os.path.abspath(p))
            if key in seen or not os.path.isfile(p):
                continue
            seen.add(key)
            yield p

    # 1) explicit override (kept name BROWSER_EDGE_PATH for backwards compat, but it is
    #    really "the browser binary to use")
    env = os.environ.get("BROWSER_BINARY_PATH") or os.environ.get("BROWSER_EDGE_PATH")
    yield from _uniq([env])
    # 2) system Edge — the user's primary, intended browser on Windows
    yield from _uniq([
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    ])
    # 3) system Chrome (same Chromium engine, sometimes installed without Edge)
    yield from _uniq([
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ])
    # 4) Playwright's chrome-headless-shell — self-contained, works headless even where the
    #    full Chrome/Edge renderer is blocked (e.g. some sandboxes)
    caches = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"),
              os.path.expandvars(r"%LOCALAPPDATA%\ms-playwright")]
    for cache in caches:
        if not cache:
            continue
        yield from _uniq(glob.glob(os.path.join(
            cache, "chromium_headless_shell-*", "chrome-headless-shell-win64",
            "chrome-headless-shell.exe")))
        # 5) Playwright's full chromium (fallback)
        yield from _uniq(glob.glob(os.path.join(cache, "chromium-*", "chrome-win64", "chrome.exe")))
        # linux/mac layout, in case this code is ever run outside Windows
        yield from _uniq(glob.glob(os.path.join(
            cache, "chromium_headless_shell-*", "chrome-linux", "chrome-headless-shell")))
        yield from _uniq(glob.glob(os.path.join(cache, "chromium-*", "chrome-linux", "chrome")))
    # 6) system chrome / chromium / edge on PATH
    yield from _uniq([shutil.which("chrome"), shutil.which("chromium"),
                      shutil.which("google-chrome"), shutil.which("google-chrome-stable"),
                      shutil.which("msedge"), shutil.which("microsoft-edge")])



def _kill_tree(pid: int) -> None:
    """Kill a process and its whole tree. `subprocess.run(timeout=)` only kills the direct
    child; Chromium spawns renderer/helper children that would otherwise linger as orphans
    holding the throwaway profile lock. taskkill /T reaps the entire subtree (Windows); on
    other platforms we fall back to the process group."""
    try:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except Exception:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


def _run_capture(args: list[str], timeout: int = 60, cancel=None,
                 cwd: str | None = None) -> tuple[str, str]:
    """Run a browser command and return (stdout, stderr) decoded as UTF-8 (then GBK fallback).

    Capture goes to temp FILES, not pipes: with a pipe a stalled child could keep the write
    handle open and block the read (the same hang class the shell server moved away from).
    On timeout the whole process tree is reaped so Chromium's children don't orphan.

    `cancel` is an optional zero-arg callable returning True when the request has been
    cancelled (Stop button); while it is True the process tree is killed immediately and a
    TimeoutExpired is raised so the caller can report cancellation.
    """
    try:
        with tempfile.TemporaryFile() as fo, tempfile.TemporaryFile() as fe:
            proc = subprocess.Popen(args, stdout=fo, stderr=fe, stdin=subprocess.DEVNULL,
                                    cwd=cwd)
            t0 = time.monotonic()
            while True:
                if cancel is not None and cancel():
                    _kill_tree(proc.pid)
                    raise subprocess.TimeoutExpired(args, timeout)
                try:
                    proc.wait(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    if time.monotonic() - t0 > timeout:
                        _kill_tree(proc.pid)
                        raise
                    continue
            fo.seek(0)
            fe.seek(0)
            return smart_decode(fo.read()), smart_decode(fe.read())
    except subprocess.TimeoutExpired:
        raise
    except Exception as e:
        return f"error: could not launch browser: {e}", ""


_PROBE_LOG: list[str] = []  # why each candidate was rejected — surfaced in the error text


def _probe_fail(browser: str, why: str) -> None:
    """Record why a candidate was rejected, so the final error can name the REAL reason
    instead of the misleading "no usable browser found" (which made a missing `import time`
    look like "no browser installed" and sent the model hunting for the wrong fix)."""
    _PROBE_LOG.append(f"{browser} -> {why}")
    del _PROBE_LOG[:-20]


def _can_render(browser: str) -> bool:
    """Capability probe: can this binary actually RENDER headlessly (not just launch)?

    Some environments have the binary but the Chromium *renderer* process is blocked — the
    browser process exits 0 yet produces no DOM and no screenshot, with empty stderr. On
    those hosts a real render test is impossible, so we detect it and fall through to the
    next candidate. On a normal machine this returns True.

    Every rejection is recorded in `_PROBE_LOG` with its concrete reason.
    """
    tmp = tempfile.mkdtemp(prefix="browser_probe_")
    try:
        page = os.path.join(tmp, "p.html")
        with open(page, "w", encoding="utf-8") as f:
            f.write("<!doctype html><html><body><div id='x'>BEFORE</div>"
                    "<script>document.getElementById('x').innerText='RENDERED_BY_JS_MARKER';"
                    "</script></body></html>")
        url = "file:///" + page.replace("\\", "/")
        with tempfile.TemporaryDirectory() as prof:
            out, err = _run_capture(
                [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
                 f"--user-data-dir={prof}", "--virtual-time-budget=2000", "--dump-dom", url],
                timeout=25)
            if "RENDERED_BY_JS_MARKER" in out:
                return True
            if out.startswith("error: could not launch browser"):
                _probe_fail(browser, out.strip())
            else:
                detail = err.strip().splitlines()[-1][:160] if err.strip() else "no stderr"
                _probe_fail(browser, f"launched but rendered no DOM ({detail})")
            return False
    except Exception as e:
        _probe_fail(browser, f"{type(e).__name__}: {e}")
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


_BROWSER: str | None = None  # cached after first successful detection
_BROWSER_MISS_AT = 0.0       # monotonic time of the last failed detection
# A failed detection is cached only briefly: if the environment is fixed (BROWSER_BINARY_PATH
# exported, a browser installed) the running MCP server picks it up without a restart.
_RETRY_S = float(os.environ.get("BROWSER_RETRY_S") or 60)


def _find_browser() -> str | None:
    """Return the first candidate browser that can actually render, or None."""
    global _BROWSER, _BROWSER_MISS_AT
    if _BROWSER is not None:
        return _BROWSER
    if _BROWSER_MISS_AT and (time.monotonic() - _BROWSER_MISS_AT) < _RETRY_S:
        return None
    _PROBE_LOG.clear()
    for b in _candidate_browsers():
        if _can_render(b):
            _BROWSER = b
            return b
    _BROWSER_MISS_AT = time.monotonic()
    return None


def _no_browser_error() -> str:
    """Build a truthful, actionable error: what was tried and why each candidate failed."""
    tried = list(_candidate_browsers())
    if not tried:
        return ("error: no Chromium/Edge binary found on this machine\n"
                "hint: install Edge/Chrome, or set BROWSER_BINARY_PATH to a Chromium binary")
    lines = [f"error: {len(tried)} browser candidate(s) found but none could render headlessly"]
    lines += [f"  - {p}" for p in tried]
    if _PROBE_LOG:
        lines.append("probe results:")
        lines += [f"  ! {x}" for x in _PROBE_LOG[-8:]]
    lines.append("hint: fix the probe failure above, or point BROWSER_BINARY_PATH at a "
                 "working Chromium/Edge binary")
    return "\n".join(lines)



BASE_FLAGS = ["--headless=new", "--disable-gpu", "--no-sandbox"]

# ---- capture-time policy ---------------------------------------------------------------
# `--virtual-time-budget` (VTB) lets async ("fetch-then-render") pages settle before capture,
# but it NEVER terminates on a page with a perpetual requestAnimationFrame loop: virtual time
# can't reach the budget because every frame reschedules another frame. The game demo page
# (index.html?demo=0) is exactly this and hung ~60s until the subprocess kill (user bug report).
# `--timeout` is ignored while VTB is present, but on its own it is a reliable hard exit — and
# it is the ONLY thing that makes `console` (--enable-logging) exit at all in --headless=new
# (without it the process runs forever once the page loads).
# Policy: local file:// pages load synchronously, so capture straight with --timeout (fast,
# ~2s, no hang); http(s) pages try VTB first (short cap, best for async) and fall back to
# --timeout so even a busy remote page cannot hang. All hard caps are env-tunable.
_VTB_CAP_S = float(os.environ.get("BROWSER_VTB_CAP_S") or 10)     # cap on the VTB attempt
_EXIT_MS = int(os.environ.get("BROWSER_EXIT_MS") or 8000)         # Chromium --timeout ceiling
_PLAIN_CAP_S = float(os.environ.get("BROWSER_PLAIN_CAP_S") or 30)  # subprocess backstop (plain)


def _wants_vtb(url: str) -> bool:
    """Only remote pages benefit from virtual-time settling; local files load synchronously,
    and on a perpetual-rAF page VTB is precisely what hangs."""
    return url.startswith(("http://", "https://"))


def _to_url(target: str) -> str:
    if target.startswith(("http://", "https://")):
        return target
    if target.startswith("file://"):
        url = target
    else:
        url = "file:///" + os.path.abspath(target).replace("\\", "/")
    # Models sometimes hand us a URL-encoded path (and occasionally double-escaped, "%%E6%%B8").
    # Chromium resolves the plain path just as well, so prefer whichever form actually exists
    # on disk — this makes `%E6%B8%B8...` and `%%E6%%B8...` both land on the real file.
    rest = url[len("file:///"):]
    for cand in (rest, unquote(rest), unquote(rest.replace("%%", "%"))):
        if os.path.exists(cand):
            return "file:///" + cand
    return url


# ---- deterministic page simulation (no browser, Node + a browser-env shim) ---------------
# The runner and its environment live in servers/pagesim/ so the JS side stays readable and
# testable on its own: env.cjs (window/document/canvas/location/timers/...) + run.cjs (load a
# page, step frames, inject input, evaluate probes). This file only marshals a job in and
# formats the report out.
_SIM_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pagesim")
_SIM_RUNNER = os.path.join(_SIM_DIR, "run.cjs")
_SIM_TIMEOUT = 60


def _env_int(name, default, lo, hi):
    """Read an integer from the environment, clamped to [lo, hi], falling back to
    `default` on missing/blank/non-numeric. Lets an operator raise a ceiling
    (e.g. the page-sim per-call timeout cap) without editing code."""
    try:
        v = int(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(v, hi))


# _SIM_MAX_TIMEOUT is NOT a baked literal: it reads STRATA_SIM_MAX_TIMEOUT (seconds) so an
# operator can lift the page-sandbox ceiling for slow suites without editing code --
# default 300, clamped to [30, 3600]. As in shell_server.py it MUST stay strictly below
# the executor's mcp.timeout_s in config/mcp_servers.json (currently 330): if the ceiling
# meets or exceeds the transport timeout the gateway drops the call first and this server
# never reports its own timeout. Raise BOTH together leaving a margin, then reload this
# server subprocess to apply.
_SIM_MAX_TIMEOUT = _env_int("STRATA_SIM_MAX_TIMEOUT", 300, 30, 3600)
_SIM_MAX_CHARS = 4000


def _find_node() -> str | None:
    """Locate a Node binary without assuming the gateway's PATH carries one.

    The MCP child inherits the launcher's environment, which on this machine does not always
    include the managed runtime, so walk the usual suspects and take the newest managed one.
    """
    cands = [os.environ.get("NODE_BINARY_PATH"), shutil.which("node"), shutil.which("node.exe"),
             os.path.expandvars(r"%ProgramFiles%\nodejs\node.exe"),
             os.path.expandvars(r"%LOCALAPPDATA%\Programs\nodejs\node.exe"),
             os.path.expandvars(r"%APPDATA%\nvm\current\node.exe")]
    try:
        cands += sorted(glob.glob(os.path.expanduser(
            os.path.expandvars(r"%ProgramFiles%\nodejs\*\node.exe"))), reverse=True)
    except Exception:
        pass
    for c in cands:
        if c and os.path.isfile(c):
            return c
    return None


def _workspace_root() -> str | None:
    """The user's CURRENT workspace root (last absolute entry of the allow file).

    Same contract as shell_server._workspace_cwd: the host moves the active workspace to the
    end of the record on every request, and only absolute entries count. Without this a
    relative `page` would resolve against the agent's install dir instead of the open project.
    """
    af = os.environ.get("FS_ALLOW_FILE")
    if not af:
        # The browser server's env has no FS_ALLOW_FILE (unlike the shell server), so walk up
        # from the install dir to find the shared allow/workspace record file.
        d = os.path.dirname(os.path.abspath(__file__))
        for _ in range(5):
            cand = os.path.join(d, "fs_allowed_roots.txt")
            if os.path.isfile(cand):
                af = cand
                break
            parent = os.path.dirname(d)
            if parent == d:
                break
            d = parent
    if not af:
        return None
    roots = []
    try:
        with open(af, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and re.match(r"^(?:[a-zA-Z]:[\\/]|[\\/]{2}|/)", line):
                    roots.append(line)
    except OSError:
        return None
    for r in reversed(roots):
        if os.path.isdir(r):
            return r
    return None


def _resolve_page(target: str) -> tuple[str | None, str]:
    """Resolve a page path against cwd -> workspace root -> its parent, with a fuzzy hint.

    The path finally used is returned with the caller's `?query` stripped (the runner rebuilds
    location.search from it). A miss lists every candidate it tried and, when a sibling folder
    name is one character off (the `打破块2` vs `打砖块2` typo that burned a whole turn once),
    suggests the near match instead of leaving the model to guess again.
    """
    raw = target.split("?", 1)[0]
    cands = []
    if os.path.isabs(raw):
        cands.append(raw)
    else:
        cands.append(os.path.join(os.getcwd(), raw))
        ws = _workspace_root()
        if ws:
            cands.append(os.path.join(ws, raw))
            cands.append(os.path.join(os.path.dirname(ws), raw))
    norm = []
    for c in cands:
        c = os.path.normpath(c)
        if c not in norm:
            norm.append(c)
    for c in norm:
        if os.path.isfile(c):
            return c, ""
    hint = ""
    for c in norm:
        fixed = _fuzzy_path(c)
        if fixed and fixed != c:
            hint = f"\ndid you mean: {fixed} ?"
            break
    return None, ("target not found. tried:\n" + "\n".join("  - " + c for c in norm) + hint)


def _fuzzy_path(p: str) -> str | None:
    """Repair a near-miss path segment by segment (`打破块2` -> `打砖块2`).

    The model once burned a whole turn on exactly that one-character typo in a project folder
    name: every later stdout looked fine, but the command ran in the wrong directory. Listing
    the candidate that DOES exist turns the next attempt into a one-shot fix.
    """
    parts = os.path.normpath(p).split(os.sep)
    if not parts:
        return None
    cur = parts[0] + os.sep if parts[0].endswith(":") else os.sep
    rebuilt = [parts[0]]
    for seg in parts[1:]:
        if not seg or seg == ".":
            continue
        cand = os.path.join(cur, seg)
        if os.path.exists(cand):
            cur = cand
            rebuilt.append(seg)
            continue
        try:
            entries = os.listdir(cur)
        except OSError:
            return None
        close = difflib.get_close_matches(seg, entries, n=1, cutoff=0.5)
        if not close:
            return None
        cur = os.path.join(cur, close[0])
        rebuilt.append(close[0])
    fixed = rebuilt[0] + os.sep + os.sep.join(rebuilt[1:]) if len(rebuilt) > 1 else rebuilt[0]
    return fixed if os.path.exists(fixed) else None


def _format_sim(rep: dict, path: str) -> str:
    """Turn the runner's JSON report into a compact text result for the model."""
    if rep.get("fatal"):
        return "error: " + str(rep["fatal"])
    errs = rep.get("errors") or []
    cons = rep.get("console") or []
    head = (f"ok={'yes' if rep.get('ok') else 'no'}  page={path}  "
            f"frames={rep.get('frames')}  virtual={int(rep.get('virtual_ms') or 0)}ms  "
            f"draws={rep.get('draws')}  console={len(cons)}  errors={len(errs)}  "
            f"(wall {rep.get('elapsed_ms')}ms)")
    out = [head]
    if errs:
        out.append("errors:")
        for e in errs[:6]:
            tag = e.get("kind") or "error"
            where = os.path.basename(str(e.get("where") or "")) or "?"
            out.append(f"  ! [{where}] {e.get('name')}: {e.get('message')}")
            if tag == "sandbox_gap" and e.get("missing"):
                out.append(f"    -> the sim does not implement `{e['missing']}`. Pass it in "
                           f"`prelude`, e.g. \"globalThis.{e['missing']} = {{...}};\", "
                           f"or use browser__render if the real browser is needed.")
    probes = rep.get("probes") or {}
    if probes:
        out.append("probes:")
        for k, v in probes.items():
            s = json.dumps(v, ensure_ascii=False)
            out.append(f"  {k} = {s[:300]}{'…' if len(s) > 300 else ''}")
    if cons:
        out.append(f"console ({len(cons)}):")
        for c in cons[:25]:
            out.append(f"  [{c.get('level')}] {c.get('text')}")
        if len(cons) > 25:
            out.append(f"  … {len(cons) - 25} more")
    warns = rep.get("warnings") or []
    if warns:
        out.append("warnings:")
        for w in warns[:6]:
            out.append(f"  ~ {w}")
    stubs = rep.get("stub_calls") or []
    if stubs:
        out.append("auto-stubbed (no-op, reported so they can be implemented if they matter): "
                   + ", ".join(f"{s['name']}x{s['count']}" for s in stubs[:15]))
    gaps = [e for e in errs if e.get("kind") == "sandbox_gap"]
    if gaps and rep.get("supported_globals"):
        sup = rep["supported_globals"]
        out.append("supported globals: " + ", ".join(sup[:60]) +
                   (f" … (+{len(sup) - 60})" if len(sup) > 60 else ""))
    if not errs:
        out.append("note: sim runs logic only (no pixels). For a visual check use "
                   "browser__screenshot on the same page.")
    text = "\n".join(out)
    return text if len(text) <= _SIM_MAX_CHARS else text[:_SIM_MAX_CHARS] + "\n…[truncated]"


class BrowserServer(McpServerBase):
    name = "browser"
    tools = [
        {"name": "render", "description": "在无头浏览器中渲染一个页面并返回执行 JS 之后的 DOM",
         "inputSchema": {"type": "object", "properties": {"target": {"type": "string"}},
                         "required": ["target"]}},
        {"name": "screenshot", "description": "渲染一个页面并保存为 PNG 截图",
         "inputSchema": {"type": "object", "properties":
                         {"target": {"type": "string"}, "out": {"type": "string"},
                          "window_size": {"type": "string"}},
                         "required": ["target"]}},
        {"name": "console", "description": "渲染一个页面并捕获 console 输出 / JS 错误",
         "inputSchema": {"type": "object", "properties": {"target": {"type": "string"}},
                         "required": ["target"]}},
        {"name": "sim",
         "description": (
             "在确定性浏览器沙箱中运行本地页面自身的 JavaScript（非真实浏览器、无像素）"
             "并读回其状态。在虚拟时钟上跑 N 个动画帧，可选注入键盘/指针输入，"
             "然后求值探针表达式——用于验证游戏/应用逻辑：第 0 关能否启动、还剩多少方块、"
             "2 秒后得分多少、点击 #btn-start 是否生效。用这个替代你自己写的 Node DOM 桩："
             "沙箱已实现 window/document/location/canvas-2d/audio/timers/localStorage/"
             "observers，为可复现运行给 Math.random 播种，并在页面需要沙箱没有的全局时"
             "精确点名是哪个。从标记解析出的内联处理器（onclick=...）与页面脚本运行在同一"
             "realm，因此其中对 window/document 的引用有效。还需看像素时与 browser__screenshot"
             "配合使用。"),
         "inputSchema": {"type": "object",
                         "properties": {
                             "page": {"type": "string",
                                      "description": "HTML file: absolute, or relative to the "
                                                     "workspace. A ?query becomes "
                                                     "location.search, e.g. "
                                                     "\"index.html?demo=0\""},
                             "script": {"type": "string",
                                        "description": "OR a bare .js file to run without HTML"},
                             "params": {"type": "object",
                                        "description": "extra query params -> location.search, "
                                                       "e.g. {\"demo\": \"0\"}"},
                             "steps": {"type": "integer",
                                       "description": "animation frames to run (default 60)"},
                             "dt": {"type": "number",
                                    "description": "virtual ms per frame (default 16.67)"},
                             "actions": {"type": "array",
                                         "description":
                                         "scripted input, applied at a frame boundary: "
                                         "[{frame:0,type:'keydown',code:'ArrowRight'}, "
                                         "{frame:30,type:'keyup',code:'ArrowRight'}, "
                                         "{frame:0,type:'click',target:'btn-start'}, "
                                         "{frame:5,type:'pointerdown',x:480,y:600}, "
                                         "{frame:9,type:'eval',expr:'state.paused=false'}]. "
                                         "code uses KeyboardEvent.code (ArrowLeft/KeyA/Space)"},
                             "probes": {"type": "object",
                                        "description":
                                        "name -> JS expression evaluated in page scope after "
                                        "the last frame, e.g. {\"score\":\"state.score\", "
                                        "\"alive\":\"bricks.filter(b=>b.alive).length\"}"},
                             "prelude": {"type": "string",
                                         "description":
                                         "JS executed before the page's scripts -- the escape "
                                         "hatch for a global the sandbox lacks "
                                         "(globalThis.X = {...})"},
                             "viewport": {"type": "object",
                                          "description": "{\"width\":960,\"height\":640}"},
                             "seed": {"type": "integer",
                                      "description": "seed for Math.random (default 12345)"},
                             "timeout": {"type": "integer",
                                         "description": f"seconds, 1-{_SIM_MAX_TIMEOUT}, "
                                                        f"default {_SIM_TIMEOUT}"},
                         },
                         "required": []}},
    ]

    def _run(self, args: list[str], timeout: int = 60, cancel=None,
             cwd: str | None = None) -> tuple[str, str]:
        """Run a browser command and return (stdout, stderr) as text.

        Thin wrapper over `_run_capture` (temp-file capture + tree-kill on timeout). The
        previous PIPE-based capture could stall on a hung child; the timeout path now also
        reaps Chromium's child processes instead of leaving them orphaned. `cancel` is
        threaded through so a Stop click kills a running browser immediately. `cwd` is for the
        page sandbox, which must run from the page's folder so relative requires resolve.
        """
        return _run_capture(args, timeout=timeout, cancel=cancel, cwd=cwd)

    def _capture(self, url, build):
        """Run build(vtb: bool) under the capture policy, returning (stdout, stderr).

        Remote pages: try --virtual-time-budget first (settles async renders) with a short
        cap; if that times out (a perpetual animation loop), fall back to a plain --timeout
        run. Local files: go straight to plain --timeout. --timeout is also the exit trigger
        `console` needs — without it the process never exits once the page has loaded.
        """
        if _wants_vtb(url):
            try:
                return self._run(build(True), timeout=_VTB_CAP_S, cancel=self.cancelled)
            except subprocess.TimeoutExpired:
                if self.cancelled():
                    raise                       # user pressed Stop — do not retry
        return self._run(build(False), timeout=_PLAIN_CAP_S, cancel=self.cancelled)

    @staticmethod
    def _cmd(browser, profile, vtb, extra):
        """Shared flags + either --virtual-time-budget or --timeout, then the action flags."""
        c = [browser, *BASE_FLAGS, f"--user-data-dir={profile}"]
        c.append("--virtual-time-budget=3000" if vtb else f"--timeout={_EXIT_MS}")
        return c + list(extra)

    def _sim(self, args):
        """Load a local page's own JS in the deterministic sandbox and report its state.

        Kept off the browser path on purpose: no Chromium is needed (and no browser probe is
        run), so this works even on a host where every renderer is blocked.
        """
        node = _find_node()
        if not node:
            return ("error: Node.js not found (needed by the page sandbox)\n"
                    "hint: install Node, or set NODE_BINARY_PATH to node.exe")
        if not os.path.isfile(_SIM_RUNNER):
            return f"error: page sandbox runner missing: {_SIM_RUNNER}"
        target = str(args.get("page") or args.get("script") or "").strip()
        if not target:
            return "error: pass page=<html path> (or script=<js path>)"
        if target.startswith(("http://", "https://")):
            return ("error: sim runs LOCAL files only (it loads the page's own scripts)\n"
                    "hint: for a remote page use browser__render / browser__screenshot")
        path, why = _resolve_page(target)
        if not path:
            return "error: " + why

        params = dict(args.get("params") or {})
        if "?" in target:                     # "index.html?demo=0" -> params
            from urllib.parse import parse_qsl
            for k, v in parse_qsl(target.split("?", 1)[1], keep_blank_values=True):
                params.setdefault(k, v)
        try:
            _req = int(args.get("timeout", _SIM_TIMEOUT))
        except (TypeError, ValueError):
            _req = _SIM_TIMEOUT
        tmo = max(1, min(_req, _SIM_MAX_TIMEOUT))
        # A request above the ceiling is capped (it has to be: bounded by the gateway
        # transport timeout), but surface it instead of swallowing -- the model otherwise
        # believes it got its longer budget. Tell it how to lift the ceiling.
        _clamped_note = "" if _req <= tmo else (
            "\n[warn] requested timeout %ds clamped to ceiling %ds (raise "
            "STRATA_SIM_MAX_TIMEOUT + mcp.timeout_s together, leaving a margin, then "
            "reload the browser subprocess, to lift it)" % (_req, tmo))

        job = {"page": path, "params": params, "steps": args.get("steps", 60),
               "viewport": args.get("viewport"), "seed": args.get("seed"),
               "dt": args.get("dt"), "actions": args.get("actions") or [],
               "probes": args.get("probes") or {}, "prelude": args.get("prelude") or "",
               "console_limit": args.get("console_limit") or 200}
        fd, job_path = tempfile.mkstemp(prefix="sim_job_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(job, fh, ensure_ascii=False)
            out, err = self._run([node, _SIM_RUNNER, job_path], timeout=tmo,
                                 cancel=self.cancelled, cwd=os.path.dirname(path) or None)
        except subprocess.TimeoutExpired:
            return (f"error: page sandbox timed out after {tmo}s "
                    f"(a page script probably loops forever without yielding; try fewer steps "
                    f"or a larger timeout)" + _clamped_note)
        finally:
            try:
                os.unlink(job_path)
            except OSError:
                pass

        rep = None
        for line in out.splitlines():
            if line.startswith("__SIM__"):
                try:
                    rep = json.loads(line[len("__SIM__"):])
                except Exception:
                    rep = None
        if rep is None:
            tail = (out.strip()[-800:] + "\n" + err.strip()[-800:]).strip()
            return f"error: page sandbox produced no report\n{tail}" + _clamped_note
        return _format_sim(rep, path) + _clamped_note

    def call_tool(self, name, args):
        if name == "sim":
            return self._sim(args)
        browser = _find_browser()
        if not browser:
            return _no_browser_error()
        target = args.get("target", "")
        if not target:
            return "error: target required"
        if not target.startswith(("http://", "https://", "file://")):
            # ::STRATA-PATCH-RESOLVE-PAGE: relative targets resolve against cwd -> workspace
            # root -> its parent (same contract as sim/_resolve_page). Before this patch
            # they went straight to _to_url and landed on the server install dir.
            rp, _why = _resolve_page(target)
            if rp:
                target = rp
        url = _to_url(target)
        # isolated throwaway profile so we never touch the user's live browser
        profile = tempfile.mkdtemp(prefix="browser_profile_")
        try:
            if name == "render":
                out, err = self._capture(
                    url, lambda vtb: self._cmd(browser, profile, vtb, ["--dump-dom", url]))
                return out + (("\n[stderr]\n" + err) if err else "")
            if name == "screenshot":
                out_path = args.get("out")
                if not out_path:
                    out_path = os.path.join(tempfile.gettempdir(), "browser_shot.png")
                elif not os.path.isabs(out_path):
                    # Edge headless has no write permission for a RELATIVE out path
                    # (access denied 0x5); anchor a bare filename to the workspace root
                    # (or cwd) so the model can safely pass "shot.png".
                    _ws = _workspace_root() or os.getcwd()
                    out_path = os.path.join(_ws, out_path)
                size = args.get("window_size") or "1280,800"
                out, err = self._capture(
                    url, lambda vtb: self._cmd(browser, profile, vtb,
                        [f"--window-size={size}", "--hide-scrollbars",
                         f"--screenshot={out_path}", url]))
                if os.path.isfile(out_path):
                    # Multimodal channel: save AND return the PNG as an image content block so a
                    # vision-capable model can actually SEE it. A content array returned here is
                    # honoured by _mcp_base; every other branch still returns a plain string.
                    try:
                        with open(out_path, "rb") as fh:
                            b64 = base64.b64encode(fh.read()).decode("ascii")
                    except Exception as e:
                        return f"saved {out_path} (image not returned to the model: {e})"
                    return [
                        {"type": "text", "text": f"saved {out_path}"},
                        {"type": "image", "data": b64, "mimeType": "image/png"},
                    ]
                return f"error: no screenshot produced\n{out}\n{err}"
            if name == "console":
                # --enable-logging=stderr surfaces console.log and JS errors on stderr
                _, err = self._capture(
                    url, lambda vtb: self._cmd(browser, profile, vtb,
                        ["--enable-logging=stderr", "--v=0", url]))
                # filter to the interesting lines (console + uncaught errors)
                interesting = [l for l in err.splitlines()
                               if any(k in l for k in ("CONSOLE", "console", "Uncaught", "ERROR:"))]
                return "\n".join(interesting) if interesting else "(no console output)"
            raise Exception(f"unknown tool: {name}")
        except subprocess.TimeoutExpired:
            return ("error: browser timed out"
                    + (f" ({os.path.basename(browser)})" if browser else ""))
        finally:
            shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    """入口：源码版由 __main__ 调它；闭源产物里由 `gateway --server <name>` 调它。

    闭源版把 servers/*.py 编成 <name>.pyd（Nuitka --mode=module），扩展模块里
    `__name__` 是模块名而非 "__main__"，故必须由编译后的 gateway 显式调用本函数。
    """
    return BrowserServer().run()


if __name__ == "__main__":
    sys.exit(main())
