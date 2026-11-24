/* Regression gate for the early-done NARRATION sub-lane (Plan A, 2026-11-27).
 *
 * ROOT CAUSE it locks: a turn that ENDS by only promising the next step ("...现写 app.js
 * 综合 patch。" then EOS, no tool call, no ```plan fence) was invisible to every auto-resume
 * lane (no truncated / no resumable notice / no plan boxes), so the human had to click 继续.
 * Fix: looksLikeNarration, a front replica of the backend's looks_like_narration, lets the
 * early-done lane catch that dangling narration even with NO plan checklist -- reusing the
 * SAME tiny earlyCap budget.
 *
 *   T1  a dangling "I will now do X" close (forward verb, no done marker, no 你/？) -> TRUE
 *   T2  an explicit completion marker ("已完成" / "总结") -> FALSE
 *   T3  addressed to the user ("接下来你可以…") -> FALSE  (the 你 guard)
 *   T4  a question ("? " / "？") -> FALSE
 *   T5  a long real answer (>400 chars) -> FALSE
 *   T6  an answer with no forward-looking verb -> FALSE
 *   T7  single-source alignment: EVERY verb/done token in the backend's _NARRATE_RE /
 *       _DONE_RE is present in the front EARLY_NARRATE_RE / EARLY_DONE_RE (drift lock)
 *   T8  load-bearing: the 你 guard and the 400-char cap are load-bearing -- mutating
 *       either one flips T3 / T5 respectively (decoys), so removing them regresses.
 *
 * Pure string + new Function (extracts the REAL helper, no jsdom boot).
 * Run: node tests/test_early_done_narration.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.resolve(HERE, "..");
const APP = fs.readFileSync(path.join(AGENT, "serve", "web", "app.js"), "utf8");
const PARSE = fs.readFileSync(path.join(AGENT, "runtime", "toolcall_parse.py"), "utf8");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// --- extract the REAL helper source (const pair + function) and eval it ---
const seg = (APP.match(/const EARLY_NARRATE_RE = [\s\S]*?\n\}/) || [""])[0];
check("T0 helper segment extracted", /function looksLikeNarration/.test(seg));
const factory = new Function(seg + "\nreturn { looksLikeNarration, EARLY_NARRATE_RE, EARLY_DONE_RE };");
const H = factory();
const L = (s) => H.looksLikeNarration(s);

console.log("\n=== T1-T6: the real helper classifies the shapes ===");
check("T1 dangling 'now I will write the patch' -> TRUE",
      L("目录为空、Node v24 可用。现在开始写 app.js 综合 patch。") === true);
check("T1b dangling 'let me start building' -> TRUE",
      L("采样参数已确认。让我开始改 app.js。") === true);
check("T2 explicit done marker -> FALSE",
      L("全部完成，已写好 app.js 并通过回归。") === false);
check("T2b 总结 marker -> FALSE",
      L("总结一下：本轮改动已落地并提交。") === false);
check("T3 addressed to the user (你) -> FALSE",
      L("接下来你可以重启 8099 看效果。") === false);
check("T4 question mark -> FALSE", L("要我现在开始改吗?") === false);
check("T4b full-width question -> FALSE", L("接下来改哪个文件？") === false);
check("T5 long real answer >400 -> FALSE",
      L("开始 ".repeat(300)) === false);
check("T6 answer with no forward verb -> FALSE",
      L("改动已完成，门禁全绿，commit 86d2ef5。") === false);

console.log("\n=== T7: single-source alignment with the backend regexes ===");
// Pull every token out of the backend's _NARRATE_RE / _DONE_RE (the r"..." fragments).
function pyTokens(varName) {
  // The alternation literals contain '(' and ')' (regex char groups), so a non-greedy
  // .*?\) stops too early. Instead: take the header line + every following INDENTED
  // continuation line (Python implicit string concat), which is exactly this var's span
  // and stops at the next top-level statement, then pull out the r"..." literals.
  const lines = PARSE.split("\n");
  const start = lines.findIndex((l) => l.indexOf(varName + " = re.compile(") >= 0);
  if (start < 0) return "";
  let block = lines[start];
  for (let j = start + 1; j < lines.length; j++) {
    if (/^[ \t]/.test(lines[j])) block += "\n" + lines[j];
    else break;
  }
  const lit = (block.match(/r"([^"]*)"/g) || []).map((x) => x.slice(2, -1)).join("");
  return lit.replace(/[()]/g, "").split("|").map((x) => x.trim()).filter(Boolean);
}
const backNarrate = pyTokens("_NARRATE_RE");
const backDone = pyTokens("_DONE_RE");
check("T7 backend _NARRATE_RE parsed", backNarrate.length >= 10, "(n=" + backNarrate.length + ")");
check("T7 backend _DONE_RE parsed", backDone.length >= 10, "(n=" + backDone.length + ")");
const missingN = backNarrate.filter((tk) => !H.EARLY_NARRATE_RE.test(tk));
const missingD = backDone.filter((tk) => !H.EARLY_DONE_RE.test(tk));
check("T7 every backend verb token matched by front EARLY_NARRATE_RE",
      missingN.length === 0, missingN.length ? ("missing: " + missingN.join(",")) : "");
check("T7 every backend done token matched by front EARLY_DONE_RE",
      missingD.length === 0, missingD.length ? ("missing: " + missingD.join(",")) : "");

console.log("\n=== T8: load-bearing decoys (drop a guard -> that case flips) ===");
// decoy A: strip the 你 guard -> T3 (接下来你可以…) would wrongly go TRUE
const segNoYou = seg.replace(/s\.indexOf\("\\u4f60"\) >= 0/, "false");
const L_noYou = new Function(segNoYou + "\nreturn looksLikeNarration;")();
check("T8 removing the 你 guard flips T3 to TRUE (guard is load-bearing)",
      L("接下来你可以重启。") === false && L_noYou("接下来你可以重启。") === true);
// decoy B: drop the 400-char cap -> the long answer would wrongly go TRUE
const segNoCap = seg.replace(/s\.length > 400/, "false");
const L_noCap = new Function(segNoCap + "\nreturn looksLikeNarration;")();
check("T8 removing the 400 cap flips T5 to TRUE (cap is load-bearing)",
      L("开始 ".repeat(300)) === false && L_noCap("开始 ".repeat(300)) === true);
// decoy C: drop the forward-verb tail test -> a marker-less NON-narrating answer flips TRUE.
// The sample has NO done marker, NO 你/？, under 400 chars, but NO forward-looking verb, so the
// real helper ends on EARLY_NARRATE_RE.test(...)=false; stubbing that return to true proves the
// verb test is what keeps a plain statement from being mis-read as narration.
const segNoVerb = seg.replace(/return EARLY_NARRATE_RE\.test\(s\.slice\(-160\)\);/, "return true;");
const L_noVerb = new Function(segNoVerb + "\nreturn looksLikeNarration;")();
const plain = "采样参数保持不变，门禁全绿，commit 已生成。";   // no done / no forward verb / no 你
check("T8 removing the verb test flips a plain statement to TRUE (verb test is load-bearing)",
      L(plain) === false && L_noVerb(plain) === true);

console.log("\n=== T9: isEarlyLane wired to accept the narration sub-lane (static) ===");
check("isEarlyLane now ORs in earlyNarration (openPlan===0 sub-lane)",
      /const isEarlyLane =[\s\S]*openPlan > 0 \|\| earlyNarration/.test(APP));
check("earlyNarration is gated on openPlan===0 (disjoint from the plan sub-lane)",
      /const earlyNarration = openPlan === 0 && looksLikeNarration/.test(APP));

process.exit(FAILURES.length ? 1 : 0);
