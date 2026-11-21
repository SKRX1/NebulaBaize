/* Behaviour gate (2026-11-15): seed-book rows must support PER-ROW single delete (X),
 * not only the bulk Clear; and the count field is now a number INPUT defaulting to 1
 * (was a 1/2/4 select). Locks:
 *   A) static: index.html #img-count is <input type=number> value=1 (min>=1);
 *      app.js renderSeedbook DEFINES the per-row del button (data-del) and the delegate
 *      checks [data-del] BEFORE the refill branch (order is load-bearing: X lives inside
 *      a .img-seedbook-item, so a refill-first delegate would delete-then-refill);
 *      app.css styles the seed-book X (shared selector now includes .img-seedbook-del).
 *   B) jsdom behaviour: seed two rows -> click X on row 0 deletes ONLY row 0 (the other
 *      survives, order kept); click the surviving row (not the X) refills #img-seed.
 *   C) localStorage empty -> the empty placeholder shows (delete-last lands on the honest
 *      empty state, the "deleted everything = nothing happened" bug class).
 * Run standalone: node tests/test_seedbook_single_delete.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label);
  if (!cond) FAILURES.push(label);
};

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

// --- A) static locks ---------------------------------------------------------------
check("A1: #img-count is a number input defaulting to 1",
  /id="img-count"[^>]*type="number"[^>]*value="1"/.test(html) ||
  /type="number"[^>]*id="img-count"/.test(html));
check("A2: renderSeedbook builds the per-row del button (data-del)",
  /function\s+renderSeedbook[\s\S]*?data-del/.test(src));
check("A3: the seed-book delegate checks [data-del] BEFORE the refill branch",
  (() => {
    const m = src.match(/if \(\$\("img-seedbook"\)\) \$\("img-seedbook"\)\.onclick[\s\S]*?\n\};/);
    if (!m) return false;
    const d = m[0].indexOf("[data-del]"), r = m[0].indexOf(".img-seedbook-item");
    return d >= 0 && r >= 0 && d < r;
  })());
check("A4: CSS styles the seed-book X (shared selector)", /\.img-promptbook-del[^{]*\.img-seedbook-del[^{]*\{/.test(css));

// --- B) jsdom behaviour ------------------------------------------------------------
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only", storageQuota: 100000 });
const win = dom.window;
const doc = win.document;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { renderSeedbook, seedbookLoad };";
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);
const api = win.__api;

win.localStorage.setItem("strata.imgSeedBook", JSON.stringify([
  { seed: 111, prompt: "first prompt", ts: 1 },
  { seed: 222, prompt: "second prompt", ts: 2 },
]));
api.renderSeedbook();
const ul = doc.getElementById("img-seedbook");
check("B0: two rows rendered", ul && ul.querySelectorAll(".img-seedbook-item").length === 2);

// click the X on row 0 -> ONLY row 0 goes away (load-bearing: single delete, not bulk)
const x0 = ul.querySelector('.img-seedbook-item [data-del="0"]');
check("B1: row 0 carries a del button", !!x0);
x0.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const kept = api.seedbookLoad();
check("B2: after X on row 0, exactly 1 entry survives", Array.isArray(kept) && kept.length === 1);
check("B3: the SURVIVOR is row 1 (single delete, order kept)", kept[0] && kept[0].seed === 222);
check("B4: the store was rewritten (localStorage mirrors the delete)",
  (() => { try { const a = JSON.parse(win.localStorage.getItem("strata.imgSeedBook")); return Array.isArray(a) && a.length === 1 && a[0].seed === 222; } catch (e) { return false; } })());
check("B5: re-render shows exactly one row", ul.querySelectorAll(".img-seedbook-item").length === 1);

// click the surviving ROW (not the X) -> refills the seed box (refill path intact)
const row = ul.querySelector(".img-seedbook-item");
row.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("B6: plain row-click still refills #img-seed", doc.getElementById("img-seed").value === "222");

// --- C) delete the last row -> honest empty state ----------------------------------
const x = ul.querySelector('.img-seedbook-item [data-del="0"]');
x.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
check("C1: last row deleted -> store is an EMPTY ARRAY (real intent, not a no-op)", api.seedbookLoad().length === 0);
check("C2: the empty placeholder shows", !!ul.querySelector(".img-seedbook-empty"));

console.log("\nSEEDBOOK-SINGLE-DELETE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
