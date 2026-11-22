// Regression for the cross-session auto-resume OWNER BINDING (2026-11). The stream reply body was
// already pinned to its originating session (busy.origin / finalize's _ownerSid path -- and
// test_compact_resume_owner.js locks that half). This test locks the SEND LEG: when the user switches
// to another task to look around, the deferred send()/sendSelectedSteps() fired by a resume chain must
// be aimed back at the task the interruption belongs to (the trigger-time snapshot), NOT at whatever
// task happens to be on screen when it fires. All THREE chains are covered with a real-realm behavioral
// differential: auto-resume (maybeAutoResume), auto-drive (maybeAutoDrive), post-compaction-resume
// (the finalize slice inside streamAssistant).
//
// Mechanism: send() gained an optional targetSession param (and streamAssistant/sendSelectedSteps/
// apiMessages pass it through); each chain captures `const _ownerSnap = activeSession()` (the drive
// chain names it _driveOwnerSnap) at TRIGGER time and forwards it -- send(false, _ownerSnap) /
// send(true, _ownerSnap) / sendSelectedSteps(m, false, _driveOwnerSnap).
//
// STATIC layer (locked, load-bearing): the signatures carry targetSession; each chain captures a
// trigger-time snapshot and forwards it; busy.origin prefers the snapshot. This is this codebase's
// established lock style (the lane tests likewise lock the source text directly).
// BEHAVIORAL layer (deterministic differential, the lane-test style): extract the REAL chain body,
// run it in a self-contained realm whose send()/sendSelectedSteps is a stub recording the targetSession
// it is handed, feed a SYNCHRONOUS setTimeout. FIX = the real code forwards the snapshot
// (activeSession()==A). CONTROL = the same body with the forward stripped back to send(false) /
// send(true) / sendSelectedSteps(m, false) (the pre-fix call). Flipping that ONE argument flips what
// the stub receives -- if it does not, the snapshot is decorative.
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
check("CHAIN auto-resume: trigger-time snapshot declared", SRC_APP.includes("const _ownerSnap = targetSession || activeSession();"));
check("CHAIN auto-resume: forwards the snapshot into send(false, _ownerSnap)", SRC_APP.includes("send(false, _ownerSnap)"));
check("CHAIN post-compaction-resume: forwards the snapshot into send(true, _ownerSnap)", SRC_APP.includes("send(true, _ownerSnap)"));
check("CHAIN auto-drive: snapshot declared", SRC_APP.includes("const _driveOwnerSnap = targetSession || activeSession();"));
check("CHAIN auto-drive: forwards the snapshot", SRC_APP.includes("sendSelectedSteps(m, false, _driveOwnerSnap)"));
check("BUSY origin prefers the snapshot", /busy = \{controller, msg: m, stopId, sessionId: \(targetSession \|\| activeSession\(\)/.test(SRC_APP));

// ---------------- BEHAVIORAL extraction anchors (anti-drift: each chain body must still be extractable) ----
const gm1 = /function maybeAutoResume\(m(?:, targetSession = null)?\) \{[\s\S]*?\n\}/.exec(SRC_JS);
check("ANCHOR auto-resume: maybeAutoResume extractable (anti-drift)", !!gm1);
const gm2 = /function maybeAutoDrive\(m(?:, targetSession = null)?\) \{[\s\S]*?\n\}/.exec(SRC_JS);
check("ANCHOR auto-drive: maybeAutoDrive extractable (anti-drift)", !!gm2);
// compaction-resume is an inline slice inside streamAssistant(): capture just the owner-binding statement
// block (comment -> snapshot decl -> pendingResume assignment -> renderInspector), NOT the closing brace.
const gm3 = /\/\/ Owner-binding: this finalize ran ON the owning view[\s\S]*?renderInspector\(\);/.exec(SRC_JS);
check("ANCHOR compaction-resume: finalize slice extractable (anti-drift)", !!gm3);

if (!gm1 || !gm2 || !gm3) { console.log("\nHALTED: anchor(s) not found"); process.exit(1); }

// ---- realm harnesses: self-contained realm, synchronous setTimeout, recording send/sendSelectedSteps.
// FIX runs the real extracted body; CONTROL strips the ONE forward argument. Single-variable flip.

// auto-resume realm: needs the gate's globals.
function runAutoResume(forwardOn) {
  const body = forwardOn ? gm1[0] : gm1[0].replace("send(false, _ownerSnap)", "send(false)");
  if (!forwardOn) check("CTRL auto-resume: differential swap changed forward (single variable)", body !== gm1[0]);
  const realm = `
"use strict";
let AUTO_RESUME_MAX=24, AUTO_RESUME_FLOOR=12;let EARLY_DONE_CAP=2;
let autoResumeChain=0, emptyRoundChain=0, earlyDoneChain=0;
let busy=false, settings={autoresume:true}, resumeBadge=null, pendingResume=null;
function t(k){return k;} function toast(){} function renderChat(){} function renderInspector(){}
function ceSetText(){} function $(){return {value:""};}
let _activeSessionObj={id:'sessA'}; function activeSession(){return _activeSessionObj;}
let __firedTarget='UNSET';
function send(human, targetSession){ __firedTarget = targetSession ? targetSession.id : '(no arg -> follows viewed session)'; return undefined; }
${body}
const m={text:'closing line', truncated:true, plan:[]};
maybeAutoResume(m);
return __firedTarget;`;
  return new Function("setTimeout", realm)((cb) => { cb(); return 0; });
}

// auto-drive realm: needs the drive's free globals (busy, autoDriveAbort, AUTO_DRIVE_MAX, autoDriveDepth,
// autoDriveTimer, settings, toast, t, $, messages, renderNextSteps, showAutoDrivePill). m carries one
// recommended STEP (the gate reads m.steps) so picks is non-empty; settings.autosteps must be true.
function runAutoDrive(forwardOn) {
  const body = forwardOn ? gm2[0] : gm2[0].replace("sendSelectedSteps(m, false, _driveOwnerSnap)", "sendSelectedSteps(m, false)");
  if (!forwardOn) check("CTRL auto-drive: differential swap changed forward (single variable)", body !== gm2[0]);
  const realm = `
"use strict";
let busy=false, autoDriveAbort=false;
let AUTO_DRIVE_MAX=6, autoDriveDepth=0, autoDriveTimer=null;
let settings={autosteps:true, autostepsRec:true};
function t(k){return k;} function toast(){}
function $(){return {querySelector:()=>null};}
function renderNextSteps(){} function showAutoDrivePill(){}
let messages=[{text:'x'}];
let _activeSessionObj={id:'sessA'}; function activeSession(){return _activeSessionObj;}
let __firedTarget='UNSET';
function sendSelectedSteps(mm, human, targetSession){ __firedTarget = targetSession ? targetSession.id : '(no arg -> follows viewed session)'; return undefined; }
${body}
const m={steps:[{recommended:true}]};   // m.steps, NOT m.nextSteps (gate reads m.steps)
maybeAutoDrive(m);
return __firedTarget;`;
  return new Function("setTimeout", realm)((cb) => { cb(); return 0; });
}

// compaction-resume realm: the extracted block is a straight-line statement slice; run it directly.
function runCompactionResume(forwardOn) {
  const body = forwardOn ? gm3[0] : gm3[0].replace("send(true, _ownerSnap)", "send(true)");
  if (!forwardOn) check("CTRL compaction-resume: differential swap changed forward (single variable)", body !== gm3[0]);
  const realm = `
"use strict";
let resumeBadge=null, pendingResume=null;
function renderInspector(){}
let _activeSessionObj={id:'sessA'}; function activeSession(){return _activeSessionObj;}
let __firedTarget='UNSET';
function send(human, targetSession){ __firedTarget = targetSession ? targetSession.id : '(no arg -> follows viewed session)'; return undefined; }
${body}
return __firedTarget;`;
  return new Function("setTimeout", realm)((cb) => { cb(); return 0; });
}

// ---- Run all three ----
// Auto-resume
const fixAR = runAutoResume(true);
const ctlAR = runAutoResume(false);
check("FIX auto-resume: chain aims deferred send at trigger-time snapshot (sessA)", fixAR === 'sessA', 'fired=' + fixAR);
check("CTRL auto-resume: without forward arg, send falls back to viewed session", ctlAR.indexOf('(no arg') === 0, 'fired=' + ctlAR);
check("DIFFERENTIAL auto-resume: flipping ONLY the forward arg flips target (snapshot load-bearing)",
      fixAR === 'sessA' && ctlAR.indexOf('(no arg') === 0, `fix=${fixAR} ctl=${ctlAR}`);

// Auto-drive
const fixAD = runAutoDrive(true);
const ctlAD = runAutoDrive(false);
check("FIX auto-drive: chain aims deferred sendSelectedSteps at trigger-time snapshot (sessA)", fixAD === 'sessA', 'fired=' + fixAD);
check("CTRL auto-drive: without forward arg, sendSelectedSteps falls back to viewed session", ctlAD.indexOf('(no arg') === 0, 'fired=' + ctlAD);
check("DIFFERENTIAL auto-drive: flipping ONLY the forward arg flips target (snapshot load-bearing)",
      fixAD === 'sessA' && ctlAD.indexOf('(no arg') === 0, `fix=${fixAD} ctl=${ctlAD}`);

// Compaction-resume
const fixCR = runCompactionResume(true);
const ctlCR = runCompactionResume(false);
check("FIX compaction-resume: finalize aims deferred send at trigger-time snapshot (sessA)", fixCR === 'sessA', 'fired=' + fixCR);
check("CTRL compaction-resume: without forward arg, send falls back to viewed session", ctlCR.indexOf('(no arg') === 0, 'fired=' + ctlCR);
check("DIFFERENTIAL compaction-resume: flipping ONLY the forward arg flips target (snapshot load-bearing)",
      fixCR === 'sessA' && ctlCR.indexOf('(no arg') === 0, `fix=${fixCR} ctl=${ctlCR}`);

console.log(process.exitCode ? "\nSOME OWNER-BINDING TESTS FAILED" : "\nALL OWNER-BINDING SEND-LEG TESTS PASSED (3 chains)");
process.exit(process.exitCode || 0);
