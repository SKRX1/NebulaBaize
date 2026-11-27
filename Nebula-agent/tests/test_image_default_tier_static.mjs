/* Static lock: the front-end's DEFAULT (active) resolution chip is the 512 tier.
 *
 * This is the "image_e2e_sentinel family" static-lock member. The live sentinel
 * (tools/image_e2e_sentinel.py) posts to the running gateway and is a SLOW-tier suite
 * (Quick skips it). This gate needs NO gateway and NO browser -- it is a pure read of the
 * source tree, so it runs in the QUICK tier and thus "locks the 512 default even in Quick".
 *
 * Contract it locks (the 2026-11-14 ladder starts at 32; 512 is the DEFAULT, NOT the first chip):
 *   1. the ladder's default chip carries data-imgres="4" and is the 512 tier            (tier4->512)
 *   2. that data-imgres="4" chip is the one marked active (class "is-active")            (default selection)
 *   3. the default W/H inputs boot at 512                                                (inputs agree)
 *   4. app.js maps tier "4" -> 512 and boots tier "4"                                    (JS agrees)
 *
 * NOTE (2026-11-14 alignment): the resolution ladder now starts at 32 (tier0), so 512 is tier4,
 * NOT the first chip. Earlier this gate asserted "first chip == 512", which broke when small tiers
 * (32/64/128/256) were added BELOW 512. The DEFAULT is still 512; we lock the ACTIVE chip, not the
 * FIRST chip. Every assertion stays a pure source-text scan (regex on the real file), deterministic
 * and Quick-safe. The live pixel/POST confirmation stays in the slow sentinel. A load-bearing
 * differential guard at the end proves the scan would flip if the 512 tier moved (decoy re-point).
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
// the ladder starts at 32 (tier0); the DEFAULT tier the app boots on is tier4 -> 512.
check("ladder tier0 is the small 32 tier (first chip NOT 512)", chips[0] === "0",
  `first=${chips[0]} all=${chips.join(",")}`);

// the active/default chip must be the data-imgres="4" chip (the 512 tier), NOT the first chip.
const defaultChipTag = /<button[^>]*data-imgres="4"[^>]*>/.exec(rowSeg);
check('512 tier chip (data-imgres="4") is the active/default one',
  !!defaultChipTag && /is-active/.test(defaultChipTag[0]),
  defaultChipTag ? defaultChipTag[0].trim() : 'no data-imgres="4" chip tag');

// default W/H inputs boot at 832 x 1216 (raised from 512 on 2026-11-27)
const wBoot = /id="img-width"[^>]*value="(\d+)"/.exec(html);
const hBoot = /id="img-height"[^>]*value="(\d+)"/.exec(html);
check("default width input boots at 832", wBoot && wBoot[1] === "832", wBoot ? `value=${wBoot[1]}` : "no match");
check("default height input boots at 1216", hBoot && hBoot[1] === "1216", hBoot ? `value=${hBoot[1]}` : "no match");

// app.js: tier "4" -> 512 and it boots on tier "4"
check('app.js maps tier "4" -> 512', /"4"\s*:\s*512/.test(app));
check('app.js boots tier "4"', /let tier\s*=\s*"4"/.test(app));

// --- LOAD-BEARING differential: re-point the tier-4 (512) mapping to a decoy and re-scan ---
// If the mapping were load-bearing, mutating it must flip the assertion. Swap the tier-4 base
// 512 -> 777 in a throwaway copy and confirm the 'tier 4 -> 512' regex NO LONGER matches (so it
// is not a vacuous always-true regex). The original file is untouched; we scan a mutated copy.
const mutated = app.replace(/"4"\s*:\s*512/, '"4":777');
check("differential: scan is load-bearing (decoy flips it)",
  !/"4"\s*:\s*512/.test(mutated) && /"4"\s*:\s*777/.test(mutated));

console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log("IMAGE DEFAULT-TIER STATIC LOCK: ALL PASSED");
