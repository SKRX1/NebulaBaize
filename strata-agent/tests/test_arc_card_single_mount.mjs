/* Static source-lock for the triple-archive-card root-cause fix (2026-11-11).

What broke and what this test locks (the user's "after auto-compaction there are 3
收起归档正文 cards, only the topmost one is correct, the other two are redundant" report):

  ROOT-CAUSE: mountArchiveCard() mounted a card on EVERY message whose body text matched
  the archive-pointer regex. After compaction the messages array is [system-summary, ...tail];
  the system-summary carries the canonical pointer, but tail assistant answers that merely
  REPEATED the path (the model quoting ".strata-archive/<id>.md" in its own reply) each also
  matched -> extra cards. There is a per-bubble dedup guard, so this is not a render-dup; the
  gate itself was too wide.

  FIX: the mount gate is narrowed to ONLY the compaction-summary block, which is always
  role:"system" (see the compaction rebuild). The render wraps that message in st-msg--system,
  so the gate now returns early for everything that is NOT st-msg--system.

Static lock (reads the REAL app.js body; this page jsdom-boot-crashes so a source lock is the
reliable gate, same convention as test_arc_scrolltop_autoexpand.mjs):
  L1  POSITIVE: the mountArchiveCard gate returns for anything that is NOT st-msg--system
  L2  NEGATIVE: the old over-wide guard ("return for st-msg--user only") is GONE from the
      gate (differential: reverting the fix to the user-only guard turns this lock red ->
      L1 is load-bearing, not decorative)

Run: node tests/test_arc_card_single_mount.mjs
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

// ---- isolate the mountArchiveCard body up to the next top-level function declaration
const mStart = src.indexOf("function mountArchiveCard(");
if (mStart < 0) {
  console.log("ARC-CARD-SINGLE-MOUNT: FAIL  could not locate mountArchiveCard anchor");
  process.exit(1);
}
const mEnd = src.indexOf("\nasync function loadArchiveSeg", mStart);
const body = src.slice(mStart, mEnd < 0 ? mStart + 1200 : mEnd);

// isolate the guard region: from the gate function line to the first regex-match line
const gateEnd = body.indexOf("hay.match");
const gate = body.slice(0, gateEnd < 0 ? body.length : gateEnd);

console.log("ARC-CARD-SINGLE-MOUNT:");

// L1 POSITIVE: the gate keeps only the compaction-summary block (st-msg--system)
check("L1 gate returns for everything that is NOT st-msg--system",
  /if\s*\(\s*!\s*el\.classList\.contains\(\s*"st-msg--system"\s*\)\s*\)\s*return/.test(gate));

// L2 NEGATIVE (differential): the old over-wide "return only for st-msg--user" guard is gone
// from the gate. Reverting the fix to that guard turns this lock red -> L1 is load-bearing.
check('L2 old over-wide user-only guard is GONE from the gate',
  !/classList\.contains\(\s*"st-msg--user"\s*\)\s*\)\s*return/.test(gate));

// ---- summary
console.log("");
if (FAILURES.length) {
  console.log("ARC-CARD-SINGLE-MOUNT: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("ARC-CARD-SINGLE-MOUNT: ALL GREEN");
  process.exit(0);
}
