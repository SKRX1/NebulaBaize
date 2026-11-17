/* Behaviour regression for the auto-compact short-chat exemption dead zone (fixed 2026-10-21).
 *
 * Field scene: threshold PINNED to 70, occupancy 78% (102236/131072), and the transcript is
 * short in MESSAGE COUNT (the post-compaction rebuild shape: [summary, ...heavy tail]) — the
 * old exemption `messages.length <= 6 && !(pastThreshold && >= 95%)` swallowed exactly this
 * shape forever, because the 95% exemption line was written for adaptive mode (pinned 0).
 * The fix: a PINNED threshold (compactPct > 0) is a user decision — once crossed, fire; the
 * pinned-0 contracts below are untouched.
 *
 * Same isolation pattern as test_autocompact_retry.mjs: grab the real functions from app.js,
 * stub the surrounding state. Asserts the live scene AND the four pinned-0/long-chat contracts.
 * Run: node tests/test_exempt_deadzone.mjs
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

const nativeWindow = () => 131072;      // the live model's native window (128K class)

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
  scope(st.settings, st.maxCtx, st.lpt, st.messages, null, st.cooldown || 0, null, st.baseline || null,
    (fn, ms) => { armed++; return 1; }, () => {}, nativeWindow, () => null, () => { fired++; });
  const got = fired > 0 ? "FIRE" : (armed > 0 ? "ARMED" : "silent");
  check(label, got === expect, `${got} (expect ${expect})`);
}

console.log("=== auto-compact short-chat exemption dead zone (behaviour) ===");

// [1] THE FIELD SCENE that failed on 2026-10-21: pinned 70, 78% occupancy, 5-message
//     post-rebuild transcript. Before the fix: silent forever. Now: fires at the pinned line.
run("pinned 70 + 78% + short transcript fires (the dead zone)",
  { settings: { autocompact: true, compactPct: 70 }, maxCtx: 131072, lpt: 102236, messages: Array(5).fill({ role: "user" }) }, "FIRE");

// [2] pinned 0 (adaptive 75%): past the threshold but under the 95% exemption line —
//     short chats stay whole (old contract kept).
run("pinned 0 + 78% + short chat stays whole (contract)",
  { settings: { autocompact: true, compactPct: 0 }, maxCtx: 131072, lpt: 102236, messages: Array(5).fill({ role: "user" }) }, "silent");

// [3] pinned 0 + genuinely full window: the 95% exemption lets it fire (contract).
run("pinned 0 + 96% + short chat fires (contract)",
  { settings: { autocompact: true, compactPct: 0 }, maxCtx: 131072, lpt: 125829, messages: Array(5).fill({ role: "user" }) }, "FIRE");

// [4] long transcript over the pinned threshold: fires as always (contract).
run("pinned 70 + 78% + long transcript fires (contract)",
  { settings: { autocompact: true, compactPct: 70 }, maxCtx: 131072, lpt: 102236, messages: Array(12).fill({ role: "user" }) }, "FIRE");

// [5] pinned value under the crossing: adaptive mode still respects its own math —
//     pinned 80 with 78% occupancy means the threshold is NOT crossed, so silence is correct.
run("pinned 80 + 78% + short chat stays whole (threshold not crossed)",
  { settings: { autocompact: true, compactPct: 80 }, maxCtx: 131072, lpt: 102236, messages: Array(5).fill({ role: "user" }) }, "silent");

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
