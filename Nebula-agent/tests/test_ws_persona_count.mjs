/* Regression test for the workspace-persona length warning (ws-persona).
 *
 * Chosen feature: ws-persona reuses renderPersonaCount's counting logic
 * (via the shared paintPersonaCount + personaWarnThreshold) to warn when a
 * workspace persona gets long enough to dilute context. It deliberately does
 * NOT add restore/presets — only the char/token count + over-threshold flag.
 *
 *   T1  an empty ws-persona paints nothing and never flags over
 *   T2  a persona under the (high) threshold shows a "chars / est-tokens" line,
 *       NOT flagged over
 *   T3  the SAME text, threshold flipped down to the slider min, DOES flag over
 *       -> single-variable load-bearing proof the threshold drives the red
 *   T4  the binding actually fires: typing via the input event updates the line
 *   T5  (static) renderWsPersonaCount delegates to paintPersonaCount, so the two
 *       persona boxes share one threshold/wording and cannot silently drift apart
 *   T6  (static) the feature boundary holds: ws-persona adds no restore/preset,
 *       while s-persona keeps its own untouched
 *
 * Run: node tests/test_ws_persona_count.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      {url: "http://127.0.0.1:8765/", runScripts: "outside-only"});
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.EventSource = function () {};   // app boot wires a session SSE stream; stub it
win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.fetch = async () => ({ok: true, status: 200, json: async () => ({})});
win.localStorage.setItem("strata.lang", "en");

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let code = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
code += `
;window.__api = {
  renderWsPersonaCount, paintPersonaCount, personaWarnThreshold,
};`;
win.eval(code);
const api = win.__api;
const $ = (id) => doc.getElementById(id);

console.log("\n=== T0: the ws-persona count element exists in the modal ===");
check("index.html carries #ws-persona-count", !!$("ws-persona-count"));

console.log("\n=== T1: empty persona paints nothing, never over ===");
$("ws-persona").value = "";
api.renderWsPersonaCount();
check("empty -> blank count", $("ws-persona-count").textContent === "");
check("empty -> not over", !$("ws-persona-count").classList.contains("is-over"));

console.log("\n=== T2/T3: same text, threshold drives the red (load-bearing) ===");
// A persona long enough (~110 est-tokens) to sit ABOVE the slider min (100) but
// far BELOW the slider max (2000): flipping only the threshold flips the verdict.
const base = "You are a senior front-end and back-end engineer. Keep answers concise and prefer runnable code. " +
             "Reply in Simplified Chinese. Use structured output: conclusion first, then detail. " +
             "Always self-check code before declaring done. ";
const persona = base + base + base;   // ~3x -> est-tokens comfortably between 100 and 2000

// threshold HIGH (slider at max 2000) -> must NOT flag over
$("ws-persona").value = persona;
$("s-pwarn").value = "2000";
api.renderWsPersonaCount();
const txtHigh = $("ws-persona-count").textContent;
check("long text shows a count line", /\d/.test(txtHigh), JSON.stringify(txtHigh));
check("under high threshold (2000) -> NOT over", !$("ws-persona-count").classList.contains("is-over"));

// threshold LOW (slider at min 100) -> SAME text, single variable flipped -> DOES flag over
$("s-pwarn").value = "100";
check("slider min still >=1 so threshold is 100", api.personaWarnThreshold() === 100);
api.renderWsPersonaCount();
check("over low threshold (100) -> flagged is-over", $("ws-persona-count").classList.contains("is-over"));

console.log("\n=== T4: the input binding fires on typing ===");
$("s-pwarn").value = "2000";   // reset so the typing case is the clean short-path
$("ws-persona").value = "hi";
const ev = new win.Event("input", {bubbles: true});
$("ws-persona").dispatchEvent(ev);
check("typing 'hi' updates the count line", /2/.test($("ws-persona-count").textContent),
      JSON.stringify($("ws-persona-count").textContent));

console.log("\n=== T5: renderWsPersonaCount delegates to the shared helper ===");
const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const fn = (src.match(/function renderWsPersonaCount\(\)\s*\{[\s\S]*?\n\}/) || [""])[0];
check("renderWsPersonaCount body calls paintPersonaCount", /paintPersonaCount\s*\(/.test(fn));
check("renderWsPersonaCount does NOT inline _memEstTokens (shares one path)",
      !/_memEstTokens/.test(fn));

console.log("\n=== T6: feature boundary — no restore/preset on ws, s untouched ===");
check("s-persona keeps its own restore/preset controls", !!$("persona-restore") && !!$("persona-preset"));
check("ws-persona adds NO restore/preset",
      !doc.getElementById("ws-persona-restore") && !doc.getElementById("ws-persona-preset"));

process.exit(FAILURES.length ? 1 : 0);
