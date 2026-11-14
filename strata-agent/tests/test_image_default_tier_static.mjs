/* Static lock: the front-end's first (default) resolution chip is the 512 tier.
 *
 * This is the "image_e2e_sentinel family" static-lock member. The live sentinel
 * (tools/image_e2e_sentinel.py) posts to the running gateway and is a SLOW-tier suite
 * (Quick skips it). This gate needs NO gateway and NO browser -- it is a pure read of the
 * source tree, so it runs in the QUICK tier and thus "locks the 512 default even in Quick".
 *
 * Contract it locks (the 2026-11-14 resolution expansion made 512 the new fastest default):
 *   1. the FIRST resolution chip inside #img-res-row carries data-imgres="0"  (the 512 tier)
 *   2. that first chip is the one that is marked active (class "is-active")  (default selection)
 *   3. the default W/H inputs boot at 512                                      (inputs agree)
 *   4. app.js maps tier "0" -> 512 and boots tier "0"                         (JS agrees)
 *
 * Single-variable discipline: every assertion is a pure source-text scan (regex on the real
 * file), so it is deterministic and Quick-safe. The live pixel/POST confirmation stays in the
 * slow sentinel. A load-bearing differential guard at the end proves the scan would flip if the
 * default moved off 512 (we re-point the tier-0 anchor to a decoy value and re-scan).
 *
 * Run: node tests/test_image_default_tier_static.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- locate the resolution chip row, then read chips in document order ---
const rowStart = html.indexOf('id="img-res-row"');
check("img-res-row present", rowStart >= 0);
const rowSeg = rowStart >= 0 ? html.slice(rowStart, html.indexOf("</div>", rowStart)) : "";

const chips = [...rowSeg.matchAll(/data-imgres="(\d+)"/g)].map((m) => m[1]);
check("first res chip is data-imgres=0 (512 tier)", chips[0] === "0", `first=${chips[0]} all=${chips.join(",")}`);

// the active class must sit on that first chip (the default selection is the 512 tier)
const firstChipTag = /<button[^>]*data-imgres="0"[^>]*>/.exec(rowSeg);
check("512 chip is the active/default one", !!firstChipTag && /is-active/.test(firstChipTag[0]),
  firstChipTag ? firstChipTag[0].trim() : "no 512 chip tag");

// default W/H inputs boot at 512
const wBoot = /id="img-width"[^>]*value="(\d+)"/.exec(html);
const hBoot = /id="img-height"[^>]*value="(\d+)"/.exec(html);
check("default width input boots at 512", wBoot && wBoot[1] === "512", wBoot ? `value=${wBoot[1]}` : "no match");
check("default height input boots at 512", hBoot && hBoot[1] === "512", hBoot ? `value=${hBoot[1]}` : "no match");

// app.js: tier "0" -> 512 and it boots on tier "0"
check("app.js maps tier 0 -> 512", /"0"\s*:\s*512/.test(app));
check('app.js boots tier "0"', /let tier\s*=\s*"0"/.test(app));

// --- LOAD-BEARING differential: re-point the tier-0 base to a decoy and re-run the scan ---
// If the mapping were load-bearing, mutating it must flip the assertion. Swap 512 -> 777 in a
// throwaway copy and confirm the "tier 0 -> 512" regex NO LONGER matches (so it is not a vacuous
// always-true regex). The original file is untouched; we scan a mutated copy.
const mutated = app.replace(/"0"\s*:\s*512/, '"0":777');
check("differential: scan is load-bearing (decoy flips it)",
  !/"0"\s*:\s*512/.test(mutated) && /"0"\s*:\s*777/.test(mutated));

console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log("IMAGE DEFAULT-TIER STATIC LOCK: ALL PASSED");