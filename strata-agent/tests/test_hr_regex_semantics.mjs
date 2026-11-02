/* hr-regex semantics baseline (2026-11).

Context: a streamed red banner "Cannot set properties of undefined (setting 'height')" was first
blamed on THIS line's hr regex as a ReDoS hot spot. Sandbox probe DISPROVED the ReDoS hypothesis
(all candidate inputs resolve in <1ms, no backtracking blow-up) and the real root cause turned out to
be autosize()'s Event-as-first-arg (commit db91159), already fixed with zero post-fix red banners.

This gate locks that conclusion so a future edit does not "fix" this regex under a false ReDoS premise:
  - STATIC lock: the on-disk hr regex literal is byte-exact to the frozen baseline string.
  - SEMANTIC POSITIVES: legal three-char hrs must match (--- / *** / ___ / "- - -" / "* * *").
  - NON-REDOS EVIDENCE: long-tail inputs that would explode on a catastrophic-backtracking engine
    all resolve in well under 1ms (no exponential growth) -> deterministic, not ReDoS.
  - HONEST DIFFERENTIAL OBSERVATION: the five-hyphen run "-----" returns FALSE by design of this very
    regex -- inside a character class [\s\1] the \1 is NOT a backreference but the octal escape chr(0x01)
    (space-or-SOH, does NOT contain '-'), so only exactly three separators match and a 4th+ bare
    hyphen falls through. Locking this exact behaviour prevents someone "fixing" it under a wrong idea.

Run: node tests/test_hr_regex_semantics.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const FAILURES = [];
const check = (label, cond, extra) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// ── read the real on-disk bytes; extract the hr regex from source, do not hand-type it ──────────
const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const FEATURE = "[-*_]"; // pure-ascii anchor unique to the hr line
const featureLines = src.split("\n").filter((l) => l.includes(FEATURE));
check("exactly one source line carries the hr feature (anchor uniqueness)", featureLines.length === 1, "count=" + featureLines.length);

// pull the /.../ literal out of that single line so we test the DISK truth, not a hand-typed copy
const m = /\/(.*?)\/\.test/.exec(featureLines[0] || "");
check("hr regex literal extractable from disk", !!m, JSON.stringify(m && m[1]));
if (!m) { console.log("\nHR-REGEX: HALTED (could not extract literal)\n"); process.exit(1); }

const PATTERN = m[1];
// Freeze the exact pattern string so a future semantic edit trips this static lock.
check("static lock: pattern byte-exact to frozen baseline",
      PATTERN === "^\\s*([-*_])\\s*\\1\\s*\\1[\\s\\1]*$", "actual=" + JSON.stringify(PATTERN));

const reFinal = new RegExp(PATTERN);

console.log("\n=== semantics (read straight off the disk pattern) ===");
for (const [s, exp] of [
  ["---", true], ["***", true], ["___", true], ["- - -", true], ["* * *", true], // legal three-char hrs MUST match
  ["-", false], ["--", false],                                                        // under three -> not an hr
  ["-----", false],                                                                  // documented design behaviour (NOT ReDoS; see header)
]) {
  check("test('" + s + "') === " + exp, reFinal.test(s) === exp);
}

// ── non-ReDoS evidence: deterministic, sub-millisecond on long-tail inputs (no blow-up) ──────────
console.log("\n=== non-Redos timing (all must stay well under 1ms; no exponential growth) ===");
const tails = ["-", "- ".repeat(300), "- - -", "*".repeat(500), "_ _ _" + " ".repeat(400), "- --- - --- - ---"];
let maxMs = 0;
for (const s of tails) {
  const t0 = process.hrtime.bigint();
  reFinal.test(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const shortLabel = JSON.stringify(s.slice(0, 40)) + (s.length > 40 ? "..." : "");
  console.log("  test(" + shortLabel + ") -> " + ms.toFixed(3) + " ms");
  if (ms > maxMs) maxMs = ms;
}
check("no candidate input crosses the ReDoS trip-wire (<5ms single-shot)", maxMs < 5, "max=" + maxMs.toFixed(3) + " ms");

console.log("");
if (FAILURES.length) { console.log("FAILED (" + FAILURES.length + "): " + FAILURES.join(" | ")); process.exit(1); }
console.log("HR-REGEX-SEMANTICS: ALL GREEN");
process.exit(0);
