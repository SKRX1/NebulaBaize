/* early-done lane differential gate (feat A+B, enters anchor chain).

Locks the landing so a future edit under a false premise cannot silently return:
  - A) a NEW fourth lane fires when the model wrote what READS like a closing line while its OWN plan
       checklist still had UNCHECKED boxes -> premature close, not done. It has its OWN counter
       (earlyDoneChain) + small budget and never borrows the main-chain count. The unchecked-box count
       is LOAD-BEARING: same body-text, only "boxes left vs all ticked" differs -> return flips.
  - B) the resume path's instruction text (chat.resume.cmd) carries the self-check hard constraint in
       BOTH zh and en; a new toast key (resume.stopped.early) exists in both languages.

Method: EXTRACT the real maybeAutoResume body from app.js (anti-drift lock -- we run the SOURCE, not a
hand-typed copy), wrap it with injected stub globals as a self-contained closure (incl. earlyDoneChain),
and drive DIFFERENTIAL scenarios that prove each decision is load-bearing (flip ONE input, watch output flip).

Run standalone: node tests/test_early_done_lane.mjs
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
const gm = /function maybeAutoResume\(m\) \{[\s\S]*?\r?\n\}/.exec(appSrc);
check("maybeAutoResume extractable from app.js (anti-drift anchor)", !!gm);
if (!gm) { console.log("\nHALTED: gate body not found"); process.exit(1); }
const GATE = gm[0];

// the early lane must exist IN THE SOURCE (anti-drift): its own counter + own budget, chained before empty.
check("source declares earlyDoneChain", /\bearlyDoneChain\b/.test(appSrc));
check("source has isEarlyLane driven by openPlan", /const\s+isEarlyLane\s*=.*openPlan/.test(appSrc.replace(/\r\n/g,"\n")));

// ---- runnable harness: each call builds an INDEPENDENT closure (no shared-global bleed) ----
function makeHarness(seedMax) {
  const src = `
"use strict";
let AUTO_RESUME_MAX=${seedMax};let AUTO_RESUME_FLOOR=12;
let autoResumeChain, emptyRoundChain, earlyDoneChain; let busy=false; let settings={};
let tLog=[]; function t(k){tLog.push(k);return k;}
function toast(kind,k1,k2){tLog.push("TOAST:"+k1+"|"+(k2||""));}
function renderChat(){} function ceSetText(el,txt){} let pendingResume=null;
function send(x){tLog.push("SEND:"+x);} let resumeBadge=null; function renderInspector(){} function $(){return {value:""};}
function activeSession(){return null;}   // owner-binding: the snapshot line resolves to null in this realm
${GATE.replace(/\r\n/g, "\n")}
return { run: function(s, cm0, ce0, ed0, m){ busy=false; settings=s; tLog=[]; autoResumeChain=cm0||0; emptyRoundChain=ce0||0; earlyDoneChain=ed0||0; pendingResume=null; resumeBadge=null; return maybeAutoResume(m); },
         tlog: ()=>tLog };`;
  const f = new Function("setTimeout", src);
  return f((cb) => { cb(); return 0; });   // synchronous setTimeout so the deferred send() is observable on the carry path
}

const run = (h, settings, cmn, cen, edn, m) => h.run(settings, cmn, cen, edn, m);

// toast-logged key equals EXACTLY a given string (the harness records bare keys, no quotes).
const usedKey = (log, key) => log.some((x) => x === ("TOAST:" + key + "|") || x.startsWith("TOAST:" + key + "|"));

console.log("\n=== A: the UNCHECKED-BOX COUNT is load-bearing (single-variable differential) ===");
{
  const h = makeHarness(24);
  const posMsg = () => ({text:"closing done.", plan:[{done:true,label:"a"},{done:false,label:"b"}]});
  const carry = run(h, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,0,0, posMsg());
  check("closing line + a box still unchecked -> early lane carries true", carry === true);

  // NEG: SAME body text, only difference = every box ticked (genuinely done) -> must NOT be pulled back.
  const negMsg = () => ({text:"closing done.", plan:[{done:true,label:"a"},{done:true,label:"b"}]});
  const noCarry = run(h, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,0,0, negMsg());
  check("closing line + ALL boxes ticked (truly done) -> refuses false [box count is load-bearing]", noCarry === false);

  // anti-misjudge: a genuine one-line answer with NO plan at all -> never lights the lane.
  const h2 = makeHarness(24);
  const noPlan = run(h2, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,0,0, {text:"Done."});
  check("one-line real answer, no plan -> refuses false [near-zero misjudge]", noPlan === false);

  // empty text (no closing line) must not be pulled by the early lane either.
  const h3 = makeHarness(24);
  const emptyText = run(h3, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,0,0, {text:"", plan:[{done:false,label:"x"}]});
  check("no real text (empty body) -> refuses false [needs a produced closing line]", emptyText === false);
}

console.log("\n=== the early lane is its OWN budget/counter and does NOT borrow the main chain ===");
{
  const h = makeHarness(24);   // AUTO_RESUME_MAX=24: plenty of headroom so ONLY the early cap can cause a stop
  const posM = () => ({text:"done.", plan:[{done:false,label:"b"}]});

  const headroom = run(h, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0, 0, 0, posM());   // chain 0 < cap2 -> carry
  check("early lane at headroom (chain0<big cap) -> carry true", headroom === true);

  const h2 = makeHarness(24);
  const mFuse = {text:"done.", plan:[{done:false,label:"b"}]};
  // 2026-11 plan A+B: the early lane is a NOT-finished lane -> big budget (floor>=12, same as the main chain).
  const earlyCarry = run(h2, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0, 0, 0, mFuse);   // chain0 < big cap -> carries on
  check("early lane at headroom under the BIG budget -> carry true [plan A+B: runs to completion]", earlyCarry === true);
  const mFuse2 = {text:"done.", plan:[{done:false,label:"b"}]};
  const fuseAtCap = run(h2, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0, 0, Math.max(12, 24), mFuse2);   // start AT the big cap -> >=cap fires
  check("early lane fused at its OWN big budget -> false + stamps earlyCap(24)", fuseAtCap === false && mFuse2.resumeExhausted === 24, "stamp=" + mFuse2.resumeExhausted);

  const tl = h2.tlog();
  check("early-lane fuse uses the EARLY toast key", usedKey(tl,"resume.stopped.early"), JSON.stringify(tl));
  check("early-lane fuse does NOT use main or empty key", !usedKey(tl,"resume.stopped") && !usedKey(tl,"resume.stopped.empty"), JSON.stringify(tl));

  // lane separation: the MAIN chain fuse must NOT use the early key.
  const h3 = makeHarness(24);
  run(h3, {autoresume:true, autoresumeMax:1, emptyRoundMax:2}, 1,0,0, {truncated:true});   // main fuse (chain1>=cap1)
  const tMain = h3.tlog();
  check("main-lane fuse does NOT use the EARLY toast key", !usedKey(tMain,"resume.stopped.early") && usedKey(tMain,"resume.stopped"), JSON.stringify(tMain));
}

console.log("\n=== chaining did not break the existing empty lane (regression) ===");
{
  const h = makeHarness(24);
  // pure-thinking empty_round, NO plan -> must still ride its OWN empty lane and carry on.
  const emptyMsg = () => ({notice:{code:"empty_round", resumable:false}});
  const carryEmpty = run(h, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,0,0, emptyMsg());
  check("empty_round no-plan still auto-carries on the EMPTY lane (chain intact)", carryEmpty === true);

  const h2 = makeHarness(24);
  const mEx = {notice:{code:"empty_round", resumable:false}};
  run(h2, {autoresume:true,autoresumeMax:24,emptyRoundMax:2}, 0,2,0, mEx);   // empty lane at its own cap -> fuse on EMPTY key
  const tl2 = h2.tlog();
  check("empty-lane fuse still uses the EMPTY toast key (not early)", usedKey(tl2,"resume.stopped.empty") && !usedKey(tl2,"resume.stopped.early"), JSON.stringify(tl2));
}

console.log("\n=== C: i18n keys present in BOTH zh and en blocks + B hard-constraint text ===");
{
  const i18 = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
  const countKeyBothLang = (k) => i18.split(/\r?\n/).filter((l) => l.includes(k)).length;
  check("resume.stopped.early exists in zh+en", countKeyBothLang("resume.stopped.early") === 2, "hits="+countKeyBothLang("resume.stopped.early"));

  // Language-agnostic: identify each chat.resume.cmd line by its CONTENT features (not by ASCII/non-ASCII),
  // because the en text legitimately contains an em dash and apostrophes (non-ASCII too). This is the honest lock.
  const cmdLines = i18.split(/\r?\n/).filter(l => l.includes('"chat.resume.cmd":'));  // exact main key; the .<reason> siblings are excluded
  check("there are exactly two chat.resume.cmd entries (zh + en)", cmdLines.length === 2, "count="+cmdLines.length);

  // zh one must carry the CJK plan self-check; en one must carry the re-check phrase. Both read from disk truth.
  const hasZhSelfCheck = cmdLines.some(l => /[未勾收尾]/.test(l) && /收尾/.test(l));
  const hasEnRecheck     = cmdLines.some(l => /re-?check/i.test(l) && /closing sentence|unchecked/i.test(l));
  check("B: a resume command carries the plan self-check (zh)", hasZhSelfCheck);
  check("B: a resume command carries the plan re-check (en)", hasEnRecheck, JSON.stringify(cmdLines.map(x=>x.trim().slice(0,52))));
}

console.log("");
if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | ")); process.exit(1); }
console.log("EARLY-DONE-LANE: ALL GREEN");
process.exit(0);
