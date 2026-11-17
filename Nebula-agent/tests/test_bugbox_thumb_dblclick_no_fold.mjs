/* Gate: a DOUBLE-CLICK on an inline thumbnail inside a bugbox manual row must OPEN the image
 * viewer, NOT fold/collapse the row. Root cause locked here (2026-11): a real dblclick derives TWO
 * clicks that bubble to the bugbox container click-dispatch -> closest([data-bugtoggle]) = the row ->
 * toggles/folds it; AND the global document dblclick handler only matched .ce-input, so a bugbox in-row
 * <img class=inline-ce-img> never opened the viewer. Fix (this gate locks both):
 *   (1) global dblclick guard widened with a 2nd branch `inline-ce-img && closest([data-bugtoggle])`
 *       that fires ONLY inside a bugbox row; the .ce-input FIRST branch is kept verbatim so composer/
 *       addbox path stays byte-identical -> zero cross-talk.
 *   (2) click-dispatch guard right BEFORE the toggle match: if target.closest('.ce-thumb') return.
 * Aligns the existing composer inline-thumb pattern (its span carries its own dblclick + stopPropagation).
 * Differential proves both guards are load-bearing by flipping a SINGLE variable (is the click on the thumbnail?).
 * Run standalone: node tests/test_bugbox_thumb_dblclick_no_fold.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks ----------------------------------------------------------------------
check("static lock: global dblclick guard KEEPS the .ce-input first branch (composer/addbox path byte-identical)",
  /img\.tagName === "IMG" && \(img\.closest\("\.ce-input"\)\|\|/.test(srcText));
check("static lock: global dblclick guard gained a 2nd branch inline-ce-img && closest([data-bugtoggle])",
  /inline-ce-img"\)&&img\.closest\("\[data-bugtoggle\]"\)/.test(srcText));
check("static lock: click-dispatch GUARD on .ce-thumb exists and RETURNS before the toggle",
  /e\.target\.closest && e\.target\.closest\("\.ce-thumb"\)\) return/.test(srcText));
// ORDER lock: the guard line must appear BEFORE the row0/[data-bugtoggle] toggle match inside the same dispatch handler.
const guardPos = srcText.search(/e\.target\.closest && e\.target\.closest\("\.ce-thumb"\)\) return/);
const togglePos = srcText.indexOf('const row0 = e.target.closest && e.target.closest("[data-bugtoggle]");');
check("static lock: the .ce-thumb GUARD sits BEFORE the [data-bugtoggle] toggle (ordering is load-bearing)",
  guardPos > -1 && togglePos > -1 && guardPos < togglePos);

// --- jsdom boot real app.js for the FUNCTIONAL differential -------------------------------------
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"), { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.body.appendChild(win.document.createElement("div")); d.id = "toasts"; }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__probe = (function () {
  var out = {};
  var dbg = document.getElementById("view-debug");           // the bugbox container dispatch lives here (_bugDrawerEl)
  var imgm = document.getElementById("img-modal"), mimg = document.getElementById("img-modal-img");

  // Build a faithful manual-row shape: row[data-bugtoggle] > msg area + an inline thumbnail (.ce-thumb > img.inline-ce-img).
  function freshRow(withThumb){
    dbg.innerHTML = '<div class="debug-list"><div class="debug-item debug-item--bug" data-bugtoggle="ts1">'
      + '<div class="debug-err"><div class="debug-err__msg">row body text'
      + (withThumb ? ' <span class="ce-thumb" contenteditable="false" title="pasted"><span class="ce-thumb__box"><img class="inline-ce-img" src="/data/uploads/x.png" alt="pasted"></span></span>' : '')
      + '</div></div></div></div>';
    return dbg.querySelector("[data-bugtoggle]");
  }

  // A real double-click = click,click,dblclick bubbling to the container dispatch (the click-dispatch) and dblclick to document.
  function dblPath(el){ el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
                       el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true})); }

  // -------- POSITIVE: double-click the inline thumbnail -> viewer opens (guard swallows the fold, dbl opens viewer) --------
  var row = freshRow(true);
  if (imgm) imgm.hidden = true;
  var thumb = dbg.querySelector(".ce-thumb");
  var tImg  = dbg.querySelector("img.inline-ce-img");
  // drive the full physical double-click on the thumbnail image; clicks bubble to container, dbl bubbles too.
  dblPath(tImg); tImg.dispatchEvent(new MouseEvent("dblclick",{bubbles:true,cancelable:true}));
  out.dblThumbOpensViewer = !!(imgm && imgm.hidden===false && /\\/data\\/uploads\\/x\\.png/.test(mimg.getAttribute("src")||""));

  // -------- LOAD-BEARING differential on the GUARD (single variable: is the click ON the thumbnail?) --------
  // CONTROL: single click on NON-thumbnail part of a data-bugtoggle row => toggle FIRES (row fold/expand happens).
  freshRow(true); var msgDiv = dbg.querySelector(".debug-err__msg");   // text area, not inside .ce-thumb
  var wasExpanded0 = bugBoxExpanded.has("ts1");
  msgDiv.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));   // bubbles to container dispatch -> toggle branch runs
  out.controlNonThumbClickTogglesRow = (bugBoxExpanded.has("ts1") !== wasExpanded0);   // state CHANGED => toggle ran

  // TARGET: single click ON the thumbnail (.ce-thumb) => guard returns BEFORE toggle => row state UNCHANGED.
  freshRow(true); var thumb2 = dbg.querySelector(".ce-thumb");
  var wasExpanded1 = bugBoxExpanded.has("ts2") || false;   // ts2 never seen; measure toggle of this new row via its own key if any
  var singleThumbClickDidNotToggle = true;   // we assert below by checking the guard short-circuits
  // click directly on thumb2 (no dblclick) -> should NOT enter the toggle branch. Capture expanded-set size before/after.
  var setSizeBefore = bugBoxExpanded.size;
  thumb2.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true}));
  singleThumbClickDidNotToggle = (bugBoxExpanded.size === setSizeBefore);   // guard -> no toggle
  out.guardBlocksThumbnailClickNoFold = singleThumbClickDidNotToggle;

  return out;
})();`;
win.eval(appCode);
const r = win.__probe;

check("FUNCTIONAL positive: double-click the inline thumbnail OPENS the viewer", r.dblThumbOpensViewer === true);
check("DIFFERENTIAL control: single click on NON-thumbnail row area TOGGLES the fold (toggle branch is live)", r.controlNonThumbClickTogglesRow === true);
check("DIFFERENTIAL target: single click ON the thumbnail does NOT toggle/fold (guard returns first) -- load-bearing", r.guardBlocksThumbnailClickNoFold === true);

console.log("\nBUGBOX-THUMB-DBLCLICK-NO-FOLD: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
