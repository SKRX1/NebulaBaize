/* Differential behaviour test for the pinned-threshold rule (2026-10-21, this round's fix).
 *
 * Field scene: user pinned compactPct=85 but compaction fired at ~53% via rule 2 (the speed
 * early-trigger: occupancy >= 50% + decode speed < 85% of baseline). The fix: rule 2 now
 * requires !settings.compactPct -- a pinned threshold means PURE WINDOW RULE only; the speed
 * channel stays alive only for adaptive mode (pinned 0).
 *
 * Same isolation pattern as test_exempt_deadzone.mjs: grab the REAL functions from app.js,
 * stub the surrounding state (including lastTurnSpeed so the speed channel can actually fire).
 * Run: node tests/_verify_pinrule2.mjs
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
const SPEED_DOWN = { tokS: 40, completion: 200 };   // 60%% drop -> crosses the default 50%% line (was 80/100 for the old 15%% line)

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  cond ? pass++ : fail++;
};

function run(label, st, expect) {
  let fired = 0, armed = 0;
  const scope = new Function("settings", "maxCtx", "lastPromptTokens", "messages", "busy",
    "autoCompactCooldown", "autoCompactRetryTimer", "speedBaseline",
    "setTimeout", "clearTimeout", "nativeWindow", "lastTurnSpeed", "compactConversation",
    fnThresh + "\n" + fnCompact + "\nmaybeAutoCompact();");
  scope(st.settings, st.maxCtx, st.lpt, st.messages, null, st.cooldown || 0, null, st.baseline,
    (fn, ms) => { armed++; return 1; }, () => {}, nativeWindow, () => st.lastSpeed, () => { fired++; });
  const got = fired > 0 ? "FIRE" : (armed > 0 ? "ARMED" : "silent");
  check(label, got === expect, `${got} (expect ${expect})`);
}

console.log("=== pinned threshold = pure window rule (differential) ===");

const LONG = Array(20).fill({ role: "user" });   // long transcript: exemption out of the way

// [1] THE DIFFERENTIAL: pinned 85, occupancy 53% (the exact field scene: 69296/131072),
//     speed channel primed (baseline + slow last turn). Before the fix: FIRE. Now: SILENT.
run("pinned 85 + 53% + speed down -> silent (THE FIX)",
  { settings: { autocompact: true, compactPct: 85 }, maxCtx: 131072, lpt: 69296, messages: LONG,
    baseline: 100, lastSpeed: SPEED_DOWN }, "silent");

// [2] pinned 85, occupancy at the pinned line (111411 = 85%), speed quiet -> rule 1 fires.
run("pinned 85 + 85% + speed quiet -> fires via window rule",
  { settings: { autocompact: true, compactPct: 85 }, maxCtx: 131072, lpt: 111420, messages: LONG,
    baseline: 100, lastSpeed: null }, "FIRE");

// [3] adaptive pinned 0, occupancy 53% (below the adaptive 75% line), speed down -> the
//     speed channel must STILL fire for adaptive mode (contract kept).
run("pinned 0 + 53% + speed down -> fires via speed rule (adaptive kept)",
  { settings: { autocompact: true, compactPct: 0 }, maxCtx: 131072, lpt: 69296, messages: LONG,
    baseline: 100, lastSpeed: SPEED_DOWN }, "FIRE");

// [4] adaptive pinned 0, occupancy 40% (below the speed gate half-window), speed down ->
//     nothing fires (speed rule needs >= 50%).
run("pinned 0 + 40% + speed down -> silent (speed gate < 50%)",
  { settings: { autocompact: true, compactPct: 0 }, maxCtx: 131072, lpt: 52429, messages: LONG,
    baseline: 100, lastSpeed: SPEED_DOWN }, "silent");

// [5] pinned 85, occupancy 84.9% (just under the pinned line), speed down -> silent:
//     the pinned line is the ONLY gate now.
run("pinned 85 + 84% + speed down -> silent (pinned line is the only gate)",
  { settings: { autocompact: true, compactPct: 85 }, maxCtx: 131072, lpt: 110150, messages: LONG,
    baseline: 100, lastSpeed: SPEED_DOWN }, "silent");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
