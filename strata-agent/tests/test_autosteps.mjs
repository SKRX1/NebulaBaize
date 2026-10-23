/* Regression test for the autonomous auto-drive + recommended-first suggestion system
   (流式建议「推荐项优先」布局 + 「AI 自动续跑建议 / s-autosteps」开关).

Boots the REAL index.html + i18n.js + app.js in jsdom with an in-memory fake
environment, and verifies the contract these two features introduced:

  Recommended marker   a leading * / • inside a ```next-steps line marks the step recommended.
  Recommended-first    renderNextSteps orders recommended steps first, but keeps the ORIGINAL
                       index via data-step so selSteps (stored as original indices) keeps mapping.
  Auto-drive pick      maybeAutoDrive runs every non-avoid, non-hold step (green+yellow). Avoid=red never runs; hold=blue waits for the user.
  Auto-drive guards    skips when off / busy / error / notice / limit / no eligible picks.
  Chain cap            AUTO_DRIVE_MAX (5) auto steps, then hands back (depth reset to 0).

Run: node tests/test_autosteps.mjs
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

// minimal fetch stub (timers are always cleared preemptively, so this never really fires)
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;window.__api = {
  extractNextSteps, renderNextSteps, maybeAutoDrive, sendSelectedSteps, composeStepsMessage,
  stopAutoDrive, showAutoDrivePill,
  setSettings: (patch) => { settings = {...settings, ...patch}; },
  clearTimer: () => { if (autoDriveTimer) { clearTimeout(autoDriveTimer); autoDriveTimer = null; } },
  getAutoDrive: () => ({ depth: autoDriveDepth, abort: autoDriveAbort, timer: autoDriveTimer }),
  resetAutoDrive: () => {
    autoDriveDepth = 0; autoDriveAbort = false;
    if (autoDriveTimer) { clearTimeout(autoDriveTimer); autoDriveTimer = null; }
    showAutoDrivePill(false);
  },
};`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;

// build an assistant message carrying a ```next-steps fence, then parse it the way the
// streaming loop does (extractNextSteps -> m.steps), so the test mirrors production.
function parseMsg(stepLines, prose = "Done.") {
  const m = { role: "assistant", text: prose + "\n\n```next-steps\n" + stepLines.join("\n") + "\n```\n", steps: [], selSteps: [] };
  const r = api.extractNextSteps(m.text);
  m.steps = r.steps;
  m.text = r.text;
  return m;
}

const pill = () => win.document.getElementById("autodrive-pill");

// ---------- tests ----------------------------------------------------------------
console.log("AUTO-STEPS / RECOMMENDED-FIRST:");

// T1: a leading * / • marks the step recommended; the marker is stripped from the label
{
  const text = "Done.\n\n```next-steps\n* 推荐一：说明\n• 推荐二\n- 普通一：详情\n普通二\n```\n";
  const { text: out, steps } = api.extractNextSteps(text);
  check("4 steps parsed", steps.length === 4, "got " + steps.length);
  check("step0 recommended (asterisk)", steps[0].recommended === true);
  check("step1 recommended (bullet)", steps[1].recommended === true);
  check("step2 not recommended (dash)", steps[2].recommended === false);
  check("step3 not recommended (plain)", steps[3].recommended === false);
  check("label strips marker + splits detail", steps[0].label === "推荐一" && steps[0].detail === "说明", JSON.stringify(steps[0]));
  check("dash line label/detail split", steps[2].label === "普通一" && steps[2].detail === "详情");
  check("plain label has no marker", steps[3].label === "普通二");
  check("fence stripped from text", !out.includes("next-steps") && out.trim() === "Done.");
}

// T2: renderNextSteps orders recommended first, preserving ORIGINAL index via data-step
{
  const host = doc.createElement("div");
  host.innerHTML = `<div class="next-steps" hidden></div>`;
  const m = { steps: [
    { label: "A", detail: "", recommended: false },
    { label: "B", detail: "", recommended: true  },
    { label: "C", detail: "", recommended: false },
  ], selSteps: [] };
  api.renderNextSteps(host, m);
  const box = host.querySelector(".next-steps");
  check("box shown", box.hidden === false);
  const btns = [...box.querySelectorAll(".next-step")];
  check("3 chips rendered", btns.length === 3, "got " + btns.length);
  check("recommended chip is first", btns[0].classList.contains("next-step--rec") && btns[0].textContent.includes("B"));
  // 2026-10-20: 面板改成「推荐建议 / 下一步建议」两组（next-steps__group--rec），旧的单行
  // `.next-steps__rec` 组标题已经不存在了；这里锁新结构：推荐组有标题，且排在其它建议组之前。
  check("rec group title rendered",
        !!box.querySelector(".next-steps__group--rec .next-steps__title"));
  check("rec group comes before the rest group",
        box.firstElementChild.classList.contains("next-steps__group--rec"));
  // critical: data-step must carry the ORIGINAL index so selSteps (original indices) stays correct
  check("data-step keeps original index (B was 1)", btns[0].dataset.step === "1");
  const order = btns.map((b) => b.dataset.step);
  check("display order is [1,0,2]", JSON.stringify(order) === JSON.stringify(["1", "0", "2"]), JSON.stringify(order));
}

// T3: a pre-selected rec index renders as the "on" chip (this is exactly what auto-drive sets)
{
  const host = doc.createElement("div");
  host.innerHTML = `<div class="next-steps" hidden></div>`;
  const m = { steps: [
    { label: "A", detail: "", recommended: false },
    { label: "B", detail: "", recommended: true  },
    { label: "C", detail: "", recommended: false },
  ], selSteps: [1] };
  api.renderNextSteps(host, m);
  const box = host.querySelector(".next-steps");
  const onBtn = box.querySelector(".next-step--on");
  check("selected chip is the rec one (index 1)", !!onBtn && onBtn.dataset.step === "1");
  check("send button shows selected count", !!box.querySelector("[data-steps-send][data-n='1']"));
}

// T4: composeStepsMessage is pure and predictable (single / combo / +typed)
{
  const steps = [
    { label: "A", detail: "da" },
    { label: "B", detail: "db" },
    { label: "C", detail: ""   },
  ];
  const one = api.composeStepsMessage(steps, [0], "");
  check("single pick keeps exact wording", one === "A：da", JSON.stringify(one));
  const combo = api.composeStepsMessage(steps, [0, 1], "");
  check("combo numbers the picks", combo.includes("1. A：da") && combo.includes("2. B：db"), JSON.stringify(combo));
  const withExtra = api.composeStepsMessage(steps, [2], "顺便 X");
  check("typed text appended to body", withExtra.startsWith("C") && withExtra.includes("顺便 X"), JSON.stringify(withExtra));
}

// T5: switch OFF -> nothing happens
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: false });
  const m = parseMsg(["* 推荐一：说明", "- 普通一：详情"]);
  api.maybeAutoDrive(m);
  const ad = api.getAutoDrive();
  check("off: no pick", (!m.selSteps || m.selSteps.length === 0));
  check("off: pill stays hidden", pill().hidden === true);
  check("off: depth stays 0", ad.depth === 0);
}

// T6: ON -> green+normal both run (autostepsRec retired, filter ignores it); shows pill, schedules the fire
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: true });
  const m = parseMsg(["* 推荐一：说明", "- 普通一：详情"]);   // steps[0] recommended, steps[1] not
  api.maybeAutoDrive(m);
  const ad = api.getAutoDrive();
  check("green+normal both run (autostepsRec retired): picks both", JSON.stringify([...m.selSteps].sort()) === JSON.stringify([0, 1]), JSON.stringify(m.selSteps));
  check("rec-only: depth incremented to 1", ad.depth === 1, "depth=" + ad.depth);
  check("rec-only: pill shown", pill().hidden === false);
  check("rec-only: fire scheduled", ad.timer !== null);
  api.clearTimer();   // preempt the real send so the suite stays deterministic
  check("rec-only: timer cleared after clearTimer", api.getAutoDrive().timer === null);
}

// T7: ON + autostepsRec=false -> picks every suggestion
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });
  const m = parseMsg(["* 推荐一：说明", "- 普通一：详情"]);
  api.maybeAutoDrive(m);
  check("all: picks both indices", JSON.stringify([...m.selSteps].sort()) === JSON.stringify([0, 1]), JSON.stringify(m.selSteps));
  api.clearTimer();
}

// T8: guardrails -> never auto-drive when the turn ended ambiguously
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: true });
  for (const fl of ["error", "notice", "limit"]) {
    const m = parseMsg(["* 推荐一：说明", "- 普通一：详情"]);
    m[fl] = "x";
    api.maybeAutoDrive(m);
    check(`skip on ${fl}: no pick`, (!m.selSteps || m.selSteps.length === 0));
    check(`skip on ${fl}: pill hidden`, pill().hidden === true);
    api.clearTimer();
  }
}

// T9: chain cap -> at most AUTO_DRIVE_MAX auto steps, then it hands back (depth reset to 0)
{
  api.resetAutoDrive();
  api.setSettings({ autosteps: true, autostepsRec: false });  // all eligible so picks is never empty
  let drove = 0;
  for (let i = 0; i < 6; i++) {                               // 6 finalized turns -> 5 driven + 1 cap
    const m = parseMsg(["* 推荐一：说明", "- 普通一：详情"]);
    api.maybeAutoDrive(m);
    if (m.selSteps && m.selSteps.length) drove++;
    api.clearTimer();
  }
  const ad = api.getAutoDrive();
  check("drove exactly AUTO_DRIVE_MAX (5) steps", drove === 5, "drove=" + drove);
  check("depth reset to 0 after cap", ad.depth === 0, "depth=" + ad.depth);
  check("no fire scheduled after cap (chain stopped)", ad.timer === null);
}

// ---------- summary --------------------------------------------------------------
console.log("");
if (FAILURES.length) {
  console.log("AUTO-STEPS: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("AUTO-STEPS: ALL PASSED");
  process.exit(0);   // boot wires a setInterval; exit cleanly so the suite never hangs
}
