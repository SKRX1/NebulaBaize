/* Gate (方案A, landed 2026-11): while a turn is STREAMING the footer box must progressively light up
 * the data that is ALREADY known at send-time — above all the SEED. Root facts locked here:
 *   • m.seed / m.seedPinned are written in send() (L7146/7147), NOT from a usage chunk, so they exist
 *     for the WHOLE streaming window -- there is no reason to hide them until the finish row.
 *   • renderStats(el,m,streaming=true) now adds a stat--seed chip to its live skeleton and lights it per
 *     tick (own _seedSig anti-flicker, same idea as _sig), mirroring the finished-row seed chip exactly
 *     (class/data-seed/role/tabindex/title/icon + t() keys). The #chat click-copy handler uses closest()
 *     + data-seed so this SAME-container live chip is clickable too.
 *   • roundText-driven chips already light during streaming (the existing round block); the seed must not break them.
 * Load-bearing proven by flipping ONE variable -- does m.seed exist? (yes -> lit with the number; no -> hidden).
 * Run standalone: node tests/test_footer_progressive_seed.mjs
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
check("static lock: streaming skeleton gained a stat--seed span", /stat--seed" hidden><\/span>`;/.test(srcText));
check("static lock: seed chip has its OWN anti-flicker sig (box._seedSig), not shared with _sig", /box\._seedSig = null/.test(srcText) && /if \(box\._seedSig !== ssig\)/.test(srcText));
check("static lock: the streaming seed fill stays HIDDEN until m.seed exists (honest guard, no fake number)", /m\.seed == null\) \{ scv\.hidden = true;/.test(srcText));
check("static lock: lit seed chip carries role/tabindex/data-seed + title=t('stat.seed.tip')", /scv\.setAttribute\("role", "button"\); scv\.tabIndex = 0;[\s\S]{0,120}dataSeed|dataset\.seed/.test(srcText) && /title = t\("stat\.seed\.tip"\)/.test(srcText));

// --- jsdom boot real app.js for the FUNCTIONAL differential -------------------------------------
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__probe = (function () {
  var out = {};
  // Build a streaming message element: .st-msg[data-i] > .msg-stats (what renderStats queries).
  function freshEl(){
    var host = document.createElement("div");
    host.className = "st-msg"; host.setAttribute("data-i", "0");
    var box = document.createElement("div"); box.className = "msg-stats";
    host.appendChild(box); document.body.appendChild(host);
    return {el: host, box: box};
  }

  // A streaming turn that DOES have a send-time seed (m.seed written in send()).
  var p1 = freshEl();
  var m1 = { role: "assistant", text: "", reasoning: true, startAt: performance.now(), tools: [], seed: 987654321, seedPinned: false };
  renderStats(p1.el, m1, true);   // streaming=true branch -> must light the seed chip
  var seedChip = p1.box.querySelector(".stat--seed");
  out.seedLitWhenPresent = !!(seedChip && seedChip.hidden === false && String(seedChip.getAttribute("data-seed")) === "987654321" && /987654321/.test(seedChip.textContent || ""));

  // Control: a streaming turn WITHOUT a seed (single-variable flip) -> the honest guard keeps the chip hidden.
  var p2 = freshEl();
  var m2 = { role: "assistant", text: "", reasoning: true, startAt: performance.now(), tools: [], seed: null, seedPinned: false };
  renderStats(p2.el, m2, true);
  var seedChip2 = p2.box.querySelector(".stat--seed");
  out.seedHiddenWhenAbsent = !!(seedChip2 && seedChip2.hidden === true);

  // Load-bearing differential on the ROUND chip (must stay intact, not broken by the new seed row):
  // a streaming turn WITH a tool round lights the round chip; one WITHOUT stays hidden. Single variable flips it.
  var p3 = freshEl();
  var m3 = { role: "assistant", text: "", reasoning: true, startAt: performance.now(), tools: [{round: 7}], seed: null, seedPinned: false };
  renderStats(p3.el, m3, true);
  var roundChip = p3.box.querySelector(".stat--round");
  out.roundLitWhenToolRound = !!(roundChip && roundChip.hidden === false && /7/.test(roundChip.textContent || ""));

  var p4 = freshEl();
  var m4 = { role: "assistant", text: "", reasoning: true, startAt: performance.now(), tools: [], seed: null, seedPinned: false };
  renderStats(p4.el, m4, true);
  var roundChip2 = p4.box.querySelector(".stat--round");
  out.roundHiddenNoToolRound = !!(roundChip2 && roundChip2.hidden === true);

  return out;
})();`;
win.eval(appCode);
const r = win.__probe;

check("FUNCTIONAL positive: streaming footer LIGHTS the seed chip when m.seed exists (send-time known)", r.seedLitWhenPresent === true);
check("DIFFERENTIAL control: NO seed -> seed chip stays hidden (honest guard, no fake number) -- load-bearing", r.seedHiddenWhenAbsent === true);
check("DIFFERENTIAL round WITH tool round -> lit (existing streaming behaviour not broken by the new row)", r.roundLitWhenToolRound === true);
check("DIFFERENTIAL round WITHOUT tool round -> hidden (single-variable flip, load-bearing)", r.roundHiddenNoToolRound === true);

console.log("\nFOOTER-PROGRESSIVE-SEED: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
