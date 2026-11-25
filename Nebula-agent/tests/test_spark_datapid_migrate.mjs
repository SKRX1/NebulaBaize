/* ROOT-CAUSE A MIGRATION gate (direction 1, 2026-11-01): migrateSparkDataPid() adds the missing
 * data-pid anchor to a bare-img historical note so sparkToPush re-attaches the image. Real app.js
 * functions via jsdom-boot (same method as test_wire_image_url.mjs), NOT a hand-stub.
 *
 * Differential pairs (the real net):
 *   PRE : bare-img note (no data-pid)  -> sparkToPush images=[]   (the shipped bug, bubble text-only)
 *   POST: same note after migrate      -> sparkToPush images=1     (bubble re-attaches the image)
 *   IDEMPOTENT: migrate an already-anchored note -> anchor count unchanged (no double data-pid).
 *
 * Run standalone: node tests/test_spark_datapid_migrate.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond) => { console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN")); if (!cond) FAILURES.push(label); };
const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks (immune to eval scope) -------------------------------------------
check("source: migrateSparkDataPid() is defined", /function migrateSparkDataPid\s*\(/.test(srcText));
check("source: it adds data-pid onto a bare img", /setAttribute\("data-pid",\s*"mig"/.test(srcText));
check("source: it skips already-anchored imgs (idempotent guard)", /hasAttribute\("data-pid"\)/.test(srcText));
check("source: it persists the array back via setSparks", /setSparks\(arr\)/.test(srcText));

// --- runtime boot: expose the live functions through a closure hook -----------------------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { migrateSparkDataPid, getSparks, setSparks, sparkToPush, mixedSegments, apiMessages, sanitizeHtml, setMessages: (x) => { messages = x; }, setLastRag: (x) => { lastRag = x; } };";
win.eval(appCode);
const api = win.__api;
check("migrateSparkDataPid boots", typeof api.migrateSparkDataPid === "function");
check("sparkToPush boots", typeof api.sparkToPush === "function");

const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// a historical note: body text + a BARE img (valid src, NO data-pid) — the old pre-anchor format
const bareNoteHtml = '图中渲染bug请修复<img class="inline-ce-img" src="' + DATA + '" alt="shot.png" title="shot.png">';

// seed localStorage-independent: write one note, run migrate, read back
const arr = [{ id: "n1", text: "图中渲染bug请修复", html: bareNoteHtml, tags: [], status: "pending" }];
api.setSparks(arr);
const changed = api.migrateSparkDataPid();
check("migrate: reports 1 note changed", changed === 1);

const migrated = api.getSparks().find((x) => x.id === "n1");
check("migrate: data-pid added onto the img", /data-pid="mig1"/.test(migrated.html));

// POST: same note now resolves through sparkToPush -> image re-attaches
const pushPost = api.sparkToPush({ html: migrated.html, text: "图中渲染bug请修复" });
check("POST migrate: sparkToPush images=1 (bubble re-attaches)", pushPost.images.length === 1);

// PRE baseline on a fresh bare note (no migrate) -> the shipped bug (bubble text-only)
api.setSparks([{ id: "n0", text: "t", html: bareNoteHtml, tags: [], status: "pending" }]);
const pushPre = api.sparkToPush({ html: api.getSparks()[0].html, text: "t" });
check("PRE migrate (bare, no anchor): sparkToPush images=[] (the shipped bug)", pushPre.images.length === 0);

// IDEMPOTENT: migrate the already-anchored note again -> anchor count must stay 1
api.setSparks([{ id: "n2", text: "t", html: migrated.html, tags: [], status: "pending" }]);
const changed2 = api.migrateSparkDataPid();
check("IDEMPOTENT: re-migrating an anchored note changes 0 notes", changed2 === 0);
const stillOne = (api.getSparks()[0].html.match(/data-pid=/g) || []).length;
check("IDEMPOTENT: anchor count unchanged after a second migrate", stillOne === 1);

console.log("\nROOTCAUSE-A-MIGRATE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
