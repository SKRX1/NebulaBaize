/* Gate: chunk-budget SAFETY pad (anti-drift + differential).
   Root cause fixed: the chunk budget formula let chunkChars->token->+inject+reply == maxCtx
   EXACTLY, so a CJK-heavy chunk (runs ~1 char/token, not the 1.8 the estimate assumes)
   overflowed the real window -> engine 400 -> "even when compacting" -> empty summary.
   Fix: multiply the token budget by a safety factor (<1) so the worst chunk still fits.
   Differential: WITH the pad the budget MUST be strictly smaller than WITHOUT it.
   Single assertion can't tell "pad works" from "logic inverted", so we lock both arms. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dir, "..", "serve", "web", "app.js"), "utf8");

function grab(name) {
  const m = src.match(new RegExp("function " + name + "\\(\\) \\{[\\s\\S]*?\\n\\}"));
  if (!m) throw new Error("grab failed: " + name);
  return m[0];
}
let fails = 0;
const check = (label, cond) => {
  console.log((cond ? "  OK    " : "  FAIL  ") + label);
  if (!cond) fails++;
};

const body = grab("compactReqBudgetChars");

// --- static lock: safety factor present, 0 < s < 1 ---------------------------------
const sm = body.match(/const safety = ([0-9.]+);/);
check("static: safety factor present", !!sm);
const safetyVal = sm ? Number(sm[1]) : 0;
check("static: 0 < safety < 1", safetyVal > 0 && safetyVal < 1);

// --- differential: WITH pad (real body) vs WITHOUT pad (multiplier neutralized) -----
const noPad = body.replace(/\*\s*safety\b/, "");
check("differential setup: no-pad twin differs", noPad !== body);

// run a grabbed function body with injected stubs (maxCtx + measuredInjectTokens are closure-captured)
function run(bodyTxt, maxCtx, inj) {
  const src2 = bodyTxt + "\nreturn compactReqBudgetChars();";
  return new Function("maxCtx", "measuredInjectTokens", src2)(maxCtx, () => inj);
}

const maxCtx = 131072; // selected real window
const A = run(body, maxCtx, 0);   // WITH the pad
const B = run(noPad, maxCtx, 0);  // WITHOUT the pad
console.log("  [diag] WITH-PAD=" + A + "  NO-PAD=" + B);
check("differential: WITH pad < NO-PAD (pad actually shrinks budget)", A < B);
check("differential: both positive integers", Number.isInteger(A) && Number.isInteger(B) && A > 0 && B > 0);
check("differential: pad magnitude sane (~5-20%)", (B - A) / B > 0.03 && (B - A) / B < 0.2);

// second arm at a measured-injection level (the real-world hot path): direction must hold
const A2 = run(body, maxCtx, 20000);
const B2 = run(noPad, maxCtx, 20000);
console.log("  [diag] WITH-PAD(inj20k)=" + A2 + "  NO-PAD(inj20k)=" + B2);
check("differential (with injection): WITH < NO-PAD", A2 < B2);

console.log("\nSAFETY-PAD-GATE: " + (fails === 0 ? "ALL PASSED" : fails + " FAIL"));
process.exit(fails ? 1 : 0);
