// Static contract lock: the visual HTTP E2E harness copies only a hand-written
// whitelist of web/ assets into its temp doc-root before driving the REAL browser
// over a copy of index.html. Since the app_utils.js chain (classifyTool, the bugBox
// trio, ...) was extracted OUT of app.js, index.html now loads web/app_utils.js --
// so that whitelist MUST contain "app_utils.js". If it drifts (someone regenerates
// the list and forgets it), the harness page 404s app_utils.js, those symbols are
// undefined, and the E2E goes falsely RED. This gate is a pure static read of the
// .py source; ASCII-only. It mirrors tests/test_realpage_apputils_copylist.mjs but
// targets the TUPLE-style copy-list ("for _a in (...)") used by visual_http.
//
// A decoy strips "app_utils.js" from the copy-list line and proves the R1 assertion
// flips red (the lock is load-bearing, not decorative).
//
// Run: node tests/test_visual_apputils_copylist.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TESTS = dirname(fileURLToPath(import.meta.url));
const VP = join(TESTS, "test_visual_http_render.py");

let fails = 0;
const ok = (cond, label) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) fails++; };

const src = readFileSync(VP, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

// The copy-list for-loop header that stages the assets the page loads. Accept both
// bracket-list and tuple syntax so it survives a future reshaping of the literal.
const listLine = src.split("\n").find((l) => /^\s*for\s+\w+\s+in\s+[(\[][^)\]]*app\.js[^)\]]*[)\]]\s*:/.test(l));
ok(!!listLine, "V0 visual_http has an asset copy-list line referencing app.js");

const line = listLine || "";
// R1: the copy list must contain app_utils.js (the extracted app_utils chain).
ok(/["']app_utils\.js["']/.test(line), "R1 copy-list includes app_utils.js");
// R2: it still stages i18n.js + app.js too (the extraction must not have dropped a peer).
ok(/["']i18n\.js["']/.test(line) && /["']app\.js["']/.test(line), "R2 copy-list still has i18n.js + app.js");
// R3: app_utils.js is listed BEFORE app.js, mirroring index.html load order.
// Quote-bounded match so "app.js" never matches inside "app_utils.js".
const iu = line.indexOf('"app_utils.js"') >= 0 ? line.indexOf('"app_utils.js"') : line.indexOf("'app_utils.js'");
const ia = line.indexOf('"app.js"') >= 0 ? line.indexOf('"app.js"') : line.indexOf("'app.js'");
ok(iu >= 0 && ia >= 0 && iu < ia, "R3 app_utils.js precedes app.js in the copy list");

// ---- decoy: strip app_utils.js from the line -> R1 MUST flip red (load-bearing) ----
const stripped = line.replace(/["']app_utils\.js["'],?\s*/g, "");
ok(!/app_utils\.js/.test(stripped), "R1-DECOY stripping app_utils.js breaks the R1 lock");

console.log(fails === 0 ? "VISUAL-COPYLIST: ALL GREEN" : "VISUAL-COPYLIST: " + fails + " FAIL");
process.exit(fails === 0 ? 0 : 1);
