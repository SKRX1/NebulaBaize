/* auto-resume lane differential gate (feat, enters anchor chain).

Locks the A+B+C landing so a future edit under the OLD false premise cannot silently return:
  - A) the MAIN-chain hard stop READS settings.autoresumeMax (drawer-editable), NOT a hardcoded const;
       a normal long task runs to natural completion and only a genuine top-out hands back.
  - B) pure-thinking empty_round is auto-carried on its OWN separate counter/budget (it no longer
       rides the main lane's "resumable=false -> refuse" path); budget 0 = do NOT carry an empty round.
  - C) i18n keys for both lanes exist in zh+en; the hint no longer hardcodes "3".

Method: EXTRACT the real maybeAutoResume body from app.js (anti-drift lock -- we run the SOURCE, not a
hand-typed copy), wrap it with injected stub globals as a self-contained closure, and drive DIFERENTIAL
scenarios that prove each decision is load-bearing (flip one input, watch the return value flip).

Run standalone: node tests/test_autoresume_lanes.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const FAILURES = [];
const check = (label, cond, extra) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// ---- extract the REAL gate body from disk (anti-drift: this is the shipped source, not a copy) ----
const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const gm = /function maybeAutoResume\(m(?:, targetSession = null)?\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
check("maybeAutoResume extractable from app.js (anti-drift anchor)", !!gm);
if (!gm) { console.log("\nHALTED: gate body not found"); process.exit(1); }
const GATE = gm[0];

// i18n keys the gate consumes must exist in BOTH zh and en blocks (C). Read the disk truth.
const i18Src = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
console.log("\n=== C: i18n key presence per language block ===");
function countKeyBothLang(key) { return i18Src.split(/\r?\n/).filter((l) => l.includes(key)).length; }
for (const k of ["resume.stopped.empty", "drawer.autoresume.max.ph", "drawer.emptyroundmax.ph"]) {
  check(`zh+en both carry ${k}`, countKeyBothLang(k) === 2, "hits=" + countKeyBothLang(k));
}

// ---- runnable harness: each call builds an INDEPENDENT closure (no shared-global bleed across scenarios) ----
// the body's bare setTimeout / $ are supplied as parameters so they resolve inside this self-contained realm.
function makeHarness(seedMax) {
  const src = `
"use strict";
let AUTO_RESUME_MAX=${seedMax};let AUTO_RESUME_FLOOR=12;
let autoResumeChain, emptyRoundChain; let busy=false; let settings={};
let tLog=[]; function t(k){tLog.push(k);return k;}
function toast(kind,k1,k2){tLog.push("TOAST:"+k1+"|"+(k2||""));}
function renderChat(){} function ceSetText(el,txt){} let pendingResume=null;
function send(x){tLog.push("SEND:"+x);} let resumeBadge=null; function renderInspector(){} function $(){return {value:""};}
function activeSession(){return null;}   // owner-binding: the snapshot line resolves to null in this realm
${GATE.replace(/\r\n/g, "\n")}
return { run: function(s, cm0, ce0, m){ busy=false; settings=s; tLog=[]; autoResumeChain=cm0||0; emptyRoundChain=ce0||0; pendingResume=null; resumeBadge=null; return maybeAutoResume(m); },
         tlog: ()=>tLog };`;
  const f = new Function("setTimeout", src);
  // pass a synchronous setTimeout so the deferred send() runs now (observable), but only fires on the carry path.
  return f((cb) => { cb(); return 0; });
}

const run = (h, settings, cmn, cen, m) => h.run(settings, cmn, cen, m);

// pull the shipped AUTO_RESUME_MAX const from disk so the harness seed matches reality (A fallback).
const cm = /const AUTO_RESUME_MAX = (\d+);/.exec(appSrc);
const CONST_VALUE = cm ? +cm[1] : null;
check("AUTO_RESUME_MAX is now 24 on disk (raised floor, no longer 6)", CONST_VALUE === 24, "actual=" + CONST_VALUE);

console.log("\n=== D-switch master switch OFF -> never auto-resume (load-bearing) ===");
{
  const h = makeHarness(24);
  const rOn  = run(h, {autoresume:true, autoresumeMax:24, emptyRoundMax:2}, 0,0, {truncated:true});
  const rOff = run(h, {autoresume:false, autoresumeMax:24, emptyRoundMax:2}, 0,0, {truncated:true});
  check("switch ON + truncation -> resumes (true)", rOn === true);
  check("switch OFF same input -> refuses (false) [switch is load-bearing]", rOff === false);
}

console.log("\n=== A: main hard stop READS settings.autoresumeMax, NOT a hardcoded number ===");
{
  const h = makeHarness(24);
  const mFresh = () => ({truncated:true});
  const rReached = run(h, {autoresume:true, autoresumeMax:1, emptyRoundMax:2}, 1,0, mFresh()); // chain=1 >= cap1 -> fuse
  check("setting cap reached (cap=1,chain=1) -> hand back false", rReached === false);
  const rDefault = run(h, {autoresume:true, autoresumeMax:24, emptyRoundMax:2}, 0,0, mFresh()); // headroom -> carry on
  check("default headroom (cap=24,chain=0) -> carry on true [value comes from settings]", rDefault === true);
  const mStamp = {truncated:true}; run(h, {autoresume:true, autoresumeMax:1, emptyRoundMax:2}, 1,0, mStamp);
  check("main-lane exhaustion stamps resumeExhausted == SETTING cap (1)", mStamp.resumeExhausted === 1, "got=" + mStamp.resumeExhausted);
}

console.log("\n=== B: pure-thinking empty_round rides its OWN separate budget/lane (differential) ===");
{
  const h = makeHarness(24);
  // the backend marks the SECOND thinking-only round resumable=false -- exactly what the OLD gate refused. It must now auto-carry on its own lane.
  const emptyMsg = () => ({notice:{code:"empty_round", resumable:false}});
  const carry   = run(h, {autoresume:true, autoresumeMax:24, emptyRoundMax:2}, 0,0, emptyMsg()); // budget available -> true (B on)
  check("empty_round + budget available -> auto-carry true [would be false pre-B]", carry === true);

  const h0 = makeHarness(24);
  const noCarry = run(h0, {autoresume:true, autoresumeMax:24, emptyRoundMax:0}, 0,0, emptyMsg()); // knob=0 -> refuse
  check("empty_round + own budget=0 -> refuse false [knob is load-bearing]", noCarry === false);

  // separate counters: AT its own budget the EMPTY lane fuses with the EMPTY toast key + stamps emptyCap.
  const h2 = makeHarness(24);
  const mEx = {notice:{code:"empty_round", resumable:false}};
  const fuseAtCap = run(h2, {autoresume:true, autoresumeMax:24, emptyRoundMax:2}, 0,2, mEx); // start at cap -> >=cap fires
  check("empty lane fused AT its own budget -> false + stamps emptyCap(2)", fuseAtCap === false && mEx.resumeExhausted === 2, "stamp=" + mEx.resumeExhausted);
  const tl = h2.tlog(); // last run was the fuse; it must have used the EMPTY-specific key, not the main one.
  check("empty-lane fuse uses the EMPTY toast key (not the main one)", tl.some((x) => x.includes("resume.stopped.empty")), JSON.stringify(tl));

  // lane separation proof: MAIN chain fuses with its OWN key and must NOT use the EMPTY key.
  const h3 = makeHarness(24);
  run(h3, {autoresume:true, autoresumeMax:1, emptyRoundMax:2}, 1,0, {truncated:true});        // main fuse (chain1>=cap1)
  const tMainFuse = h3.tlog();
  check("main-lane fuse does NOT use the EMPTY toast key", !tMainFuse.some((x)=>x.includes("resume.stopped.empty")), JSON.stringify(tMainFuse));
}

console.log("");
if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | ")); process.exit(1); }
console.log("AUTORESUME-LANES: ALL GREEN");
process.exit(0);
