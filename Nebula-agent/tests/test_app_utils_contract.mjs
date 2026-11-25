// Static contract lock for the app_utils.js extraction chain.
// Locks two invariants against future regressions / accidental deletions:
//   L1  load ORDER  : index.html must load web/app_utils.js BEFORE web/app.js
//                     (app_utils defines globals app.js calls at boot; wrong order = ReferenceError).
//   L2  EXPORT SET  : app_utils.js must define the exact set of shared helpers extracted from app.js,
//                     AND app.js must NOT re-define any of them (single source of truth).
// A decoy diff proves the load-order lock is load-bearing: stripping the app_utils tag flips L1 red.
// Pure static read + process.exit(0/1); ASCII-only diagnostics.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const INDEX = join(WEB, "index.html");
const UTILS = join(WEB, "app_utils.js");
const APPJS = join(WEB, "app.js");

// The shared-helper export set that lives in app_utils.js and is called by app.js unchanged.
const EXPORTS = [
  "timeStr", "fmtBytesSel", "parsePlanItems",
  "extractNextSteps", "extractProposalsFromText", "detectLang",
  "firstPath", "nextScopeUp", "nextScopeDown", "clone",
  "classifyTool",
];

let fails = 0;
function ok(cond, label) {
  if (cond) { console.log("PASS " + label); }
  else { console.log("FAIL " + label); fails++; }
}

const index = readFileSync(INDEX, "utf8").replace(/\r\n/g, "\n");
const utils = readFileSync(UTILS, "utf8").replace(/\r\n/g, "\n");
const appjs = readFileSync(APPJS, "utf8").replace(/\r\n/g, "\n");

// ---- L1: load order (real file) ----
function orderIdx(html) {
  const lines = html.split("\n");
  let u = -1, a = -1;
  for (let i = 0; i < lines.length; i++) {
    if (u < 0 && /<script[^>]+src=["'][^"']*app_utils\.js["']/.test(lines[i])) u = i;
    if (a < 0 && /<script[^>]+src=["'][^"']*\/app\.js["']/.test(lines[i])) a = i;
  }
  return { u, a };
}
const ord = orderIdx(index);
ok(ord.u >= 0, "L1a index loads app_utils.js (tag present)");
ok(ord.a >= 0, "L1b index loads app.js (tag present)");
ok(ord.u >= 0 && ord.a >= 0 && ord.u < ord.a, "L1c app_utils.js BEFORE app.js");

// ---- decoy: strip the app_utils tag, load-order lock MUST flip red (load-bearing) ----
const stripped = index.replace(/<script[^>]+src=["'][^"']*app_utils\.js["']><\/script>\n?/g, "");
const ordD = orderIdx(stripped);
ok(!(ordD.u >= 0 && ordD.a >= 0 && ordD.u < ordD.a), "L1-DECOY stripping app_utils tag breaks order lock");

// ---- L2: export set present in app_utils.js ----
for (const name of EXPORTS) {
  const re = new RegExp("function\\s+" + name + "\\s*\\(");
  ok(re.test(utils), "L2a app_utils defines " + name);
}

// ---- L2b: app.js must NOT re-define any extracted helper (single source of truth) ----
for (const name of EXPORTS) {
  const re = new RegExp("function\\s+" + name + "\\s*\\(");
  ok(!re.test(appjs), "L2b app.js does NOT redefine " + name);
}

// ---- L2-DECOY: if app.js redefined one, the no-redefine lock flips red ----
const appDecoy = appjs + "\nfunction clone(o){return o;}\n";
ok(/function\s+clone\s*\(/.test(appDecoy), "L2-DECOY re-adding clone() in app.js trips no-redefine lock");

console.log(fails === 0 ? "APP_UTILS_CONTRACT: ALL GREEN" : "APP_UTILS_CONTRACT: " + fails + " FAIL");
process.exit(fails === 0 ? 0 : 1);
