/* Differential gate: the image-viewer CARD must HUG its content (no fixed near-full-width box).
 *
 * Reported bug 2026-11-03 (visual): double-clicking a thumbnail to open the original in the viewer
 * showed the picture surrounded by large, useless empty margins -- "extra stretched space that is
 * not part of the actual image". Root cause read from source: .img-viewer__card had a FIXED width
 * `width:min(92vw,1100px)` and body used flex-center, so a SMALL original got padded by huge blanks.
 * The img itself was NEVER deformed (object-fit:contain + max-*, no !important override anywhere).
 * Fix = card hugs content (`width:fit-content`) with an UPPER BOUND kept (`max-width:min(92vw,1100px)`)
 * so LARGE images are still capped and never overflow -- minimal & symmetric.
 *
 * These locks read the SOURCE TEXT of app.css (immune to eval scope), pairing a POSITIVE lock (the
 * fix is present) against NEGATIVE locks that would each RE-BREAK it if someone reverts:
 *   L1  card width is `fit-content` (hugs content -- the fix)                      [would fail on revert]
 *   L2  the OLD fixed BARE-`width:min(92vw,1100px)` is GONE from the card selector [the pre-fix offender;
 *       the lookbehind keeps the legit `max-width` cap out of this match]
 *   L3  an UPPER BOUND (max-width with a vw + px cap) is RETAINED so large images stay capped (a bare
 *       fit-content with no max would let a huge original blow the modal past the viewport -- regression)
 *   L4  object-fit:contain stays on .img-viewer__body img (the picture must NOT stretch/deform)      [safety net]
 *   L5  NO !important rule targets img-viewer/img-modal size in app.css (no hidden override can resurrect stretch)
 *
 * Run: node tests/test_viewer_card_fit_content.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CSS = fs.readFileSync(path.join(ROOT, "serve", "web", "app.css"), "utf8");

const FAILURES = [];
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

// Isolate the .img-viewer__card rule block so locks only see THIS selector's declarations.
const cardBlockMatch = CSS.match(/\.img-viewer__card\s*\{[^}]*\}/);
check("card rule exists in app.css", !!cardBlockMatch);
const cardBlock = cardBlockMatch ? cardBlockMatch[0] : "";

// L1 POSITIVE (the fix): the card width hugs its content.
check("L1 card width is fit-content (hugs content -- the fix)",
  /\.img-viewer__card\s*\{[^}]*\bwidth:\s*fit-content\b/.test(cardBlock));

// L2 NEGATIVE: the old fixed near-full-width BARE width must be GONE. Lookbehind excludes any
// max-/min- prefixed property so it only fires on a genuine `width:` declaration == min(92vw ...).
check("L2 old fixed bare-`width:min(92vw,1100px)` is GONE from the card selector",
  !/\.img-viewer__card\s*\{[^}]*?[^-\w]width:\s*min\(92vw/.test(cardBlock));

// L3 NEGATIVE-guard: an upper bound (max-width with a vw cap AND a px cap) must be RETAINED so large
// images are still capped -- a bare fit-content with no max would let a huge original overflow.
check("L3 card retains an UPPER BOUND max-width (vw + px caps) to cap LARGE images",
  /max-width:\s*min\(\s*\d+vw\s*,\s*\d+px\s*\)/.test(cardBlock));

// L4: the picture itself must stay object-fit:contain on .img-viewer__body img (never stretch/deform).
check("L4 image stays object-fit:contain inside viewer body (picture never deforms)",
  /\.img-viewer__body\s+img\s*\{[^}]*object-fit:\s*contain/.test(CSS));

// L5: no !important rule may target img-viewer/img-modal size and resurrect a stretch.
check("L5 NO !important override anywhere on img-viewer/img-modal rules", (() => {
  const lines = CSS.split(/\r?\n/).filter((l) => /img-viewer|img-modal/.test(l));
  return !lines.some((l) => /!important/.test(l));
})());

console.log("\nVIEWER-CARD-FIT-CONTENT: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
