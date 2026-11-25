/* Regression test for keeping a turn's BOTTOM content above the composer (2026-10-20).

Report: "流式输出时，底部徽标跑到对话框下面了，不应该被遮挡" — the stats footer / next-step chips of a
streaming turn were sitting half-hidden under the composer.

Root cause was NOT z-index (measured live: the scroll container's bottom edge == the composer's top
edge, no overlap). The auto-follow aimed at the streaming TEXT TAIL only, so everything the turn
renders BELOW that tail — the next-step chips and the `.st-msg__meta` stats footer — stayed under the
fold. Worse, the turn-final `scrollDown()` took the idle branch, which only snaps when already "near
bottom" (120px); a chips block is taller than that window, so the half-cut row was permanent.

Boots the REAL index.html + i18n.js + app.js in jsdom (with a stubbed layout, since jsdom has no
engine) and locks the contract:

  Follow target  while streaming, the scroll aims at the whole `.st-msg` (its bottom = newest content),
                 NOT at the text tail. A tail-only aim leaves the footer below the fold.
  Pause wins     scrolling up (streamingFollow=false) must never be yanked back down.
  Idle gap       the idle branch does NOT close a >120px gap (that is exactly why the footer stayed
                 cut) while settleBottom() does.
  Tall host      a message taller than the viewport scrolls to its END, never to its top.

Run: node tests/test_bottom_anchor.mjs
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

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode + `
;window.__api = {
  scrollDown, settleBottom, revealNode, liveTailEl,
  setBusy: (v) => { busy = v; },
  setFollow: (v) => { streamingFollow = v; },
  getFollow: () => streamingFollow,
  setMessages: (v) => { messages = v; },
  nearBottom,
};`);
const api = win.__api;

// ---- a fake layout: jsdom has no layout engine, so answer the few rects the code asks for -------
// Rect bottoms are DOCUMENT-space and are projected through the live scrollTop, exactly like a real
// browser: scrolling down moves the content up. Without that, a second revealNode() would keep
// scrolling forever and the test would "fail" for a reason the real page never has.
const FOLD = 600, VIEW = 600;                  // the scroll viewport: bottom edge == composer top
const LAYOUT = { msgBottom: 900, tailBottom: 500 };
win.Element.prototype.getBoundingClientRect = function () {
  const cls = String(this.className || "");
  const st = (win.document.getElementById("chat-scroll") || {}).scrollTop || 0;
  if (this.id === "chat-scroll") return { top: 0, bottom: FOLD, height: VIEW, left: 0, right: 800, width: 800 };
  if (cls.includes("st-msg")) return { top: LAYOUT.msgBottom - 1200 - st, bottom: LAYOUT.msgBottom - st, height: 1200 };
  if (cls.includes("seg")) return { top: LAYOUT.tailBottom - 100 - st, bottom: LAYOUT.tailBottom - st, height: 100 };
  return { top: 0 - st, bottom: 0 - st, height: 0, left: 0, right: 0, width: 0 };
};
const scrollEl = win.document.getElementById("chat-scroll");
Object.defineProperty(scrollEl, "scrollHeight", { value: 1000, configurable: true });

// one assistant message: [.ans > .seg] then the footer `.st-msg__meta`
const chat = win.document.getElementById("chat");
const msgEl = win.document.createElement("div");
msgEl.className = "st-msg";
msgEl.dataset.i = "0";
msgEl.innerHTML = `<div class="ans"><p class="seg">streaming…</p></div><div class="st-msg__meta">footer</div>`;
chat.appendChild(msgEl);
const msg = { role: "assistant", text: "streaming…", tools: [], stats: null };
api.setMessages([msg]);

const reset = () => { scrollEl.scrollTop = 0; api.setBusy({ msg }); api.setFollow(true); };

console.log("BOTTOM ANCHOR (footer stays above the composer):");

// T1 -- while streaming, the aim is the MESSAGE bottom, not the text tail
{
  reset();
  const tail = api.liveTailEl();
  check("liveTailEl still points at the text tail", tail && tail.className === "seg", tail && tail.className);
  const tailOver = LAYOUT.tailBottom - (FOLD - 12);        // the OLD aim would scroll by this
  check("old aim needed no scroll (tail already above the fold)", tailOver <= 0, String(tailOver));
  api.scrollDown();
  const want = LAYOUT.msgBottom - (FOLD - 12);             // NEW aim: message bottom 12px above the fold
  check("streaming aim uses the message bottom", scrollEl.scrollTop === want,
        `scrollTop=${scrollEl.scrollTop} want=${want}`);
  check("a tail-only aim would have left the footer cut", tailOver <= 0 && want > 0,
        "proves the regression can only be fixed by aiming lower");
}

// T2 -- a user who scrolled up to read is never yanked back
{
  reset();
  api.setFollow(false);
  api.scrollDown();
  check("paused follow: no scroll while streaming", scrollEl.scrollTop === 0, String(scrollEl.scrollTop));
  api.setBusy(null);
  api.scrollDown();
  check("paused follow: no scroll when idle either", scrollEl.scrollTop === 0, String(scrollEl.scrollTop));
}

// T3 -- the idle branch leaves a >120px gap open; settleBottom() closes it
{
  scrollEl.scrollTop = 0;                                  // 1000 - 0 - 600 = 400px from the bottom
  api.setBusy(null);
  api.setFollow(true);
  check("idle gap is bigger than the 120px window", !api.nearBottom());
  api.scrollDown();
  check("idle scrollDown() leaves the footer cut (the old behaviour)",
        scrollEl.scrollTop === 0, `scrollTop=${scrollEl.scrollTop}`);
  api.settleBottom();
  check("settleBottom() snaps to the real bottom", scrollEl.scrollTop === 1000, String(scrollEl.scrollTop));
  check("follow state preserved", api.getFollow() === true);
}

// T4 -- settleBottom() obeys the same pause rule
{
  scrollEl.scrollTop = 0;
  api.setFollow(false);
  api.settleBottom();
  check("settleBottom(): no snap while the user reads history", scrollEl.scrollTop === 0, String(scrollEl.scrollTop));
}

// T5 -- a message taller than the viewport scrolls to its END, never to its top
{
  reset();
  api.revealNode(msgEl, scrollEl);
  check("tall host: scrolled down to its bottom", scrollEl.scrollTop > 0, String(scrollEl.scrollTop));
  const up = scrollEl.scrollTop;
  api.revealNode(msgEl, scrollEl);
  check("tall host: never yanked back to its top", scrollEl.scrollTop === up);
}

// ---------- summary --------------------------------------------------------------
if (FAILURES.length) {
  console.log(`\nBOTTOM ANCHOR: ${FAILURES.length} FAILED`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("\nBOTTOM ANCHOR: ALL PASSED");
  process.exit(0);
}
