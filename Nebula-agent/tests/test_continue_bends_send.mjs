/* Differential gate for "a Continue click must REACH send" (2026-11, plan A+B).
 *
 * The bug this gate locks: clicking Continue on a context_overflow message routes through
 * continueTask -> compactConversation(true). When a chain is live (autoDriveDepth>0) the
 * chain-active guard used to swallow that compaction (silent return) so the FRONTEND never
 * reached send and never streamed, while the gateway kept running the task server-side --
 * exactly the reported "front-end stream stopped working but the backend is still running".
 *
 * Fix A: continueTask arms a single-shot flag (continueRequested) before calling
 *        compactConversation(true); the guard consumes it once and lets THAT compaction
 *        through to precondenseAndCompact (which ends in send). Every OTHER auto compaction
 *        while a chain runs is still deferred.
 * Fix B: the deferral used to be silent; it now draws a visible warn toast.
 *
 * Method mirrors test_precondense_guard.mjs: grab the REAL compactConversation from disk and
 * drive it through an injected stub scope. The SINGLE variable that flips between the two runs
 * is continueRequested. Only the flag differs -> a real differential, not decoration.
 *   TARGET   flag SET   -> guard passes  -> precondenseAndCompact fires, flag consumed, NO toast
 *   CONTROL  flag CLEAR -> guard returns -> precondenseAndCompact NEVER fires AND the B toast fires
 * Plus a static lock on the anchors (RED on the old unguarded code) and the two new i18n keys
 * present in BOTH language blocks.
 *
 * Run: node tests/test_continue_bends_send.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const src = readFileSync(join(WEB, "app.js"), "utf8");
const i18n = readFileSync(join(WEB, "i18n.js"), "utf8");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

function grab(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

// ---------- 1. static anchors ----------
console.log("=== 1. static anchors (RED on the old unguarded code) ===");
check("decl: let continueRequested = false", src.includes("let continueRequested = false;"));
check("continueTask arms the flag before compacting", /continueRequested\s*=\s*true;[\s\S]{0,300}compactConversation\(true\)/.test(src));
check("guard consumes it single-shot", src.includes("continueRequested = false;"));
check("guard keys on the flag (skips for a Continue)", src.includes("auto && autoDriveDepth > 0 && !"));
check("guard draws the B toast on deferral", /toast\("warn",\s*t\("insp\.compact\.deferred\.title"\)/.test(src));

const zhBlock = i18n.slice(i18n.indexOf("    zh: {"), i18n.indexOf("    en: {"));
const enBlock = i18n.slice(i18n.indexOf("    en: {"));
check("i18n deferred.title present in zh", zhBlock.includes('"insp.compact.deferred.title"'));
check("i18n deferred.title present in en", enBlock.includes('"insp.compact.deferred.title"'));
check("i18n deferred.msg present in zh", zhBlock.includes('"insp.compact.deferred.msg"'));
check("i18n deferred.msg present in en", enBlock.includes('"insp.compact.deferred.msg"'));

// ---------- 2. drive the REAL function, single-variable differential ----------
console.log("\n=== 2. differential pair (drive real compactConversation) ===");
const FN = grab("compactConversation");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function drive(flagSet){
  const calls = { precondense:0, send:0, toast:[], confirm:0 };
  const scope = { big: "x".repeat(5000), flagSet, calls };
  const S = new AsyncFunction("env", `
    const busy = false, chunkedCompacting = false, autoDriveDepth = 2;   // a chain IS live
    const messages = [{role:"user",text:env.big},{role:"assistant",text:env.big}];
    const estMsgChars = (m) => String(m.text||"").length;
    const compactReqBudgetChars = () => 200;                              // tiny -> total > budget
    const t = (k) => "T:" + k;
    const confirm = () => { env.calls.confirm++; return true; };
    const askConfirm = async () => { env.calls.confirm++; return true; };  // 2026-11-26
    const toast = (kind, title) => { env.calls.toast.push({kind, title}); };
    let pendingCompact = false, resumeSnapshot = null;
    let activeId = "s1", pendingCompactOwner = null;   // C2 (2026-11-08): compactConversation now writes pendingCompactOwner = activeId
    let continueRequested = env.flagSet;                                  // <-- the only variable
    const taskResumeSnapshot = () => ({ leftItems: 3 });
    const precondenseAndCompact = async () => { env.calls.precondense++; };
    const ceSetText = () => {};
    const $ = () => ({ value: "" });
    const send = () => { env.calls.send++; };
    const compactConversation = async function (auto = false) {${FN.slice(FN.indexOf("{") + 1, -1)}}
    await compactConversation(true);
    return { precondense: env.calls.precondense, send: env.calls.send,
             toast: env.calls.toast.length, flagAfter: continueRequested };
  `);
  return S(scope);
}

const main = async () => {
  const T = await drive(true);
  console.log(`  DIAG TARGET precondense=${T.precondense} toast=${T.toast} flagAfter=${T.flagAfter}`);
  check("TARGET precondenseAndCompact fired (guard passed -> reaches send)", T.precondense === 1);
  check("TARGET guard did NOT toast (it was let through)", T.toast === 0);
  check("TARGET flag consumed single-shot (reset after the guard)", T.flagAfter === false);

  const C = await drive(false);
  console.log(`  DIAG CONTROL precondense=${C.precondense} toast=${C.toast}`);
  check("CONTROL precondenseAndCompact did NOT fire (guard returned)", C.precondense === 0);
  check("CONTROL guard drew the B warn toast (was silent before)", C.toast === 1);

  check("DIFFERENCE is real: target fired, control did not", T.precondense !== C.precondense);

  if (FAILURES.length) { console.log(`\nFAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("\nCONTINUE-BENDS-SEND: ALL GREEN");
  process.exit(0);
};
main().catch((e) => { console.error(e); process.exit(1); });
