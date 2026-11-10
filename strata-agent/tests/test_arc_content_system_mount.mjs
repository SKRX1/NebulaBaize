/* Static source-lock for the C fix (2026-11-11): a content-only system compaction block must
   render VISIBLE text AND mount the archive card.

What broke and what this test locks (the user's "the top shows no card at all" report):

  ROOT-CAUSE: two field-asymmetry bugs on the compaction-summary block, which is always
  {role:"system", content:...} with NO .text:
    (1) answerSpec() rendered only m.text -> the bubble painted BLANK for that block.
    (2) the archive-pointer gate required `activeSession().workspace` as a HARD condition, so
        an empty-workspace session short-circuited the whole archive -> no pointer in the body
        -> the mount regex never matched -> NO card. (The card itself reads m.text||m.content,
        so it only mounts when a pointer text actually exists in the body.)

  FIX (C = both):
    A  answerSpec text source is `m.text || m.content || ""` (assistant turns still have .text,
       so they are unaffected; only the content-only system block is rescued -> visible text).
    B  the pointer gate drops the workspace hard-condition; abase falls back to the FS_ROOT root,
       and write+read paths gain a matching empty-guard so they resolve to the SAME file.

Static lock (reads the REAL app.js body; this page jsdom-boot-crashes so a source lock is the
reliable gate, same convention as test_arc_card_single_mount.mjs / test_arc_scrolltop_autoexpand.mjs).
Each POSITIVE lock is paired with a NEGATIVE differential: the reverted (buggy) form is asserted
GONE, so reverting any single fix turns THIS lock red -> every lock is load-bearing, not decorative.

Run: node tests/test_arc_content_system_mount.mjs
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
const slice = (startMarker, endMarker) => {
  const a = src.indexOf(startMarker);
  if (a < 0) return null;
  const b = src.indexOf(endMarker, a + startMarker.length);
  return src.slice(a, b < 0 ? a + 1600 : b);
};

console.log("ARC-CONTENT-SYSTEM-MOUNT:");

// ---- A: answerSpec text source must fall back to content (assistant .text unaffected)
const spec = slice("function answerSpec(m) {", "\nfunction mdNode(");
check("A1 answerSpec text source = m.text || m.content",
  spec && /const\s+text\s*=\s*m\.text\s*\|\|\s*m\.content\s*\|\|\s*""/.test(spec));
// A2 NEGATIVE differential: the reverted text-only form (no content fallback) must be GONE.
check("A2 reverted text-only answerSpec source is GONE (differential)",
  spec && !/const\s+text\s*=\s*m\.text\s*\|\|\s*""/.test(spec));

// ---- B: the pointer gate must NOT require workspace as a hard condition
const gate = slice("if (settings.archiveOn && dropped.length && activeSession()) {",
  "\n      const aid =");
check("B1 pointer gate drops the workspace hard-condition", gate !== null);
check("B2 abase falls back to an empty base (FS_ROOT root) via || \"\"",
  gate && /const\s+abase\s*=\s*\(activeSession\(\)\.workspace\s*\|\|\s*""\)/.test(gate));
// B3 NEGATIVE differential: the old `&& activeSession().workspace` hard-gate must be GONE in the gate region.
check("B3 workspace hard-condition is GONE from the gate (differential)",
  gate && !/&&\s*activeSession\(\)\.workspace\s*\)/.test(gate));

// ---- B-symmetry: write path must carry the same empty-guard as the read path so an empty
//      workspace resolves to the SAME file both ways (write+read zero-loss contract).
check("C1 fsWrite path uses the empty-guard ternary",
  /await\s+fsWrite\(`\$\{abase\s*\?\s*abase\s*\+\s*"\/"\s*:\s*""\}\.strata-archive\/\$\{aid\}\.md`/.test(src));
// C2 NEGATIVE differential: the old bare `${abase}/.strata-archive/` write path (no ternary) is GONE.
check("C2 old bare ${abase}/ write path is GONE (differential)",
  !/fsWrite\(`\$\{abase\}\/\.strata-archive\//.test(src));

// ---- summary
console.log("");
if (FAILURES.length) {
  console.log("ARC-CONTENT-SYSTEM-MOUNT: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("ARC-CONTENT-SYSTEM-MOUNT: ALL GREEN");
  process.exit(0);
}
