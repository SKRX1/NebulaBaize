/* Format-root-cause DIFFERENTIAL gate (2026-10-23).

The death-loop's true root cause was never the renderer -- it was that the model wrote the
fence words INLINE (``next-steps`` inside a sentence, which Markdown eats as inline code)
instead of putting a fence block on its own line. The renderer has always been correct.

This test locks that as an ASSERTABLE gate, asserting on RENDERED DOM chips (not just parse
output), so "format is the root cause" stops being a pixel-only claim:

  G1 INPUT A = prose that only MENTIONS the fence inline (no standalone fence block)
       -> renderer gets ZERO steps -> panel stays hidden, 0 chips in the DOM.
  G2 INPUT B = a STANDALONE fenced block, one line per tier (* rec / - rest / ? hold / ! avoid)
       -> renderer gets FOUR steps -> 4 chips in the DOM, one per tier group.
  G3 the four tier groups each render, colour-decides contract intact (rec/rest/hold/avoid).

Assertions match pure-ASCII tier classes only (Chinese titles are display-only, per house rule).

Run: node tests/test_format_fence_differential.mjs
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

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } },
  });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + ";Object.assign(window,{timeStr,fmtBytesSel,parsePlanItems,extractNextSteps,extractProposalsFromText,detectLang,firstPath,nextScopeUp,nextScopeDown,clone});");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { renderNextSteps, extractNextSteps, msgEl };
  // test hygiene: pin the render precondition (these test the tier LOGIC, which needs display ON)
settings.hideavoid = false;
`);;
const api = win.__api;

// Full chain: model text -> extractNextSteps -> build m -> renderNextSteps -> count DOM chips.
function renderFromText(text) {
  const r = api.extractNextSteps(text);
  const m = { role: "assistant", text: r.text, time: Date.now(), steps: r.steps, selSteps: [] };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return { box: el.querySelector(".next-steps"), chips: Array.from(el.querySelectorAll(".next-step")) };
}

const TIER_STAR = "tier_green_probe";
const TIER_REST = "tier_yellow_probe";
const TIER_HOLD = "tier_blue_probe";
const TIER_AVOID = "tier_red_probe";

/* ─── G1: INPUT A = prose that only MENTIONS the fence inline -> 0 chips ─── */
console.log("\n=== G1: inline-mention prose (no standalone fence) -> ZERO chips ===");
{
  // The word wrapped in backticks inside a sentence is INLINE CODE, eaten by Markdown --
  // the parser gets no fence block, so nothing renders. This is the death-loop's shape.
  const inlineWord = String.fromCharCode(96, 96, 96) + "next-steps" + String.fromCharCode(96, 96, 96);
  const inputA = "I will ship the " + inlineWord + " fence below (that description line is inline code, NOT a real fence block).";
  const { box, chips } = renderFromText(inputA);
  check("G1 parser got ZERO steps from inline mention", chips.length === 0, "chips=" + chips.length);
  check("G1 panel stays hidden (nothing to render)", box && box.hidden === true);
}

/* ─── G2: INPUT B = STANDALONE four-tier fence block -> 4 chips ─── */
console.log("\n=== G2: standalone fenced block, four tiers -> FOUR chips ===");
{
  const f = String.fromCharCode(96, 96, 96);
  const inputB = "answer body line\n" + f + "next-steps\n* " + TIER_STAR + "\n- " + TIER_REST +
    "\n? " + TIER_HOLD + "\n! " + TIER_AVOID + "\n" + f + "\nclosing line";
  const { box, chips } = renderFromText(inputB);
  check("G2 panel is visible", box && box.hidden === false);
  check("G2 FOUR chips rendered", chips.length === 4, "chips=" + chips.length);
  const labels = chips.map((c) => c.getAttribute("title") || c.textContent).join(" | ");
  const has = (w) => labels.includes(w);
  check("G2 all four tier labels present in DOM", has(TIER_STAR) && has(TIER_REST) && has(TIER_HOLD) && has(TIER_AVOID), labels);

  /* ─── G3: each tier group renders, colour-decides contract intact ─── */
  console.log("\n=== G3: four tier groups each present (colour-decides intact) ===");
  check("G3 green tier group (--rec) present", !!box.querySelector(".next-steps__group--rec"));
  check("G3 yellow tier group (--rest) present", !!box.querySelector(".next-steps__group--rest"));
  check("G3 blue tier group (--hold) present", !!box.querySelector(".next-steps__group--hold"));
  check("G3 red tier group (--avoid) present", !!box.querySelector(".next-steps__group--avoid"));
  check("G3 each group holds exactly one chip",
        ["--rec", "--rest", "--hold", "--avoid"].every((k) => box.querySelectorAll(".next-steps__group" + k + " .next-step").length === 1));
}

console.log("");
if (FAILURES.length) {
  console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | "));
  process.exit(1);
}
console.log("FORMAT-FENCE-DIFFERENTIAL: ALL GREEN");
process.exit(0);
