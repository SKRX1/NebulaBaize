// Regression for the cross-session auto-resume OWNER BINDING (2026-11). The stream reply body was
// already pinned to its originating session (busy.origin / finalize's _ownerSid path -- and
// test_compact_resume_owner.js locks that half). This test locks the SEND LEG: when the user switches
// to another task to look around, the deferred send() fired by the auto-resume chain must be aimed back
// at the task the interruption belongs to (the trigger-time snapshot), NOT at whatever task happens to
// be on screen when it fires.
//
// Mechanism: send() gained an optional targetSession param (and streamAssistant/sendSelectedSteps/
// apiMessages pass it through), and the chain captures `const _ownerSnap = activeSession()` at TRIGGER
// time and forwards it -- `send(false, _ownerSnap)`.
//
// STATIC layer (locked, load-bearing): the signatures carry targetSession; the chain captures a trigger-
// time snapshot and forwards it into send(); busy.origin prefers the snapshot. This is this codebase's
// established lock style (the lane tests likewise lock the source text directly).
// BEHAVIORAL layer (deterministic differential, the lane-test style): extract the real maybeAutoResume
// body, run it in a self-contained realm where send() is a stub that records the targetSession it is
// handed, feed a SYNCHRONOUS setTimeout. FIX = the real code forwards the snapshot (activeSession()==A).
// CONTROL = the same body but the forward stripped to `send(false)` (the pre-fix call). Flipping that one
// argument flips what the stub receives -- if it does not, the snapshot is decorative.
//
// Loads the REAL app.js (no browser) like tests/test_autoresume_lanes.mjs / test_compact_resume_owner.js.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const require2 = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require2("jsdom");

const WEB = path.resolve(__dirname, "..", "serve", "web");
const SRC_APP = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const SRC_JS = SRC_APP.replace(/\r\n/g, "\n");   // normalize so anchors below match regardless of file EOL

function check(name, cond, extra) {
  console.log((cond ? "OK   " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) process.exitCode = 1;
}

// ---------------- STATIC layer: signatures + snapshot capture + forward call sites ----------------
check("SIG send gained targetSession", /async function send\(human = true, targetSession = null\)/.test(SRC_APP));
check("SIG streamAssistant gained targetSession", /async function streamAssistant\(targetSession = null\)/.test(SRC_APP));
check("SIG sendSelectedSteps gained targetSession", /function sendSelectedSteps\(mm, human = true, targetSession = null\)/.test(SRC_APP));
check("SIG apiMessages gained targetSession", /function apiMessages\(targetSession = null\)/.test(SRC_APP));
check("FORWARD send -> streamAssistant(snapshot)", /await streamAssistant\(targetSession\)/.test(SRC_APP));
check("FORWARD sendSelectedSteps -> send(human, targetSession)", /send\(human, targetSession\)/.test(SRC_APP));
check("CHAIN auto-resume: trigger-time snapshot declared", SRC_APP.includes("const _ownerSnap = activeSession();"));
check("CHAIN auto-resume: forwards the snapshot into send(false, _ownerSnap)", SRC_APP.includes("send(false, _ownerSnap)"));
check("CHAIN post-compaction-resume: forwards the snapshot into send(true, _ownerSnap)", SRC_APP.includes("send(true, _ownerSnap)"));
check("CHAIN auto-drive: snapshot declared", SRC_APP.includes("const _driveOwnerSnap = activeSession();"));
check("CHAIN auto-drive: forwards the snapshot", SRC_APP.includes("sendSelectedSteps(m, false, _driveOwnerSnap)"));
check("BUSY origin prefers the snapshot", /busy = \{controller, msg: m, stopId, sessionId: \(targetSession \|\| activeSession\(\)/.test(SRC_APP));

// ---------------- BEHAVIORAL layer: extract the real chain body, run it against a recording send --------
// lane-test style: pull the maybeAutoResume function source out of app.js and run it inside an
// independent realm whose send() records the targetSession it is handed. We feed a SYNCHRONOUS setTimeout
// so the deferred send fires within the same synchronous step. The realm supplies every global the body
// touches (settings, the three chain counters, resumeBadge, pendingResume, ceSetText, $, toast, render*).
const gm = /function maybeAutoResume\(m\) \{[\s\S]*?\n\}/.exec(SRC_JS);
check("maybeAutoResume extractable from app.js (anti-drift anchor)", !!gm);
if (!gm) { console.log("\nHALTED: gate body not found"); process.exit(1); }
const GATE = gm[0];

// Build a harness that runs the EXTRACTED gate body with a recording send. `forwardOn` decides whether
// the chain forwards the snapshot (the FIX code path, i.e. the real extracted source) or drops the arg
// (the CONTROL = pre-fix call). We realise CONTROL by a one-arg regex swap on the extracted source -- the
// single-variable differential: only the forward arg changes, everything else (incl the snapshot capture)
// is byte-identical, so a flipped outcome proves the forward is load-bearing.
function runHarness(forwardOn) {
  const body = forwardOn ? GATE : GATE.replace("send(false, _ownerSnap)", "send(false)");
  if (!forwardOn) check("CONTROL: the differential swap actually changed the forward (single variable)", body !== GATE);
  const realm = `
"use strict";
let AUTO_RESUME_MAX=24, AUTO_RESUME_FLOOR=12;
let autoResumeChain=0, emptyRoundChain=0, earlyDoneChain=0;
let busy=false, settings={autoresume:true}, resumeBadge=null, pendingResume=null;
let tLog=[]; function t(k){return k;} function toast(){} function renderChat(){} function renderInspector(){}
function ceSetText(){} function $(){return {value:""};}
// The realm's view of "the task being interrupted" -- the chain will snapshot it via activeSession().
let _activeSessionObj={id:'sessA'}; function activeSession(){return _activeSessionObj;}
let __firedTarget='UNSET';
function send(human, targetSession){ __firedTarget = targetSession ? targetSession.id : '(no arg -> follows viewed session)'; return undefined; }
${body}
// Drive: arm the chain while "on sessA", then the synchronous setTimeout fires the deferred send.
const m={text:'closing line', truncated:true, plan:[]};   // truncated -> main resume lane -> forward path
maybeAutoResume(m);
return __firedTarget;`;
  const f = new Function("setTimeout", realm);   // realm body references setTimeout as a parameter
  return f((cb) => { cb(); return 0; });   // synchronous setTimeout: run the deferred callback immediately
}

const fixTarget = runHarness(true);    // real source -> forwards the snapshot -> records sessA
const ctlTarget = runHarness(false);   // forward stripped to send(false) -> records "(no arg -> follows viewed)"

check("FIX: the chain aims its deferred send at the trigger-time snapshot (sessA)",
      fixTarget === 'sessA', 'fired=' + fixTarget);
check("CONTROL: without the forward arg the send falls back to the viewed session (no snapshot)",
      ctlTarget.indexOf('(no arg') === 0, 'fired=' + ctlTarget);
check("DIFFERENTIAL: flipping ONLY the forward arg flips what send is aimed at (snapshot is load-bearing)",
      fixTarget === 'sessA' && ctlTarget.indexOf('(no arg') === 0, `fix=${fixTarget} ctl=${ctlTarget}`);

console.log(process.exitCode ? "\nSOME OWNER-BINDING TESTS FAILED" : "\nALL OWNER-BINDING SEND-LEG TESTS PASSED");
process.exit(process.exitCode || 0);
