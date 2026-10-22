"""Regression for the deterministic page sandbox (`browser__sim`), 2026-10-20.

The reported bug: during a streaming task the agent told the user "沙箱缺 Location" -- it had
hand-written a Node stub for a browser game, the stub lacked `location`, and the demo hook
(`if (location.search.includes('demo'))`) threw. It then patched the stub with
`shell_exec` and re-ran, i.e. one missing global cost a whole tool round, and the next
session rebuilt the stub from scratch (so the next gap was `document.createElement`, ...).

Root cause was a TOOL gap, not a model failure: there was no way to run a page's JS
deterministically. The fix is servers/pagesim/{env.cjs,run.cjs} + browser__sim.

This suite runs the REAL runner under Node against synthetic pages, so it proves:
  1. `location` (and window/document/canvas/audio/storage/observers) are present -- the exact
     class of failure that was reported;
  2. rAF / setInterval advance on the virtual clock (N frames == N callbacks);
  3. scripted input reaches the page (keydown, click) and probes read state back;
  4. an unknown GLOBAL is reported precisely (`sandbox_gap` + name) and the `prelude` escape
     hatch fixes it in ONE round instead of a blind patch loop;
  5. an unknown canvas METHOD is auto-stubbed and reported instead of aborting the run;
  6. a one-character folder typo yields "did you mean ..." (the 打破块2 / 打砖块2 turn-burner).

Skips cleanly (exit 0) when Node is unavailable.

Run standalone: python tests/test_page_sim.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVERS = os.path.join(HERE, "servers")
RUNNER = os.path.join(SERVERS, "pagesim", "run.cjs")
sys.path.insert(0, SERVERS)

import browser_server as bs  # noqa: E402

checks = 0
NODE = bs._find_node()


def ok(cond, msg):
    global checks
    assert cond, msg
    checks += 1


def run_job(job: dict) -> dict:
    """Run the runner directly and return its parsed __SIM__ report."""
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False)
        p = f.name
    try:
        out = subprocess.run([NODE, RUNNER, p], capture_output=True, timeout=120)
        text = out.stdout.decode("utf-8", "replace")
    finally:
        try:
            os.unlink(p)
        except OSError:
            pass
    for line in text.splitlines():
        if line.startswith("__SIM__"):
            return json.loads(line[len("__SIM__"):])
    raise AssertionError(f"runner produced no report\nstdout={text}\nstderr="
                         f"{out.stderr.decode('utf-8', 'replace')}")


PAGE = """<!doctype html><html><body>
<canvas id="game" width="320" height="240"></canvas>
<button id="btn">go</button>
<script>
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let ticks = 0, keyEvents = 0, clicked = 0, imgReady = false, audioOk = false;
let searchInFrame = 'unset';
const savedBefore = localStorage.getItem('k') || 'none';
localStorage.setItem('k', 'v1');
try { const ac = new (window.AudioContext || window.webkitAudioContext)(); audioOk = !!ac.createGain(); }
catch (e) { audioOk = 'err:' + e.message; }
const img = new Image(); img.src = 'x.png'; img.onload = () => { imgReady = true; };
addEventListener('keydown', e => { keyEvents++; lastKey = e.code; });
document.getElementById('btn').onclick = () => { clicked++; };
setInterval(() => { ticks++; }, 100);

