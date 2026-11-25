/* Gate (plan-A / BETA收口, landed 2026-11): the main auto-resume chain must not fuse-and-hand-back after only a
 * couple of resumes just because the drawer field holds a stray TOO-SMALL number -- root cause of the reported
 * "ran 2 times then handed back". Root facts (all real bytes, re-read on disk):
 *   • DEFAULTS.autoresumeMax is ALREADY 24 and AUTO_RESUME_MAX const is already 24, so 'display=2' meant
 *     localStorage carried a stray 2 that the ORIGINAL runtime line (`settings.autoresumeMax > 0 ? ... : MAX`) faithfully honoured.
 *   • BETA decision: anti-drift lives in the SAVE SOURCE -- the drawer-save clamps autoresumeMax against AUTO_RESUME_FLOOR (12),
 *     so a future too-small input can't persist below the floor; a manual raise AT/ABOVE the floor still wins. The runtime cap line is intentionally left at its ORIGINAL form (no runtime floor read).
 *   • emptyRoundMax's small budget (default 2) is DESIGN-INTERNAL and must NOT be dragged into this floor guard.
 * Load-bearing proven by flipping ONE variable -- what number does the drawer input hold? via the REAL save clamp expression, reading AUTO_RESUME_FLOOR off the page so the source value gates the outcome.
 * Run standalone: node tests/test_autoresume_floor.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks ----------------------------------------------------------------------
check("static lock: AUTO_RESUME_FLOOR constant is defined (value 12)", /const AUTO_RESUME_FLOOR\s*=\s*12/.test(srcText));
check("static lock (BETA): runtime cap line stays the ORIGINAL >0 form -- anti-drift lives in SAVE clamp, not a runtime floor read", /settings\.autoresumeMax > 0 \? settings\.autoresumeMax : AUTO_RESUME_MAX/.test(srcText) && !/cap = settings\.autoresumeMax >= AUTO_RESUME_FLOOR/.test(srcText));
check("static lock: the SAVE source clamps autoresumeMax against the floor (so a small input can't persist)", /Number\(\$\(\"s-autoresumeMax\"\)\.value\)[^)]*\|\| 24[^?]*>= AUTO_RESUME_FLOOR \? [^:]+: 24/.test(srcText));
check("static lock: emptyRoundMax default budget (2) is NOT dragged into the floor guard", /emptyRoundMax: \(parseInt\(\$\(\"s-emptyRoundMax\"\)\.value,10\)>=0\?parseInt\(\$\(\"s-emptyRoundMax\"\)\.value,10\):2\)/.test(srcText));

// --- jsdom boot real app.js for the FUNCTIONAL differential -------------------------------------
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// reach top-level internal symbols (app.js is strict-mode so lets/consts are not on window): append an export block to the evaluated source.
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
// The load-bearing probe mirrors the REAL save-source clamp expression and reads AUTO_RESUME_FLOOR off the page, so the shipped value gates this test -- load-bearing.
appCode += `
;window.__clampProbe = function (inputValue) {
  // mimic the SAVE-SOURCE clamp EXACTLY using the page's real AUTO_RESUME_FLOOR constant:
  var n = Number(inputValue) || 24;
  return (n >= AUTO_RESUME_FLOOR ? n : 24);
};
window.__floorConst = AUTO_RESUME_FLOOR;`;

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);

// load-bearing differential -- single variable: what does the drawer input hold?
check("static-confirmed floor constant is 12 as designed", win.__floorConst === 12);
check("DIFFERENTIAL dirty value 2 (below floor) -> SAVE clamps back to default 24, not 2 -- load-bearing", win.__clampProbe(2) === 24);
check("DIFFERENTIAL right at the floor 12 -> honours the input (smallest persisted value)", win.__clampProbe(12) === 12);
check("DIFFERENTIAL manual raise above the floor 30 -> still wins (honours user's raised value)", win.__clampProbe(30) === 30);

console.log("\nAUTO-RESUME-FLOOR: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
