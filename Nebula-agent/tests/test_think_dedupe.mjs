/* Gate B (2026-11-04): paintThink renders the thought box. A small quantised model can emit the SAME
   line several times in a row (degenerate echo) and paintThink repainted every one, flooding the reader.
   dedupeThink() folds a run of >=3 identical non-empty lines to ONE line before the paint. It must NOT
   touch a run of <3 identical lines (a model that legitimately repeats a 1-2 line action stays verbatim),
   and must NOT touch blank lines or single lines. Pure-string, deterministic, input-determined output.

   Differential = the length of the identical-line run crossing the >=3 threshold:
     NEGATIVE  (a 2-identical-line run + a single line) -> output keeps all of them verbatim (threshold not crossed)
     POSITIVE  (a 5-identical-line run)                 -> output folds it to a single line
   Run: node tests/test_think_dedupe.mjs */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

const results = [];
const check = (label, cond, extra = "") => { results.push([label, cond]); console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : "")); };

// Extract dedupeThink from app.js and run it in this process (deterministic, no DOM needed for the string rule).
const m = appCode.match(/function dedupeThink\(src\) \{[\s\S]*?\n\}/);
check("[static] dedupeThink is DEFINED in app.js", !!m);
const dedupe = m ? eval("(" + m[0].replace("function dedupeThink(src)", "function (src)") + ")") : () => { throw new Error("no dedupeThink"); };

// --- NEGATIVE: a 2-identical-line run + single lines stay verbatim (threshold NOT crossed) ---
const neg = "alpha\nbeta\nalpha\nalpha\ngamma\n";   // "alpha" appears twice CONSECUTIVELY (run=2) -> kept
// build carefully:
const negIn = ["alpha", "beta", "alpha", "alpha", "gamma", "", "solo"].join("\n");
const negOut = dedupe(negIn);
check("[negative] run of 2 identical lines is NOT folded (threshold is >=3)",
      negOut === negIn, "out=" + JSON.stringify(negOut));

// A lone single line that repeats non-adjacently is also untouched
const negIn2 = "x\ny\nx\ny\nx";   // no consecutive run >=3
check("[negative] non-adjacent repeats untouched (no consecutive run >=3)",
      dedupe(negIn2) === negIn2, "out=" + JSON.stringify(dedupe(negIn2)));

// --- POSITIVE: a run of >=3 identical lines folds to ONE ---
const posIn = ["alpha", "beta", "alpha", "alpha", "alpha", "alpha", "alpha", "gamma"].join("\n");
// 5 consecutive "alpha" -> fold to 1; keep beta, gamma
const posOut = dedupe(posIn);
const expectPos = ["alpha", "beta", "alpha", "gamma"].join("\n");
check("[positive] run of 5 identical lines folds to one line",
      posOut === expectPos, "out=" + JSON.stringify(posOut));

// --- POSITIVE: exactly-3 run folds (boundary = threshold) ---
const b3 = ["L", "M", "L", "L", "L", "N"].join("\n");   // 3 consecutive L -> fold to 1
check("[positive] exactly-3 run folds to one (boundary test)",
      dedupe(b3) === ["L", "M", "L", "N"].join("\n"), "out=" + JSON.stringify(dedupe(b3)));

// --- blank lines pass through untouched (no folding, no collapsing) ---
const bl = "a\n\n\n\nb";
check("[rule] blank lines pass through untouched", dedupe(bl) === bl, "out=" + JSON.stringify(dedupe(bl)));

// --- differential summary ---
check("[differential] <3 arm verbatim, >=3 arm folded (single variable = run length)",
      dedupe(negIn) === negIn && dedupe(posIn) === expectPos);

// The paintThink call site actually routes through dedupeThink (the live path, not only the function)
check("[live-path] paintThink routes the paint through dedupeThink",
      appCode.includes("body.innerHTML = thinkRich(dedupeThink(src));"));

const fails = results.filter(([, c]) => !c);
console.log("");
console.log(fails.length ? "GATE-B THINK-DEDUPE: " + fails.length + " FAILURE(S)" : "GATE-B THINK-DEDUPE: ALL PASSED");
process.exit(fails.length ? 1 : 0);
