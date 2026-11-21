/* Verify memCompactReservePct feeds the AUTO chunk budget: it bites on a SMALL
 * window (16384: bigger reserve -> smaller budget) and is inert on a LARGE window
 * (131072: the 12000 clamp saturates). Boots the REAL app.js in jsdom, sets maxCtx
 * via eval, and calls the exposed memCompactChunkTokens() under several ratios.
 * Pure ASCII. */
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
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { memCompactChunkTokens, setSettings:(s)=>{settings=Object.assign({},settings,s);}, setMaxCtx:(v)=>{maxCtx=v;} };";
win.eval(appCode);
const api = win.__api;
api.setSettings({ memCompactChunkTokens: 0 });   // AUTO mode so the reserve feeds the formula

let fails = 0;
const check = (l, c, x) => { console.log("  " + (c ? "OK   " : "FAIL ") + l + (x ? "  " + x : "")); if (!c) fails++; };

const at = (M, pct) => { api.setMaxCtx(M); api.setSettings({ memCompactReservePct: pct }); return api.memCompactChunkTokens(); };

console.log("\n=== small window 16384: reserve ratio DOES change the budget ===");
{
  const b30 = at(16384, 30), b40 = at(16384, 40);
  console.log("  [diag] 16384 -> 30%=" + b30 + "  40%=" + b40);
  check("16384: 30% > 40% (above the 4096 reserve floor, bigger reserve shrinks budget)", b30 > b40, b30 + ">" + b40);
}

console.log("\n=== large window 131072: reserve ratio is INERT (clamp saturates) ===");
{
  const b5 = at(131072, 5), b25 = at(131072, 25), b50 = at(131072, 50);
  console.log("  [diag] 131072 -> 5%=" + b5 + "  25%=" + b25 + "  50%=" + b50);
  check("131072: all ratios == 12000 (inert)", b5 === 12000 && b25 === 12000 && b50 === 12000);
}

console.log("\n=== pinned chunk overrides reserve (chunk>0 -> returns chunk) ===");
{
  api.setSettings({ memCompactChunkTokens: 5000, memCompactReservePct: 40 });
  api.setMaxCtx(16384);
  check("pinned 5000 wins over any reserve", api.memCompactChunkTokens() === 5000, String(api.memCompactChunkTokens()));
}

console.log("\n=== default 25 clamps out-of-range [5,50] ===");
{
  api.setSettings({ memCompactChunkTokens: 0 });
  const bLo = at(32768, 0), bHi = at(32768, 100);   // out-of-range inputs
  api.setSettings({ memCompactReservePct: 5 });  const b5 = at(32768, 5);
  api.setSettings({ memCompactReservePct: 50 }); const b50 = at(32768, 50);
  check("0 clamps to 5% (== explicit 5)", bLo === b5, bLo + "==" + b5);
  check("100 clamps to 50% (== explicit 50)", bHi === b50, bHi + "==" + b50);
}

console.log("\nMEM-RESERVE: " + (fails ? fails + " FAILED" : "ALL GREEN"));
process.exit(fails ? 1 : 0);
