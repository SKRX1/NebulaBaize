// tests/test_scroll_catchup_jsdom.mjs
// Contract: the boot bottom-catch-up inside setupAutoScroll re-sticks the chat to the bottom when
// #chat actually grew by >4px (the async sources: lazy images + IO-expanded archive cards) AND the
// view was bottom-pinned JUST BEFORE that growth. The bottom condition is `streamingFollow || pinned`:
//   - streamingFollow covers a live streaming turn;
//   - `pinned` (scrollTop sits at the PREVIOUS scrollHeight, tracked via a `lastSH` baseline that a
//     scroll event / a re-stick keeps current) covers the BOOT-SEND RACE -- right after a send,
//     renderChat's sync scrollDown(true) parks scrollTop at the THEN-current scrollHeight, but lazy
//     images / IO-expanded cards grow the transcript AFTERWARDS without firing a scroll event, so the
//     scroll listener never flips streamingFollow back ON. The view IS at the bottom yet streamingFollow
//     still reads false, so the old `&& streamingFollow`-only guard skipped the re-stick -> "won't
//     scroll to the newest message" on a long-history window.
//
// WHY A PRE-GROWTH BASELINE, NOT a live nearBottom(): inside the ResizeObserver callback the lazy
// image is ALREADY rendered, so s.scrollHeight has ALREADY grown and scrollTop (which never moved)
// now reads a freshly ENLARGED gap. A live nearBottom() there would say "not at bottom" exactly when
// the growth was biggest -- the judgment is backwards. D2 locks this: replacing the lastSH baseline
// with a live nearBottom() makes the T5 race case fail again.
//
// The reader invariant still holds: a user scrolled up to read mid-history has scrollTop well above
// lastSH - 120, so pinned is false and content growth leaves them untouched.
//
// jsdom ships no ResizeObserver, so the app's `typeof ResizeObserver !== "undefined"` guard skips the
// whole block at boot. We do NOT rely on jsdom's DOM for the observer: we extract the real
// setupAutoScroll body from app.js and run it against controlled stubs (a deterministic ResizeObserver
// stub we fire by hand), then assert the re-stick decision. This is the repo's established
// "extract-the-real-body + deterministic differential" pattern for race/CSS-geometry bugs jsdom
// cannot otherwise drive.
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
// anti-drift: the relaxed guard + the pre-growth baseline must be present in the shipped source.
ok("source-carries-pinned-relaxed-guard",
  /const pinned = s\.scrollTop >= lastSH - 120;/.test(body) &&
  /h > lastH \+ 4 && \(streamingFollow \|\| pinned\)/.test(body));

// ---- deterministic harness: run the extracted real body against controlled stubs.
// elScroll.scrollHeight is mutable so a test can "grow" the transcript between a scroll event and an
// observe-callback, mirroring lazy-image / archive-card async growth. addEventListener collects every
// scroll handler so fireScroll() can simulate a USER scroll (which resets the lastSH baseline).
function boot(opts, bodySrc) {
  bodySrc = bodySrc || body;
  const elChat = { _h: opts.bootH || 500, getBoundingClientRect() { return { height: this._h }; } };
  const elScroll = {
    scrollTop: opts.startScrollTop != null ? opts.startScrollTop : 0,
    scrollHeight: opts.scrollHeight || 1200,
    clientHeight: opts.client || 0,
    hidden: false,
    _scrollHandlers: [],
    addEventListener(_t, cb) { this._scrollHandlers.push(cb); },
  };
  function $(id) { return id === "chat" ? elChat : elScroll; }
  const holder = { v: !!opts.following };
  const nearBottom = () => (elScroll.scrollHeight - elScroll.scrollTop - elScroll.clientHeight) < 120;
  let captured = null;
  function ResizeObserver(cb) { captured = cb; this.observe = () => {}; this.disconnect = () => {}; }
  // eslint-disable-next-line no-new-func
  new Function("$", "streamingFollowRef", "nearBottom", "ResizeObserver",
    bodySrc.replace(/streamingFollow/g, "streamingFollowRef.v"))($, holder, nearBottom, ResizeObserver);
  return {
    fireCB: () => captured && captured(),
    fireScroll: () => elScroll._scrollHandlers.forEach((cb) => cb()),
    elChat, elScroll,
    set following(v) { holder.v = v; },
  };
}

// T1: following + real growth -> must re-stick (scrollTop jumps to scrollHeight)
{
  const h = boot({ following: true, startScrollTop: 1100, scrollHeight: 1200, client: 100 }); // gap=0 at boot
  h.elChat._h = 900; h.elScroll.scrollHeight = 1800;     // lazy image grew the transcript after the boot jump
  h.fireCB();
  ok("T1 following+grow -> restick to bottom", h.elScroll.scrollTop === 1800);
}

