/* Differential behaviour test for the speed-drop slider (2026-10-21, this round's feature).
 *
 * Feature: rule 2's fire line was hardcoded at 85%% of the quiet-period baseline (fire on a
 * 15%% drop). It now reads settings.speedDropPct (slider, default 50): the chat compacts early
 * when decode speed falls THIS MANY PERCENT below the baseline. The slider must genuinely move
 * the line at any value, and an old saved profile without the key must fall back to 50.
 *
 * Isolation pattern as in test_pin_pure_window.mjs: grab the REAL functions from app.js, stub
 * the surrounding state. Run: node tests/test_speed_drop_slider.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const src = readFileSync(join(WEB, "app.js"), "utf8");

function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}
const fnCompact = grab("maybeAutoCompact");
const fnThresh = grab("autoCompactThreshold");

const nativeWindow = () => 131072;
const BASELINE = 100;
const LONG = Array(20).fill({ role: "user" });
const OCCUPY = 80000;   // 61% of window: past the half-window gate, below any window rule

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
};

function run(label, dropPct, tokS, expect) {
  let fired = 0, armed = 0;
  const scope = new Function("settings", "maxCtx", "lastPromptTokens", "messages", "busy",
    "autoCompactCooldown", "autoCompactRetryTimer", "speedBaseline",
    "setTimeout", "clearTimeout", "nativeWindow", "lastTurnSpeed", "compactConversation",
    fnThresh + "\n" + fnCompact + "\nmaybeAutoCompact();");
  scope({ autocompact: true, compactPct: 0, speedDropPct: dropPct }, nativeWindow(), OCCUPY, LONG,
    null, 0, null, BASELINE,
    (fn, ms) => { armed++; return 1; }, () => {}, nativeWindow,
    () => ({ tokS, completion: 200 }), () => { fired++; });
  const got = fired > 0 ? "FIRE" : (armed > 0 ? "ARMED" : "silent");
  check(label, got === expect, `${got} (expect ${expect})`);
}

console.log("=== speed-drop slider moves the line (differential) ===");

// [1] slider at 50 (default): 40%% drop stays quiet (line=50), 60%% drop fires.
run("slider 50: 40%% drop -> silent", 50, 60, "silent");
run("slider 50: 60%% drop -> fires", 50, 40, "FIRE");
// [2] slider at 30 (more sensitive than the old hardcoded 15%% was relaxed to):
//     25%% drop quiet (line=70), 35%% drop fires.
run("slider 30: 25%% drop -> silent", 30, 75, "silent");
run("slider 30: 35%% drop -> fires", 30, 65, "FIRE");
// [3] slider at 80 (relaxed end): 70%% drop quiet (line=20), 85%% drop fires.
run("slider 80: 70%% drop -> silent", 80, 30, "silent");
run("slider 80: 85%% drop -> fires", 80, 15, "FIRE");
// [4] old saved profile without the key (empty string from JSON round-trip): must fall back
//     to the documented default 50 -- same two verdicts as [1].
run("slider empty (old profile): 40%% drop -> silent", "", 60, "silent");
run("slider empty (old profile): 60%% drop -> fires (fallback 50)", "", 40, "FIRE");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
