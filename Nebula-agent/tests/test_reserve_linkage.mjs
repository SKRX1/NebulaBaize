/* Lock the memCompactReservePct slider's LIVE drawer linkage so a future edit that
 * breaks the oninput wiring / the pinned-chunk disable rule goes RED:
 *   (a) dragging #s-memreserve on a SMALL window (16384) moves the AUTO chunk budget
 *       AND the <output> text in lockstep (the oninput=outputs() wiring is live);
 *   (b) pinning #s-memchunk>0 DISABLES + greys #s-memreserve (outputs() sets .disabled)
 *       and the budget == the pinned chunk (the ratio is bypassed); back to auto
 *       RE-ENABLES it.
 * Mirrors tests/test_mem_reserve_wiring.mjs (the proven jsdom boot of REAL app.js),
 * extended with real-DOM element assertions. Pure ASCII.
 *
 * Two ceilings shape the 16384 response (the formula's clamp band, NOT bugs):
 *   reserve = max(4096, maxCtx*pct)         -> <=25% all sit at the 4096 floor
 *   budget  = min(12000, max(2000, safe))   -> >=40% saturate at the 2000 floor
 * Strict monotonicity is therefore only measurable inside the band; we assert the
 * 30% > 40% pair (above the floor, at/into the budget floor) and record the 50%
 * saturation that answers "what does 50% do on a small window". */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8766/", runScripts: "outside-only" });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { memCompactChunkTokens, outputs, setSettings:(s)=>{settings=Object.assign({},settings,s);}, setMaxCtx:(v)=>{maxCtx=v;} };";
win.eval(appCode);
const api = win.__api;
const $ = (id) => win.document.getElementById(id);
api.setSettings({ memCompactChunkTokens: 0 });
api.setMaxCtx(16384);

let fails = 0;
const check = (l, c, x) => { console.log("  " + (c ? "OK   " : "FAIL ") + l + (x ? "  " + x : "")); if (!c) fails++; };

function dragReserve(pct) {
  $("s-memreserve").value = String(pct);
  api.setSettings({ memCompactReservePct: pct });
  api.outputs();
  return { budget: api.memCompactChunkTokens(), out: $("o-memreserve").textContent, dis: $("s-memreserve").disabled };
}

console.log("\n=== drag #s-memreserve (16384 small window): budget + <output> move live ===");
const r30 = dragReserve(30), r40 = dragReserve(40), r50 = dragReserve(50);
console.log("  [diag] 30%=" + r30.budget + " 40%=" + r40.budget + " 50%=" + r50.budget);
check("budget shrinks as reserve grows (30% > 40%, above the 4096 reserve floor)",
      r30.budget > r40.budget, r30.budget + ">" + r40.budget);
check("oninput=outputs wiring is live: <output> text mirrors the slider (30%->30%, 50%->50%)",
      r30.out === "30%" && r50.out === "50%", r30.out + "/" + r50.out);
check("reserve slider stays ENABLED in auto mode (chunk=0)", r30.dis === false && r50.dis === false);
check("50% on a 16384 window saturates at the 2000 budget floor (answers 'what does 50% do')",
      r50.budget === 2000, String(r50.budget));

console.log("\n=== pin #s-memchunk>0: reserve slider DISABLED (greyed) ===");
$("s-memchunk").value = "5000";
api.setSettings({ memCompactChunkTokens: 5000 });
api.outputs();
check("reserve slider disabled once chunk is pinned", $("s-memreserve").disabled === true, String($("s-memreserve").disabled));
check("chunk <output> shows pinned tok", $("o-memchunk").textContent === "5000 tok", $("o-memchunk").textContent);
check("budget == pinned chunk (reserve bypassed)", api.memCompactChunkTokens() === 5000, String(api.memCompactChunkTokens()));
$("s-memchunk").value = "0";
api.setSettings({ memCompactChunkTokens: 0 });
api.outputs();
check("reserve slider RE-ENABLED when back to auto", $("s-memreserve").disabled === false, String($("s-memreserve").disabled));

console.log("\nRESERVE-LINKAGE: " + (fails ? fails + " FAILED" : "ALL GREEN"));
process.exit(fails ? 1 : 0);
