/* Differential contract test for the decision-card auto-drive guard (2026-10-23).

Semantics the user approved, which this test locks:
  1. The old rule "a turn with a decision card ships no suggestion chips" is RETIRED --
     a card turn still ships the full tier set (green / yellow / red), chips stay clickable.
  2. NEW GUARD (app.js maybeAutoDrive): if the turn carries a VISIBLE decision card, the
     whole turn is NOT auto-driven -- the card is waiting for the human to pick, and
     auto-running a green/yellow chip would execute that pending decision on its own.
  3. Red (avoid) never auto-runs and blue (hold) never auto-runs -- unchanged.

Differential design (two probes per lock, so a "happens to be empty" run cannot fake a pass):
  T1 target: card + eligible chips  -> NOTHING scheduled
     control: no card + same chips -> scheduled (picks non-empty, depth 1, timer armed)
  T2 target: all cards dismissed    -> auto-drive RESUMES (guard counts only visible cards)
  T3 target: card present, only red chips -> nothing scheduled (red never runs, unchanged)

Boots the REAL index.html + i18n.js + app.js in jsdom with an in-memory fake environment,
mirroring the test_autosteps.mjs skeleton, so the REAL parsed function body is under test.

Run: node tests/test_card_guard_no_autodrive.mjs
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
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;window.__api = {
  extractNextSteps, renderNextSteps, maybeAutoDrive,
  setSettings: (patch) => { settings = {...settings, ...patch}; },
  clearTimer: () => { if (autoDriveTimer) { clearTimeout(autoDriveTimer); autoDriveTimer = null; } },
  getAutoDrive: () => ({ depth: autoDriveDepth, abort: autoDriveAbort, timer: autoDriveTimer }),
  resetAutoDrive: () => {
    autoDriveDepth = 0; autoDriveAbort = false;
    if (autoDriveTimer) { clearTimeout(autoDriveTimer); autoDriveTimer = null; }
    showAutoDrivePill(false);
  },
};
settings.hideavoid = false;  // test hygiene: pin render precondition (tier-LOGIC tests need display ON)
`;
win.eval(fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + ";Object.assign(window,{timeStr,fmtBytesSel,parsePlanItems,extractNextSteps,extractProposalsFromText,detectLang,firstPath,nextScopeUp,nextScopeDown,clone});");
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const pill = () => win.document.getElementById("autodrive-pill");

// Build a finalized assistant message the way the streaming loop does: the ```next-steps
// fence is parsed out of m.text into m.steps (so the tier flags are production-shaped),
// and -- like the card pipeline does -- the fence is stripped while m.proposals keeps the card.
function makeMsg(stepLines, cards) {
  const m = { role: "assistant", text: "Done.\n\n```next-steps\n" + stepLines.join("\n") + "\n```\n", steps: [], selSteps: [], proposals: [] };
  const r = api.extractNextSteps(m.text);
  m.steps = r.steps;
  m.text = r.text;
  m.proposals = cards || [];
  return m;
}

const CARD = { id: "c1", title: "Pick a tier", verified: true, summary: "s", options: [{ label: "A", verdict: "Recommended" }] };
const CHIPS = ["* Green rec", "- Neutral", "! Red avoid"];

// ---------- tests --------------------------------------------------------------
console.log("CARD-GUARD-NO-AUTODRIVE:");

// T1: differential pair -- visible card silences the whole turn, no-card control still drives
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });

  const target = makeMsg(CHIPS, [CARD]);
  api.maybeAutoDrive(target);
  let ad = api.getAutoDrive();
  check("T1 target: card turn -> nothing scheduled", (!target.selSteps || target.selSteps.length === 0), JSON.stringify(target.selSteps));
  check("T1 target: card turn -> pill hidden", pill().hidden === true);
  check("T1 target: card turn -> depth stays 0", ad.depth === 0, "depth=" + ad.depth);
  check("T1 target: card turn -> no timer armed", ad.timer === null);
  api.clearTimer();

  const control = makeMsg(CHIPS, []);
  api.maybeAutoDrive(control);
  ad = api.getAutoDrive();
  check("T1 control: no-card turn -> still drives (picks green+neutral)", JSON.stringify([...control.selSteps].sort()) === JSON.stringify([0, 1]), JSON.stringify(control.selSteps));
  check("T1 control: no-card turn -> depth incremented to 1", ad.depth === 1, "depth=" + ad.depth);
  check("T1 control: no-card turn -> pill shown", pill().hidden === false);
  check("T1 control: no-card turn -> timer armed", ad.timer !== null);
  api.clearTimer();
}

// T2: all cards dismissed -> the guard stops counting, auto-drive resumes
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });
  const m = makeMsg(CHIPS, [{ ...CARD, id: "c2", dismissed: true }]);
  api.maybeAutoDrive(m);
  const ad = api.getAutoDrive();
  check("T2: dismissed-only cards -> auto-drive resumes", JSON.stringify([...m.selSteps].sort()) === JSON.stringify([0, 1]), JSON.stringify(m.selSteps));
  check("T2: dismissed-only cards -> depth incremented to 1", ad.depth === 1, "depth=" + ad.depth);
  api.clearTimer();
}

// T3: card present and only red chips -> nothing scheduled (red never ran, unchanged behaviour)
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });
  const target = makeMsg(["! Red only"], [CARD]);
  api.maybeAutoDrive(target);
  let ad = api.getAutoDrive();
  check("T3 target: card + red-only -> nothing scheduled", (!target.selSteps || target.selSteps.length === 0));
  api.clearTimer();

  const control = makeMsg(["! Red only"], []);
  api.maybeAutoDrive(control);
  ad = api.getAutoDrive();
  check("T3 control: no card + red-only -> nothing scheduled either (red never auto-runs)", (!control.selSteps || control.selSteps.length === 0));
  check("T3 control: depth stays 0 (nothing eligible)", ad.depth === 0, "depth=" + ad.depth);
  api.clearTimer();
}

// T4: the retired rule stays retired -- a card turn still RENDERS the full tier set (chips are
// present and clickable), the guard stops only the AUTOMATIC run, never the display.
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });
  const host = doc.createElement("div");
  host.innerHTML = `<div class="next-steps" hidden></div>`;
  const m = makeMsg(CHIPS, [CARD]);
  api.renderNextSteps(host, m);
  const box = host.querySelector(".next-steps");
  check("T4: card turn still renders the chips box", box.hidden === false);
  const btns = [...box.querySelectorAll(".next-step")];
  check("T4: all three tiers rendered as clickable chips", btns.length === 3, "got " + btns.length);
  check("T4: chips carry data-step (clickable)", btns.every((b) => b.dataset.step !== undefined));
  check("T4: card data still on the message", (m.proposals || []).length === 1);
}

// ---------- summary --------------------------------------------------------------
console.log("");
if (FAILURES.length) {
  console.log("CARD-GUARD-NO-AUTODRIVE: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("CARD-GUARD-NO-AUTODRIVE: ALL PASSED");
  process.exit(0);   // boot wires a setInterval; exit cleanly so the suite never hangs
}
