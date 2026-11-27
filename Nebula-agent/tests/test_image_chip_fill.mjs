/* Behaviour sentinel: image-page resolution chips fill the W/H inputs.
 *
 * The "image_e2e_sentinel family" jsdom-behaviour member (siblings: the static tier-lock
 * test_image_default_tier_static.mjs in the quick tier, and the live gateway POST gate
 * tools/image_e2e_sentinel.py in the slow tier). This one drives the REAL click handler in
 * jsdom and asserts the engine-visible W/H inputs update — so a broken chip->input wiring is
 * caught as behaviour, not just as static text.
 *
 * Single-variable differential (the ONLY thing that changes between scenes is WHICH chip is
 * clicked; the observable is the resulting #img-width value):
 *   BOOT                 -> 512 (the default tier4; ladder now starts at 32=tier0, NOT 512)
 *   CLICK 768 chip (tier5) -> #img-width = 768   (a tier that DIFFERS from boot)
 *   CLICK 512 chip back (tier4) -> #img-width = 512   (two-way: clicking back restores the boot value)
 * LOAD-BEARING: boot is already 512, so a naive "click 512 -> 512" would pass even if the
 * wiring were dead. The 768 scene is what makes it real: if the delegated click handler did not
 * run, #img-width would STAY 512 and the 768 scene would fail. The 512-back scene then closes
 * the loop (the value moved off 512 and came back), proving the inputs track the clicked chip.
 *
 * NOTE (2026-11-14 alignment): chips are keyed by data-imgres tier, and the ladder starts at
 * tier0=32; 512 is tier4 and 768 is tier5. Earlier this test clicked data-imgres="1"/"0" assuming
 * they mapped to 768/512 (true in the pre-expansion ladder); after the expansion tier0=32/tier1=64
 * so those clicks filled 64/32 and broke. We now click the REAL tier5(768) and tier4(512) chips.
 *
 * jsdom setup matches test_app_regen.mjs (full boot so every $("id") exists; matchMedia/raf/
 * EventSource polyfills; explicit win.close() teardown so the process exits instead of hanging).
 *
 * Run: node tests/test_image_chip_fill.mjs
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
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") {
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
}
if (typeof win.cancelAnimationFrame !== "function") {
  win.cancelAnimationFrame = (id) => clearTimeout(id);
}
// app.js boot calls initSessionStream() which news an EventSource; jsdom has none. A no-op stub
// keeps the boot path quiet (the test never relies on the SSE stream).
win.EventSource = class { constructor() {} close() {} addEventListener() {} };
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// boot the app (the chip->W/H wiring lives in an IIFE inside app.js)
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chip = (tier) => doc.querySelector(`#img-res-row [data-imgres="${tier}"]`);
const wh = () => ({ w: doc.getElementById("img-width").value, h: doc.getElementById("img-height").value });

const main = async () => {
  console.log("=== image chip -> W/H fill (single-variable differential) ===");
  await sleep(30);   // let boot settle

  check("768 chip present (tier5)", !!chip("5"), "data-imgres=5");
  check("512 chip present (tier4)", !!chip("4"), "data-imgres=4");

  // control: boot default is 832x1216 (raised from 512 on 2026-11-27; the res-chip LADDER default is still tier4=512)
  check("boot inputs are 832x1216 (control)", wh().w === "832" && wh().h === "1216", JSON.stringify(wh()));

  // scene A: click the 768 chip (tier5) -> inputs move OFF 512 to 768 (load-bearing: a dead handler
  // would leave them at the 512 boot value, failing this assertion)
  chip("5").click();
  await sleep(10);
  check("click 768 chip fills W/H=768", wh().w === "768" && wh().h === "768", JSON.stringify(wh()));
  const active768 = chip("5").classList.contains("is-active") && !chip("4").classList.contains("is-active");
  check("active class moved to the 768 chip", active768);

  // scene B: click the 512 chip back (tier4) -> inputs restore the boot value (two-way, closes the loop)
  chip("4").click();
  await sleep(10);
  check("click 512 chip fills back W/H=512", wh().w === "512" && wh().h === "512", JSON.stringify(wh()));

  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    win.close();
    process.exit(1);
  }
  console.log("IMAGE CHIP-FILL SENTINEL: ALL PASSED");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
