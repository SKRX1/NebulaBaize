/* Differential contract test for the finish_reason=length resume gap (approved 2026-10, Plan-A).

WHY THIS FILE EXISTS: a long streaming task stopped mid-sentence with NO Continue button and no
suggestion chips -- the model ran out of ITS OWN output budget (finish_reason=length) in a single
round, the gateway sent a clean [DONE], so the stream looked "finished". The existing recovery rail
(maybeAutoResume) keys on m.truncated / notice / limit and never saw a length-capped turn: the
stream loop had no finish_reason handling at all, so the half-done task parked silently.

The fix: the stream loop now captures finish_reason; a length-capped turn that made REAL progress
is stamped m.truncated=true + m.lengthCapped=true so the proven auto-resume rail carries it on.

Contract (boots the REAL index.html + i18n.js + app.js and drives the REAL streaming loop).
Chunk state lives in the NODE scope (not inside win.eval) so the mock reader closure and the test
share one variable -- this is the same shape test_conn_cut_resume uses; a chunk setter wired
through window.eval would close over an undefined global and stream an empty response.

  P1 length+progress   a turn that streams content then ends finish_reason=length -> truncated set,
                       lengthCapped set, and auto-resume ARMS (the rail the fix feeds).
  P2 stop+DONE control SAME runner, finish_reason=stop -> genuine finish: not truncated, no stamp,
                       auto-resume returns false (the guard cannot mis-fire on a genuine finish).
  P3 length+no-progress a length stop that produced NOTHING (empty content/reasoning/tools) -> NOT
                       stamped (the guard requires real progress); nothing to continue -> no resume.
  P4 length+fatal      a length stop that ALSO carries a fatal error -> error owns the turn, the
                       stamp is skipped (guard honours the fatal bucket).

Run: node tests/test_length_cap_resume.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const enc = new TextEncoder();

function boot() {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");

  // chunk state lives HERE (node scope), shared by the mock reader and the test driver.
  const state = { chunks: [], stops: [] };

  win.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.endsWith("v1/chat/completions")) {
      const bufs = state.chunks.map((c) => enc.encode(c));
      let i = 0;
      return { ok: true, status: 200, json: async () => ({}),
        body: { getReader() { return { read() {
          if (i < bufs.length) return Promise.resolve({ value: bufs[i++], done: false });
          return Promise.resolve({ value: undefined, done: true });
        } }; } } };
    }
    if (u.endsWith("api/chat/stop")) { state.stops.push(opts.body ? JSON.parse(opts.body) : null); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) + `
;window.__api = {
  streamAssistant, maybeAutoResume, syncBanners,
  seed: (text) => { messages = [{role: "user", text}]; },
  last: () => messages[messages.length - 1],
  quiet: () => { settings.autoresume = false; settings.autosteps = false;
                 settings.autolearn = false; settings.autoMemory = false;
                 settings.autocompact = false; settings.recall = false; },
  allowResume: (v) => { settings.autoresume = v; },
  getPendingResume: () => pendingResume,
  clearPendingResume: () => { if (pendingResume) clearTimeout(pendingResume.timer); pendingResume = null; },
  resetChain: () => { autoResumeChain = 0; },
};`);
  return { win, api: win.__api, state };
}

// OpenAI streaming shape helpers
const deltaContent = (txt) => `data: ${JSON.stringify({ choices: [{ delta: { content: txt } }] })}\n\n`;
const finishLen = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] })}\n\n`;
const finishStop = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

async function turn(ctx, chunks) {
  ctx.state.chunks = chunks;
  ctx.api.seed("continue building the level");
  await ctx.api.streamAssistant();
  return ctx.api.last();
}

const main = async () => {
  console.log("FINISH_REASON=LENGTH RESUME GAP (differential):");

  // P1: length-capped WITH progress -> stamped truncated+lengthCapped, auto-resume ARMS
  {
    const ctx = boot(); ctx.api.quiet();
    const m = await turn(ctx, [deltaContent("half a paragraph before"), finishLen, DONE]);
    check("P1: content streamed before the cap", m.text === "half a paragraph before", JSON.stringify(m.text));
    check("P1: length-capped -> truncated stamped", m.truncated === true);
    check("P1: length-capped -> lengthCapped provenance stamped", m.lengthCapped === true);
    check("P1: no fatal error on a healthy link", !m.error, JSON.stringify(m.error));
    ctx.api.allowResume(true);
    check("P1: length-capped -> auto-resume ARMS", ctx.api.maybeAutoResume(m) === true);
    ctx.api.clearPendingResume();
  }

  // P2 CONTROL: finish_reason=stop -> genuine finish: no stamp, no resume (guard must not misfire)
  {
    const ctx = boot(); ctx.api.quiet();
    const m = await turn(ctx, [deltaContent("a full closing answer"), finishStop, DONE]);
    check("P2: content intact", m.text === "a full closing answer", JSON.stringify(m.text));
    check("P2: stop finish -> NOT truncated", !m.truncated);
    check("P2: stop finish -> no lengthCapped stamp", !m.lengthCapped);
    ctx.api.allowResume(true);
    check("P2: stop finish -> auto-resume returns false", ctx.api.maybeAutoResume(m) === false);
    ctx.api.clearPendingResume();
  }

  // P3: length stop with NO progress -> nothing to continue, guard stays closed, no resume
  {
    const ctx = boot(); ctx.api.quiet();
    const m = await turn(ctx, [finishLen, DONE]);   // no content, no reasoning, no tools
    check("P3: empty output -> no progress made", !m.text && !m.reasoning && !(m.tools && m.tools.length));
    check("P3: length but no progress -> NOT stamped", !m.truncated);
    ctx.api.allowResume(true);
    check("P3: length but no progress -> auto-resume returns false", ctx.api.maybeAutoResume(m) === false);
    ctx.api.clearPendingResume();
  }

  // P4: length stop that ALSO carries a fatal error -> the fatal bucket owns the turn
  {
    const ctx = boot(); ctx.api.quiet();
    const chunks = [
      deltaContent("some progress"),
      `data: ${JSON.stringify({ error: { message: "upstream died mid-stream" } })}\n\n`,
    ];
    const m = await turn(ctx, chunks);
    check("P4: fatal error recorded", !!m.error, JSON.stringify(m.error));
    check("P4: fatal bucket -> NOT stamped as a length interruption", !m.truncated && !m.lengthCapped);
    ctx.api.allowResume(true);
    check("P4: fatal -> auto-resume returns false", ctx.api.maybeAutoResume(m) === false);
    ctx.api.clearPendingResume();
  }

  console.log("");
  if (FAILURES.length) {
    console.log("LENGTH-CAP-RESUME: " + FAILURES.length + " FAILED");
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  } else {
    console.log("LENGTH-CAP-RESUME: ALL PASSED");
    process.exit(0);
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
