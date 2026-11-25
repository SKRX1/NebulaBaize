/* Closing-out backstop gate (B, mechanism layer, 2026-11-02).
   Locks the contract that renderNextSteps draws a VISIBLE minimal reminder when a
   closing-out turn (all-ticked plan, or a live decision-card pending) has NO chips,
   while a plain empty-steps turn with none of those signals stays HIDDEN (so the
   existing hidden-on-empty gates in test_nextsteps_group / test_suggestion_tiers
   stay green).

   Differential pairs (a guard relaxation must lock BOTH the new shape and the old
   false-boundary — 2026-10-21 adjudication):
     A) all-ticked plan + empty steps  -> reminder drawn, box visible       (new shape)
     B) empty steps, no plan, no card   -> box hidden                        (old boundary)
     C) live proposal + empty steps     -> reminder drawn, box visible       (new shape)
     D) all-ticked plan + HAS chips      -> chips group, no reminder         (not reminder)

   Run: node tests/test_closeout_backstop.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "zh");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", { configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } } });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + ";Object.assign(window,{timeStr,fmtBytesSel,parsePlanItems,extractNextSteps,extractProposalsFromText,detectLang,firstPath,nextScopeUp,nextScopeDown,clone});");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") +
  ';window.__api = { renderNextSteps, extractNextSteps, msgEl, dict: () => i18n._dict };');
const api = win.__api;

function renderFor(mIn) {
  const m = { role: "assistant", text: "x", time: Date.now(), ...mIn };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return { m, el, box: el.querySelector(".next-steps") };
}
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));

console.log("\n=== A: all-ticked plan + empty steps -> reminder visible ===");
{
  const { box } = renderFor({ steps: [], plan: [{ label: "1", done: true }, { label: "2", done: true }] });
  check("box visible (not hidden)", box && box.hidden === false);
  const rem = box && box.querySelector(".next-steps__reminder");
  check("reminder node present", !!rem);
  const dict = api.dict();
  check("reminder title matches i18n zh key",
    rem && rem.querySelector(".next-steps__reminder__t").textContent.trim() === dict.zh["nextsteps.closeoutremind.title"],
    rem && rem.querySelector(".next-steps__reminder__t").textContent);
}

console.log("\n=== B: empty steps, no plan, no card -> box hidden (old boundary) ===");
{
  const { box } = renderFor({ steps: [] });
  check("box hidden", box && box.hidden === true);
  check("no reminder node when not closing out", box && !box.querySelector(".next-steps__reminder"));
}

console.log("\n=== C: live proposal + empty steps -> reminder visible ===");
{
  const { box } = renderFor({ steps: [], proposals: [{ id: "p1", title: "t", verified: true, dismissed: false, options: [] }] });
  check("box visible via live decision card", box && box.hidden === false);
  check("reminder node present", !!box.querySelector(".next-steps__reminder"));
}

console.log("\n=== D: all-ticked plan + HAS chips -> chips render, no reminder ===");
{
  const { box } = renderFor({ steps: [{ label: "R", recommended: true }], plan: [{ label: "1", done: true }] });
  check("box visible", box && box.hidden === false);
  check("has chips group", !!box.querySelector(".next-steps__group--rec"));
  check("no reminder node when chips are present", !box.querySelector(".next-steps__reminder"));
}

console.log("\n=== E: i18n new keys zh+en present (pair) ===");
{
  const dict = api.dict();
  for (const k of ["nextsteps.closeoutremind.title", "nextsteps.closeoutremind.sub"]) {
    check(`zh[${k}] present`, !!dict.zh[k]);
    check(`en[${k}] present`, !!dict.en[k]);
  }
}

console.log("\nFAILURES:", FAILURES.length);
process.exit(FAILURES.length ? 1 : 0);
