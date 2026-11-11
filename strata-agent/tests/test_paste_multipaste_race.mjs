/* Gate: pasting 2+ images at once must land ALL of them, not just the first.
 *
 * Root cause this locks (2026-11-11): pasteImageToRich fires one FileReader per pasted
 * file; with 2+ files the onload callbacks run CONCURRENTLY, and each runs an
 * execCommand("insertHTML") + a caret/selection move. The shared selection is single-threaded,
 * so two concurrent caret writes collide and the 2nd chip can land OUTSIDE the composer;
 * reconcileArray then drops any array entry whose chip is not in the composer DOM -> only 1
 * image is sent. The reported symptom: "paste several images, the model only reads one".
 *
 * Fix: when files.length > 1, SERIALIZE — await each file's DOM+array landing (via the
 * _land/_landFullResolve gate) before starting the next read, so the caret is stable at every
 * insert. A single image has no sibling to collide with, so its proven NON-BLOCKING path is
 * kept (test_paste_pending_gate locks it; that is why the serialize is gated on length>1).
 *
 * jsdom does not implement real caret/insertHTML behaviour (queryCommandSupported is false),
 * so the race mechanism cannot be replayed through the live DOM. We model it faithfully and
 * run a LOAD-BEARING single-variable differential: the ONLY thing that changes is whether the
 * loop serializes. Concurrent (control) -> the 2nd chip misses the composer -> 1 kept.
 * Serialized (the fix) -> both land -> 2 kept. Plus static locks so a future edit that drops
 * the `_serialize` gate trips the test even though the model itself stays green.
 *
 * Run standalone: node tests/test_paste_multipaste_race.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static locks: the serialize wiring must exist and be gated on multi-file -------------
check("source: serialize decision gated on files.length > 1 (single image stays non-blocking)",
  /const _serialize = files\.length > 1;/.test(srcText));
check("source: a per-file full-land gate exists (_landFullResolve resolve)",
  /reader\._landFullResolve = res/.test(srcText) && /if \(reader\._landFullResolve\)/.test(srcText));
check("source: the loop awaits the full-land gate ONLY when serializing (multi)",
  /if \(_serialize\) await _land;/.test(srcText));

// --- load-bearing differential: ONE variable = whether the loop serializes -----------------
// Faithful model of the race. composerPresent = chips physically inside the composer (the DOM);
// array = the source-of-truth list; reconcileArray drops array entries with no composer chip.
function makeEnv() {
  const composerPresent = new Set();
  const array = [];
  let pid = 0;
  const nextPid = () => ++pid;
  function reconcileArray() {
    for (let k = array.length - 1; k >= 0; k--)
      if (!composerPresent.has(String(array[k].pid))) array.splice(k, 1);
  }
  const readFile = () => new Promise((r) => setTimeout(r, 20));   // async FileReader completes
  const caretWrite = () => new Promise((r) => setTimeout(r, 3));  // shared selection/caret write
  return { composerPresent, array, nextPid, reconcileArray, readFile, caretWrite };
}

// The shared caret is single-threaded: in CONCURRENT mode, when two caret writes are in flight
// at the same moment, only the FIRST to acquire the caret lands its chip in the composer; the
// second's caret is stolen mid-write so its chip lands OUTSIDE -> reconcileArray drops it.
async function runConcurrent() {
  const e = makeEnv();
  const pA = e.nextPid(), pB = e.nextPid();
  // both reads kick off together; both onloads overlap (the OLD, pre-fix path)
  let caretOwner = null;          // who currently holds the shared caret
  const job = async (pidNum, isSecond) => {
    await e.readFile();
    await e.caretWrite();
    if (caretOwner === null) caretOwner = pidNum;        // first write grabs the caret
    else if (!isSecond) caretOwner = pidNum;
    // the 2nd concurrent caret write loses the caret (collision) -> chip lands OUTSIDE composer
    const landedInComposer = (caretOwner === pidNum);
    if (landedInComposer) e.composerPresent.add(String(pidNum));
    e.array.push({ pid: pidNum });
    e.reconcileArray();
  };
  await Promise.all([job(pA, false), job(pB, true)]);
  return e.array.length;
}

// SERIALIZED (the fix): each file fully lands (read -> caret -> insert -> push -> reconcile)
// before the next read starts, so every caret write is alone and stable.
async function runSerialized() {
  const e = makeEnv();
  for (let i = 0; i < 2; i++) {
    const p = e.nextPid();
    await e.readFile();
    await e.caretWrite();
    e.composerPresent.add(String(p));     // caret stable -> chip lands INSIDE composer
    e.array.push({ pid: p });
    e.reconcileArray();
  }
  return e.array.length;
}

// warm both paths once, then measure (deterministic timing, no Math.random)
await runConcurrent();
await runSerialized();
const concurrentKept = await runConcurrent();   // control: only the first image survives
const serializedKept = await runSerialized();   // fix: both survive

check("DIFFERENTIAL CONTROL (concurrent onload): 2 pasted images keep only 1 (the race)",
  concurrentKept === 1);
check("DIFFERENTIAL FIX (serialized onload): 2 pasted images keep both",
  serializedKept === 2);
check("LOAD-BEARING: serialization changes the outcome (2 > 1) — proves the fix, not vacuous",
  serializedKept > concurrentKept);

console.log("\nPASTE-MULTIPASTE-RACE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