// T2 (reader guard, load-bearing): scrolled up to read mid-history (following=false) -> scroll event
// resets lastSH to current; then content grows; pinned stays false -> must NOT yank.
{
  const h = boot({ following: false, startScrollTop: 1200, scrollHeight: 1200, client: 100 }); // boot at bottom
  h.elScroll.scrollTop = 300; h.fireScroll();           // user scrolls UP to read (gap 800 > 120)
  h.elChat._h = 1500; h.elScroll.scrollHeight = 1500;   // content grows under them
  h.fireCB();
  ok("T2 scrolled-up reader -> leave alone", h.elScroll.scrollTop === 300);
}

// T3: following but only a sub-4px height jitter -> must NOT restick (noise band)
{
  const h = boot({ following: true, startScrollTop: 1100, scrollHeight: 1200, client: 100 });
  h.elChat._h = 502;                                    // +2 <= 4 threshold, no scrollHeight change
  h.fireCB();
  ok("T3 following+<=4px jitter -> no restick", h.elScroll.scrollTop === 1100);
}

// T4: no height growth (equal #chat height) -> no restick even while bottom-pinned
{
  const h = boot({ following: true, startScrollTop: 1100, scrollHeight: 1200, client: 100 });
  h.elChat._h = 500; h.elScroll.scrollHeight = 1800;     // scrollHeight moved but #chat height unchanged
  h.fireCB();
  ok("T4 #chat-no-grow -> no restick", h.elScroll.scrollTop === 1100);
}

// T5 (THE fix's target / boot-send race): following=FALSE (stream listener never flipped it on after
// the send) BUT the view is bottom-pinned (scrollTop sits at the pre-growth bottom) + async grow ->
// MUST re-stick. This is exactly what the old streamingFollow-only guard wrongly skipped.
{
  const h = boot({ following: false, startScrollTop: 1200, scrollHeight: 1200, client: 100 }); // renderChat left it at bottom
  h.elChat._h = 1800; h.elScroll.scrollHeight = 1800;     // lazy image grew AFTER send, no user scroll fired
  h.fireCB();
  ok("T5 bottom-pinned + NOT-following + grow -> restick (boot-send race)", h.elScroll.scrollTop === 1800);
}

// ---- decoy differentials: strip / swap one guard -> its case must flip to prove it is load-bearing
function strip(src, re) { const s = src.replace(re, ""); if (s === src) throw new Error("decoy anchor not found: " + re); return s; }

// D1: drop the `|| pinned` rescue -> T5 (not-following + bottom-pinned) regresses to the OLD bug
// (no restick). Proves the pinned clause is load-bearing.
{
  const noPinned = body.replace(/\(streamingFollow \|\| pinned\)/, "(streamingFollow)");
  if (noPinned === body) throw new Error('D1 swap produced no change');   // code-only paren token; comment writes it backtick-wrapped
  const h = boot({ following: false, startScrollTop: 1200, scrollHeight: 1200, client: 100 }, noPinned);
  h.elChat._h = 1800; h.elScroll.scrollHeight = 1800; h.fireCB();
  ok("D1 decoy(no pinned rescue) breaks T5 -> old bug", h.elScroll.scrollTop === 1200);
}

// D2: replace the pre-growth `lastSH` baseline with a LIVE nearBottom() (the tempting-but-wrong
// approach) -> T5 regresses, because at callback time the lazy image already grew scrollHeight, so
// the live gap (1800-1200-100=500) reads "not at bottom". Proves the PRE-GROWTH BASELINE, not a live
// nearBottom(), is what makes the fix correct.
{
  const liveBottom = strip(body, /s\.scrollTop >= lastSH - 120/);          // remove the lastSH compare
  const withLive = body.replace(/s\.scrollTop >= lastSH - 120/, "nearBottom()");
  // sanity: the two variants differ
  if (withLive === body) throw new Error("D2 swap produced no change");
  const h = boot({ following: false, startScrollTop: 1200, scrollHeight: 1200, client: 100 }, withLive);
  h.elChat._h = 1800; h.elScroll.scrollHeight = 1800; h.fireCB();
  ok("D2 decoy(live nearBottom not baseline) breaks T5 -> backwards", h.elScroll.scrollTop === 1200);
  // and with the live variant the reader invariant would WRONGLY break for a near-bottom-but-not reader?
  // not asserted; D2 only needs the T5 regression to prove the baseline is load-bearing.
}

// D3: drop the >4px noise band (force any-growth) -> T3 (sub-4px jitter) WOULD restick.
{
  const h = boot({ following: true, startScrollTop: 1100, scrollHeight: 1200, client: 100 }, body.replace("lastH + 4", "lastH"));
  h.elChat._h = 502; h.fireCB();
  ok("D3 decoy(no 4px band) breaks T3", h.elScroll.scrollTop === h.elScroll.scrollHeight);
}

console.log("\n%d passed, %d failed", pass, fail);
process.exit(fail ? 1 : 0);
