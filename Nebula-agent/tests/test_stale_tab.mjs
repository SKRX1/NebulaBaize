/* Regression test for the stale-tab guard (2026-10-20).
 *
 * A tab opened before a frontend update keeps running the OLD app.js forever (no-cache only helps
 * at load time) — that is how "I fixed it but the UI still behaves old" happens. The gateway now
 * stamps every /models/config response with the build id it actually serves; the frontend compares
 * it against its own window.__strataBuild on every 4s poll and reloads itself once when they differ.
 *
 * Asserts:
 *   1. build mismatch -> sessionStorage one-shot flag set + reload attempted + toast shown
 *   2. build match     -> nothing happens (no flag, no reload)
 *
 * Run: node tests/test_stale_tab.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM, VirtualConsole } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

function makeDom(serverBuild) {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  // jsdom cannot navigate; a reload attempt surfaces as a "jsdomError: Not implemented: navigation"
  // on the virtual console. Counting those IS counting reload attempts.
  const vc = new VirtualConsole();
  let navErrors = 0;
  vc.on("jsdomError", (e) => { if (/navigation/i.test(String(e && e.message))) navErrors++; });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only", virtualConsole: vc });
  const win = dom.window;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 131072 }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    if (u.includes("models/config")) return { ok: true, status: 200, json: async () => ({ selected: "iq3-s", models: [], probe: null, build: serverBuild }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  return { dom, win, navErrors: () => navErrors };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== stale-tab guard regression ===");
  await sleep(30);

  // 1) server serves a DIFFERENT build -> this tab is stale
  const A = makeDom("some-newer-build/2099-01-01-r9");
  await sleep(900);                       // the reload fires 600ms after the poll that noticed
  check("mismatch -> one-shot reload flag set",
    A.win.sessionStorage.getItem("strata.build.reloaded") === "1",
    JSON.stringify(A.win.sessionStorage.getItem("strata.build.reloaded")));
  check("mismatch -> reload was attempted", A.navErrors() >= 1, `navErrors=${A.navErrors()}`);

  // 2) server serves the SAME build -> nothing happens
  const B = makeDom("compact-chunked/2026-10-20-r1");
  await sleep(900);
  check("match -> no reload flag", B.win.sessionStorage.getItem("strata.build.reloaded") === null);
  check("match -> no reload", B.navErrors() === 0, `navErrors=${B.navErrors()}`);

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); A.win.close(); B.win.close(); process.exit(1); }
  console.log("STALE-TAB: ALL PASSED");
  A.win.close(); B.win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