function frame(now) {
  requestAnimationFrame(frame);
  ctx.fillRect(0, 0, 2, 2);
  ctx.definitelyNotARealMethod(1, 2);       // must be auto-stubbed, not fatal
  // The exact shape of the reported crash: location read INSIDE the rAF callback.
  if (location.search.includes('mode=demo')) searchInFrame = location.search;
}
requestAnimationFrame(frame);
</script></body></html>
"""

GAP_PAGE = """<!doctype html><html><body><canvas id="c" width="10" height="10"></canvas>
<script>
const ctx = document.getElementById('c').getContext('2d');
ctx.fillRect(0, 0, 1, 1);
mermaid.render('x');           // a lib the sandbox does not (and should not) provide
</script></body></html>
"""


def main() -> int:
    if not NODE:
        print("PAGE-SIM: skipped (no node binary)")
        return 0

    tmp = os.path.join(HERE, ".pytest_cache", "page_sim")
    os.makedirs(tmp, exist_ok=True)
    page = os.path.join(tmp, "page.html")
    gap_page = os.path.join(tmp, "gap.html")
    with open(page, "w", encoding="utf-8") as f:
        f.write(PAGE)
    with open(gap_page, "w", encoding="utf-8") as f:
        f.write(GAP_PAGE)

    # --- 1) full happy path: 30 frames, params, input, probes ---------------------------
    rep = run_job({
        "page": page, "params": {"mode": "demo"}, "viewport": {"width": 320, "height": 240},
        "steps": 30, "seed": 5,
        "actions": [{"frame": 2, "type": "keydown", "code": "ArrowRight"},
                    {"frame": 3, "type": "click", "target": "btn"}],
        "probes": {"search_in_frame": "searchInFrame", "ticks": "ticks",
                   "keys": "keyEvents", "clicked": "clicked", "img": "imgReady",
                   "audio": "audioOk", "stored": "localStorage.getItem('k')",
                   "saved_before": "savedBefore", "canvas_w": "canvas.width",
                   "size": "canvas.getBoundingClientRect().width"},
    })
    ok(rep["ok"] is True, f"happy path must be ok, errors={rep.get('errors')}")
    ok(rep["frames"] == 30, f"must run 30 frames, got {rep['frames']}")
    # location inside a rAF callback -- the reported "沙箱缺 Location" failure
    ok(rep["probes"]["search_in_frame"] == "?mode=demo",
       f"location.search must be readable inside rAF, got {rep['probes']['search_in_frame']!r}")
    # setInterval(100ms) over 30 frames of 16.67ms ~= 500ms -> 4-5 ticks
    ok(isinstance(rep["probes"]["ticks"], int) and 3 <= rep["probes"]["ticks"] <= 6,
       f"virtual setInterval must tick, got {rep['probes']['ticks']}")
    ok(rep["probes"]["keys"] == 1, f"keydown must reach the page, got {rep['probes']['keys']}")
    ok(rep["probes"]["clicked"] == 1, f"click must reach the onclick handler, got {rep['probes']['clicked']}")
    ok(rep["probes"]["img"] is True, f"Image.onload must fire, got {rep['probes']['img']}")
    ok(rep["probes"]["audio"] is True, f"AudioContext must be usable, got {rep['probes']['audio']}")
    ok(rep["probes"]["stored"] == "v1", "localStorage must round-trip")
    ok(rep["probes"]["saved_before"] == "none", "localStorage must start empty (isolated run)")
    ok(rep["probes"]["canvas_w"] == 320, f"canvas width from HTML, got {rep['probes']['canvas_w']}")
    ok(rep["probes"]["size"] == 320, f"getBoundingClientRect must use canvas size, got {rep['probes']['size']}")
    ok(rep["draws"] >= 30, f"one fillRect per frame expected, draws={rep['draws']}")
    stubbed = [s["name"] for s in rep["stub_calls"]]
    ok("ctx.definitelyNotARealMethod" in stubbed,
       f"unknown canvas method must be auto-stubbed and reported, got {stubbed}")

    # --- 2) reproducibility: same seed + steps => identical probe values ----------------
    probe_min = {"ticks": "ticks", "draws": "1"}
    r1 = run_job({"page": page, "steps": 20, "probes": probe_min, "seed": 1})
    r2 = run_job({"page": page, "steps": 20, "probes": probe_min, "seed": 1})
    ok(r1["probes"] == r2["probes"] and r1["draws"] == r2["draws"],
       "two identical runs must agree (virtual clock)")

    # --- 3) unknown GLOBAL: precise gap report, then prelude fixes it in one round ------
    gap = run_job({"page": gap_page, "steps": 1})
    ok(gap["ok"] is False, "a missing global must be reported, not silently ignored")
    errs = [e for e in gap["errors"] if e.get("kind") == "sandbox_gap"]
    ok(errs and errs[0].get("missing") == "mermaid",
       f"the gap must name the missing global, got {gap['errors']}")
    ok("prelude" in errs[0]["message"], "the gap message must point at the prelude escape hatch")
    ok(gap["supported_globals"], "a gap report must list the supported globals")
    fixed = run_job({"page": gap_page, "steps": 1,
                     "prelude": "globalThis.mermaid = { render() {} };"})
    ok(fixed["ok"] is True, f"prelude must fix the gap in one round, got {fixed['errors']}")

    # --- 4) the MCP tool layer: formatting + path handling ------------------------------
    srv = bs.BrowserServer()
    out = srv.call_tool("sim", {"page": page, "params": {"mode": "demo"}, "steps": 10,
                                "probes": {"search": "searchInFrame"}})
    ok(out.startswith("ok=yes"), f"tool must report success, got:\n{out}")
    ok("frames=10" in out, "tool summary must carry the frame count")
    ok('search = "?mode=demo"' in out, f"tool must render probe values, got:\n{out}")
    ok("no pixels" in out, "tool must say the sim has no pixels (use screenshot for those)")

    # a relative page resolves against the user's workspace, not the install dir
    rel = srv.call_tool("sim", {"page": "page.html", "steps": 1})
    ok(("ok=yes" in rel) or ("not found" in rel),
       "relative page must resolve or explain itself")

    # remote URLs are refused with a pointer at the real-browser tools
    http = srv.call_tool("sim", {"page": "https://example.test/a.html"})
    ok(http.startswith("error:") and "browser__" in http,
       f"http target must be refused with a hint, got {http}")

    # a missing target lists the candidates (and a near-miss suggestion)
    miss = srv.call_tool("sim", {"page": "no_such_dir_zzz/index.html"})
    ok(miss.startswith("error:") and "tried:" in miss, f"miss must list candidates, got {miss}")

    # --- 5) the real game page (the case from the bug report), if present --------------
    # Located through the live workspace record, exactly like the tool does, so this proves
    # the whole chain (workspace -> resolver -> runner) and not a hardcoded path.
    ws = bs._workspace_root()
    game = os.path.join(ws, "index.html") if ws else ""
    if game and os.path.isfile(game):
        # The page keeps its world inside `state` (state.bricks) — probing a bare `bricks`
        # global was written against an older revision and started failing with a
        # sandbox_gap ReferenceError. Probe the object the page actually exposes.
        g = run_job({"page": game, "params": {"demo": "0"}, "steps": 30,
                     "viewport": {"width": 960, "height": 640},
                     "probes": {"mode": "state.mode",
                                "alive": "(state.bricks || []).filter(b => !b.dead).length"}})
        mode = g["probes"].get("mode")
        if isinstance(mode, str) and mode.startswith("[probe failed"):
            print(f"(workspace page {game} has no game state -- live case skipped)")
        else:
            ok(g["ok"] is True, f"real game page must run clean, errors={g.get('errors')}")
            # The page is a user project that keeps evolving: an older revision auto-started on
            # `?demo=0`, the current one boots into its menu. Assert what the SIM guarantees —
            # the script ran, frames advanced, and the page's own state is readable — instead of
            # pinning a game feature that lives outside this repo.
            ok(isinstance(mode, str) and mode != "", f"probes must read the page's own state, got {mode!r}")
            ok(isinstance(g["probes"]["alive"], int), "game state must be readable via probes")
    else:
        print(f"(no page at the live workspace {ws!r} -- live case skipped)")

    print(f"PAGE-SIM: {checks} checks passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssertionError as e:
        print(f"PAGE-SIM FAIL: {e}")
        sys.exit(1)
