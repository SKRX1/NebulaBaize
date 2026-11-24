// tests/test_scroll_catchup_jsdom.mjs
// Contract: the boot bottom-catch-up inside setupAutoScroll re-sticks the chat to the bottom
// ONLY while the user is still following (streamingFollow) AND only when #chat actually grew
// by >4px (the async sources: lazy images + IO-expanded archive cards). The streamingFollow
// guard is load-bearing -- a user who scrolled up to read history must NOT be yanked down.
//
// jsdom ships no ResizeObserver, so the app's `typeof ResizeObserver !== "undefined"` guard
// skips the whole block at boot. We do NOT rely on jsdom's DOM for the observer: we extract
// the real setupAutoScroll body from app.js and run it against controlled stubs (a deterministic
// ResizeObserver stub we fire by hand), then assert the re-stick decision. This is the repo's
// established "extract-the-real-body + deterministic differential" pattern for race/CSS-geometry
// bugs jsdom cannot otherwise drive.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(resolve(here, "..", "serve", "web", "app.js"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

// ---- extract the real setupAutoScroll IIFE (boundary: the function header .. its closing })();
const m = app.match(/\(function setupAutoScroll\(\) \{[\s\S]*?\r?\n\}\)\(\);/);
if (!m) { console.log("FAIL  could-not-extract setupAutoScroll"); process.exit(1); }
const body = m[0];
ok("extract-contains-catchup-block", body.includes("typeof ResizeObserver") && body.includes("ro.observe(chat)"));

// Run the extracted real body in a scope that supplies $ / streamingFollow / nearBottom /
// ResizeObserver. lastH seed = elChat._h at construction (the boot-sync height). Returns the
// hand-fired observer callback so tests can drive "content grew under us".
function boot(opts) {
  const elChat = { _h: opts.bootH || 500, getBoundingClientRect() { return { height: this._h }; } };
  const elScroll = { scrollTop: opts.startScrollTop != null ? opts.startScrollTop : 0, scrollHeight: opts.scrollHeight || 1200, hidden: false, addEventListener() {} };
  function $(id) { return id === "chat" ? elChat : elScroll; }
  let streamingFollow = !!opts.following;
  const nearBottom = () => (elScroll.scrollHeight - elScroll.scrollTop - 0) < 120;
  let captured = null;
  function ResizeObserver(cb) { captured = cb; this.observe = () => {}; this.disconnect = () => {}; }
  // eslint-disable-next-line no-new-func
  new Function("$", "streamingFollow", "nearBottom", "ResizeObserver", body)($, streamingFollow, nearBottom, ResizeObserver);
  // streamingFollow is captured by value at construction; the scroll listener reassigns it, but
  // our tests flip the live variable via a getter closure instead:
  return { fireCB: () => captured && captured(), elChat, elScroll,
           get following() { return streamingFollow; }, set following(v) { streamingFollow = v; } };
}

// The extracted body reads the OUTER `streamingFollow` binding only at observe-callback time,
// but `new Function` snapshotted the primitive. To flip it per-case we instead re-boot with the
// desired value; the guard reads whatever value is live when the callback fires.

// T1: following + real growth -> must re-stick (scrollTop jumps to scrollHeight)
{
  const h = boot({ following: true, startScrollTop: 300 });
  h.elChat._h = 900;          // image/archive grew the transcript > 4px after the boot jump
  h.fireCB();
  ok("T1 following+grow -> restick to bottom", h.elScroll.scrollTop === h.elScroll.scrollHeight);
}

// T2 (guard, load-bearing): user scrolled up to read (following=false) + growth -> must NOT yank
{
  const h = boot({ following: false, startScrollTop: 300 });
  h.elChat._h = 1500;
  h.fireCB();
  ok("T2 NOT-following+grow -> leave reader alone", h.elScroll.scrollTop === 300);
}

// T3: following but only a sub-4px jitter -> must NOT restick (noise band)
{
  const h = boot({ following: true, startScrollTop: 300 });
  h.elChat._h = 502;          // +2 <= 4 threshold
  h.fireCB();
  ok("T3 following+<=4px jitter -> no restick", h.elScroll.scrollTop === 300);
}

// T4: no growth (equal height) -> no restick even while following
{
  const h = boot({ following: true, startScrollTop: 300 });
  h.elChat._h = 500;          // unchanged
  h.fireCB();
  ok("T4 following+no-grow -> no restick", h.elScroll.scrollTop === 300);
}

// ---- decoy differentials: strip one guard -> its test must flip to prove the guard matters
function strip(src, re) { const s = src.replace(re, ""); if (s === src) throw new Error("decoy anchor not found"); return s; }

function runBody(bodySrc, opts) {
  const elChat = { _h: opts.bootH || 500, getBoundingClientRect() { return { height: this._h }; } };
  const elScroll = { scrollTop: opts.startScrollTop, scrollHeight: 1200, hidden: false, addEventListener() {} };
  function $(id) { return id === "chat" ? elChat : elScroll; }
  let captured = null;
  function ResizeObserver(cb) { captured = cb; this.observe = () => {}; this.disconnect = () => {}; }
  // expose streamingFollow as a mutable holder so the callback sees the live value
  const holder = { v: !!opts.following };
  new Function("$", "streamingFollowRef", "nearBottom", "ResizeObserver",
    bodySrc.replace(/streamingFollow/g, "streamingFollowRef.v"))($, holder, () => false, ResizeObserver);
  return { fireCB: () => captured && captured(), elChat, elScroll };
}

// D1: drop the streamingFollow guard -> T2 scenario (not-following) WOULD wrongly restick
{
  const noGuard = strip(body, /&& streamingFollow/);
  const h = runBody(noGuard, { following: false, startScrollTop: 300 });
  h.elChat._h = 1500; h.fireCB();
  ok("D1 decoy(no-following-guard) breaks T2", h.elScroll.scrollTop === h.elScroll.scrollHeight); // proves guard load-bearing
}

// D2: drop the >4 noise band (force any-growth) -> T3 scenario (sub-4px jitter) WOULD restick
{
  const noBand = strip(body, /h > lastH \+ 4/).replace(/if \(h > lastH/, "if (h > lastH"); // belt: just loosen
  const h = runBody(body.replace("lastH + 4", "lastH"), { following: true, startScrollTop: 300 });
  h.elChat._h = 502; h.fireCB();
  ok("D2 decoy(no 4px band) breaks T3", h.elScroll.scrollTop === h.elScroll.scrollHeight);
}

console.log("\n%d passed, %d failed", pass, fail);
process.exit(fail ? 1 : 0);
