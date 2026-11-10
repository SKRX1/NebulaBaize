/* Static source-lock for the plan-A scroll-top auto-expand (2026-11-11 root-cause fix).

What broke and what this test locks (the user's "drag the scrollbar to the very top and
I still cannot see the retained 5% history body" report):

  ROOT-CAUSE B (the load-bearing one): the scroll-top sentinel IntersectionObserver had
  `root: $("chat")`, but #chat is NOT the scroll container (its child #chat-scroll is, see
  app.css `.chat-scroll { overflow-y:auto }`). A root that is not a scrollable ancestor is
  ignored and degrades to the document viewport, so cards entering the #chat-scroll viewport
  never fired the sentinel -> auto-load was unreliable. FIX: root must be `$("chat-scroll")`.

  ROOT-CAUSE C (secondary): even when the sentinel fired, the card body stayed collapsed
  (hidden) with the button stuck on "Expand", so it read as "nothing there". FIX: on a
  sentinel hit, autoExpandCard() expands the body + flips the label to "Collapse".

Static lock (reads the REAL app.js body; jsdom behavioural tests boot-crash on this page so a
source lock is the reliable gate here):
  L1  the sentinel IntersectionObserver root references chat-scroll (the true scroller)
  L2  the sentinel hit branch calls BOTH loadArchiveSeg AND autoExpandCard (hit -> auto-expand)
  L3  autoExpandCard exists and un-hides the body (body.hidden = false)
  L4  autoExpandCard flips the button label to the collapse key (expand-state visual parity)
  L5  NEGATIVE: the old buggy root `$("chat")` for the observer is GONE (guards a revert)

Run: node tests/test_arc_scrolltop_autoexpand.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// ---- isolate the _arcIO factory body so assertions target the SENTINEL, not other observers
const ioStart = src.indexOf("function _arcIO()");
const mountStart = src.indexOf("function mountArchiveCard(");
if (ioStart < 0 || mountStart < 0 || mountStart <= ioStart) {
  console.log("ARC-SCROLLTOP-AUTOEXPAND: FAIL  could not locate _arcIO / mountArchiveCard anchors");
  process.exit(1);
}
const ioBody = src.slice(ioStart, mountStart);

// ---- isolate the autoExpandCard body (up to the next top-level function decl)
const aeStart = src.indexOf("function autoExpandCard(");
if (aeStart < 0) {
  console.log("ARC-SCROLLTOP-AUTOEXPAND: FAIL  autoExpandCard() not found");
  process.exit(1);
}
const aeEnd = src.indexOf("\n}", aeStart);
const aeBody = src.slice(aeStart, aeEnd < 0 ? aeStart + 600 : aeEnd + 2);

console.log("ARC-SCROLLTOP-AUTOEXPAND:");

// L1: sentinel observer root is the TRUE scroller (#chat-scroll), referenced via $()
check("L1 sentinel root references chat-scroll",
  /root:\s*\$\(\s*"chat-scroll"\s*\)/.test(ioBody), "found in _arcIO body");

// L2: sentinel hit branch calls BOTH the data loader AND the auto-expand (hit -> auto-expand)
check("L2 sentinel hit calls loadArchiveSeg AND autoExpandCard",
  /loadArchiveSeg\(\s*host\s*\)/.test(ioBody) && /autoExpandCard\(\s*host\s*\)/.test(ioBody));

// L3: autoExpandCard un-hides the body (body.hidden = false)
check("L3 autoExpandCard un-hides the body",
  /\.hidden\s*=\s*false/.test(aeBody));

// L4: autoExpandCard flips the button label to the collapse key (expand-state parity with click)
check("L4 autoExpandCard flips label to the collapse i18n key",
  /collapse/.test(aeBody) && /chat\.archive\.collapse/.test(aeBody));

// L5 NEGATIVE: the observer must NOT point root at $("chat") anymore (guards a revert to the bug)
check("L5 root is NOT the old buggy $(\"chat\")",
  !/root:\s*\$\(\s*"chat"\s*\)/.test(ioBody));

// ---- summary
console.log("");
if (FAILURES.length) {
  console.log("ARC-SCROLLTOP-AUTOEXPAND: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("ARC-SCROLLTOP-AUTOEXPAND: ALL GREEN");
  process.exit(0);
}
