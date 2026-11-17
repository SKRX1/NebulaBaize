/* Regression test for automatic resume of an INTERRUPTED streaming turn (2026-10-20).

Boots the REAL index.html + i18n.js + app.js in jsdom and verifies the contract:

  Truncation    a stream that ends WITHOUT the gateway's [DONE] (and with no error / notice /
                Stop) is marked interrupted (m.truncated). A stream that DID see [DONE], or one
                that ended with an error / notice / Stop, is NOT marked -- those already have
                their own banner and must not be double-reported.
  Auto-resume   an interrupted turn (m.truncated, or a resumable notice) arms an automatic
                resume BY ITSELF -- the human never has to click 继续.
  Eligibility   never auto-resumes on a human Stop (m.stopped), a fatal error (m.error), or
                context_overflow (re-sending would 400 again; that path compacts first).
  Chain cap     at most AUTO_RESUME_MAX (3) consecutive automatic resumes, then it hands the
                task back to the human and resets the counter.
  Kill switch   settings.autoresume === false disables it entirely.
  Banner        the UI says the turn was cut off, instead of silently looking finished.

Run: node tests/test_interrupted_resume.mjs
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
const stops = [];                                  // capture the orphan-turn cancel
win.fetch = async (url, opts = {}) => {
  if (String(url).endsWith("api/chat/stop")) stops.push(opts.body ? JSON.parse(opts.body) : null);
  return { ok: true, status: 200, json: async () => ({}) };
};

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  markTruncatedIfCut, maybeAutoResume, syncBanners,
  setAutoresume: (v) => { settings.autoresume = v; },
  getChain: () => autoResumeChain,
  setChain: (v) => { autoResumeChain = v; },
  getPendingResume: () => pendingResume,
  clearPendingResume: () => { if (pendingResume) clearTimeout(pendingResume.timer); pendingResume = null; },
  AUTO_RESUME_MAX,
};`);
const api = win.__api;

const newMsg = (over = {}) => ({ role: "assistant", text: "", tools: [], ...over });
const reset = () => { api.clearPendingResume(); api.setChain(0); api.setAutoresume(true); };

console.log("AUTO-RESUME OF INTERRUPTED TURNS:");

// T1: stream cut off (no [DONE]) -> marked interrupted + the orphan server turn is cancelled
{
  const m = newMsg();
  const marked = api.markTruncatedIfCut(m, false, "stop-42");
  check("cut stream: marked truncated", marked === true && m.truncated === true);
  check("cut stream: orphan turn cancelled", stops.length === 1 && stops[0].stop_id === "stop-42", JSON.stringify(stops));
}

// T2: healthy end ([DONE] seen) -> NOT truncated
{
  const m = newMsg();
  const marked = api.markTruncatedIfCut(m, true, null);
  check("[DONE] seen: not truncated", marked === false && !m.truncated);
}

// T3: ended with an error / notice / Stop -> NOT truncated (own banner wins)
{
  for (const [label, over] of [["error", {error: "upstream error: boom"}],
                               ["notice", {notice: {code: "idle", resumable: true}}],
                               ["stopped", {stopped: true}]]) {
    const m = newMsg(over);
    const marked = api.markTruncatedIfCut(m, false, null);
    check(`${label}: not truncated (own banner wins)`, marked === false && !m.truncated);
  }
}

// T4: an interrupted turn auto-resumes by itself
{
  reset();
  const m = newMsg({truncated: true});
  const fired = api.maybeAutoResume(m);
  check("truncated: auto-resume armed", fired === true);
  check("truncated: pending resume queued", api.getPendingResume() !== null);
  check("truncated: chain incremented", api.getChain() === 1);
}

// T5: a resumable notice (idle watchdog / round cap) also auto-resumes
{
  reset();
  const m = newMsg({notice: {code: "idle", idle_s: 180, resumable: true}});
  check("notice idle: auto-resume armed", api.maybeAutoResume(m) === true);
  check("notice idle: chain incremented", api.getChain() === 1);
}

// T6: context_overflow must NOT auto-resume (it would 400 again; compaction handles it)
{
  reset();
  const m = newMsg({notice: {code: "context_overflow", resumable: true}});
  check("context_overflow: no auto-resume", api.maybeAutoResume(m) === false);
  check("context_overflow: nothing queued", api.getPendingResume() === null);
}

// T7: human Stop / fatal error never auto-resume
{
  reset();
  check("stopped: no auto-resume", api.maybeAutoResume(newMsg({stopped: true, truncated: true})) === false);
  check("error: no auto-resume", api.maybeAutoResume(newMsg({error: "boom", truncated: true})) === false);
}

// T8: a normally finished turn never auto-resumes
{
  reset();
  check("clean finish: no auto-resume", api.maybeAutoResume(newMsg({text: "done"})) === false);
}

// T9: chain cap -- the (max+1)th attempt is refused and the counter resets
{
  reset();
  let armed = 0;
  for (let i = 0; i < api.AUTO_RESUME_MAX; i++) {
    if (api.maybeAutoResume(newMsg({truncated: true}))) armed++;
    api.clearPendingResume();
  }
  check(`chain: exactly ${api.AUTO_RESUME_MAX} auto-resumes allowed`, armed === api.AUTO_RESUME_MAX, String(armed));
  const gm = newMsg({truncated: true});   // the (max+1)th attempt: this is the give-up path
  const over = api.maybeAutoResume(gm);
  check("chain: (max+1)th refused", over === false);
  // the cap must STAMP the message and surface the reason as a persistent banner, not just a
  // transient toast: a long task that hits the cap should say WHY it stopped, not go silent.
  check("give up: reason stamped on the message", gm.resumeExhausted === api.AUTO_RESUME_MAX, String(gm.resumeExhausted));
  const gbub = win.document.createElement("div");
  api.syncBanners(gbub, gm);
  const gnode = gbub.querySelector(".msg-notice");
  const gtxt = gnode ? gnode.textContent : "";
  check("give up: banner names the reason (not silent)", /auto-resume stopped/i.test(gtxt), JSON.stringify(gtxt.slice(0, 90)));
  // CONTRAST: a plain cut-off turn with no stamp must NOT claim exhaustion
  const cm = newMsg({truncated: true});
  const cbub = win.document.createElement("div");
  api.syncBanners(cbub, cm);
  const cnode = cbub.querySelector(".msg-notice");
  const ctxt = cnode ? cnode.textContent : "";
  check("control: an unstamped cut does NOT claim exhaustion", !/auto-resume stopped/i.test(ctxt) && ctxt.length > 0, JSON.stringify(ctxt.slice(0, 90)));
  check("chain: counter reset after giving up", api.getChain() === 0);
}

// T10: kill switch
{
  reset();
  api.setAutoresume(false);
  check("settings off: no auto-resume", api.maybeAutoResume(newMsg({truncated: true})) === false);
  api.setAutoresume(true);
}

// T11: the UI says the turn was cut off
{
  const m = newMsg({truncated: true});
  const bubble = win.document.createElement("div");
  api.syncBanners(bubble, m);
  const notice = bubble.querySelector(".msg-notice");
  check("truncated: banner shown", !!notice && notice.textContent.length > 0, notice ? notice.textContent : "none");
}

console.log("");
api.clearPendingResume();
if (FAILURES.length) {
  console.log("INTERRUPTED-RESUME: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("INTERRUPTED-RESUME: ALL PASSED");
  process.exit(0);   // boot wires a setInterval; exit cleanly so the suite never hangs
}
