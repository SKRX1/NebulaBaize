// Browser-real end-to-end verification of the owner-binding (2026-11) -- the full chain, not the
// source-text lock the sibling test (test_owner_binding_jsdom.js) carries. Here we drive the REAL
// send() / streamAssistant() / sendSelectedSteps() in a live jsdom realm and watch where the reply
// lands (which session's messages[] grows).
//
// What this locks (the point the static layer cannot prove alone): a chain arms on task A, the USER
// SWITCHES TO TASK B TO LOOK AROUND, the timer then fires -- and the reply must land back on A, not
// on B. Each scenario runs in its OWN fresh realm (shared globals across scenarios in one realm was
// exactly what made an earlier single-realm version flaky).
//
// Faithful shape of the production chain (the single variable we flip):
//   arm:   on A -> capture the snapshot NOW (const _ownerSnap = activeSession()) -> switch to B -> fire.
//   FIX    : the deferred call forwards the snapshot -> send(false, _ownerSnap) -> lands on A (A>=4, B==2).
//   CONTROL: the pre-fix call drops it -> send(false) -> follows the viewed B -> B>=4, A starved at 2.
// The snapshot is captured into a plain closure var BEFORE the timer (exactly as the real chain does),
// never read back off a global the callback nulls first -- that was the old test's ordering bug.
//
// send()/sendSelectedSteps() read the composer (#input textContent) and return early if it is empty,
// so we feed the composer a real string before firing (auto-drive feeds itself via composeStepsMessage).
//
// Loads the REAL app.js in jsdom (no browser), like tests/test_compact_resume_owner.js.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const require2 = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require2("jsdom");

const WEB = path.resolve(__dirname, "..", "serve", "web");
let HTML = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
for (const [marker, file] of [["<script src=\"web/i18n.js\"></script>", "i18n.js"],
    ["<script src=\"web/app_utils.js\"></script>", "app_utils.js"], ["<script src=\"web/app.js\"></script>", "app.js"], ["<script src=\"web/admin.js\"></script>", "admin.js"]])
  HTML = HTML.replace(marker, `<script>${fs.readFileSync(path.join(WEB, file), "utf8")}</script>`);

function emptyStream() {   // reader returns done at once -> the turn yields an empty assistant body
  return { ok: true, status: 200, headers: { get: () => "text/event-stream" },
    json: async () => ({}),
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
}
function makeRealm() {
  const d = new JSDOM(HTML, {
    runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes("models")) return { ok: true, status: 200, json: async () => ({ models: [], ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        if (u.includes("status")) return { ok: true, status: 200, json: async () => ({ ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        return emptyStream();
      };
      window.confirm = () => true;
      window.alert = () => {};
    },
  });
  return d.window;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  console.log((cond ? "OK   " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) process.exitCode = 1;
}

// Seed two real sessions (A gets the interrupted task; B is the one we switch to view).
const SEED = `sessions.length = 0;
  sessions.push({id:'sessA', title:'A-task', messages:[{role:'user',text:'job'},{role:'assistant',text:'halfway',truncated:true,plan:[{done:true,label:'x'}]}], workspace:''});
  sessions.push({id:'sessB', title:'B-view', messages:[{role:'user',text:'other'},{role:'assistant',text:'answer'}], workspace:''});
  settings.autoresume = true; settings.autosteps = true; settings.chainmax = 24;
  autoResumeChain = 0; emptyRoundChain = 0; earlyDoneChain = 0; autoDriveDepth = 0; autoDriveAbort = false;
  chunkedCompacting = false; pendingCompact = false; pendingCompactOwner = null;
  resumeSnapshot = null; pendingResume = null; pendingPastes = new Map(); attachments = []; busy = null;`;

// `forward` is the ONE flipped variable: the deferred call forwards the trigger-time snapshot (FIX) or
// drops it (CONTROL). Everything else (arm-on-A -> switch-to-B -> feed composer) is byte-identical.
function armCode(chain, forward) {
  const fwd = (noArg, withSnap) => forward ? withSnap : noArg;
  if (chain === 'auto-resume') {
    // arm the REAL gate on sessA while we are on it -> it captures _ownerSnap=A into pendingResume.owner
    return `activeId='sessA'; messages=findSession('sessA').messages;
      var armed = maybeAutoResume(messages[messages.length-1]);
      if (armed !== true) throw new Error('auto-resume did not arm');
      var _snap = pendingResume.owner;                                // capture the snapshot NOW (production does)
      activeId='sessB'; messages=findSession('sessB').messages;       // USER SWITCHES TO LOOK AROUND
      ceSetText($("input"), 'resume please');                         // composer must be non-empty for send()
      clearTimeout(pendingResume.timer);
      setTimeout(function(){ pendingResume=null; ${fwd('send(false)', 'send(false, _snap)')}; }, 60);`;
  }
  if (chain === 'compaction-resume') {
    // finalize ran ON the owning view A (the guard guarantees that), so activeSession()==A at arm time
    return `activeId='sessA'; messages=findSession('sessA').messages;
      var _snap = activeSession();                                    // snapshot on A (still on it)
      activeId='sessB'; messages=findSession('sessB').messages;       // USER SWITCHES
      ceSetText($("input"), 'continue please');                       // composer non-empty for send()
      setTimeout(function(){ ${fwd('send(true)', 'send(true, _snap)')}; }, 60);`;
  }
  // auto-drive: the REAL chain captures _driveOwnerSnap=activeSession() at trigger on sessA, then fires
  // sendSelectedSteps. Reproduce that shape; give the target assistant msg real steps + selection so
  // composeStepsMessage returns non-empty text (this path feeds the composer itself via ceSetText).
  return `activeId='sessA'; messages=findSession('sessA').messages;
    var m = messages[messages.length-1];
    m.steps = [{label:'do the next step', detail:'next', recommended:true, ver:1}];
    m.selSteps = [0];                                                 // the chain mirrors its picks onto the msg
    var _snap = activeSession();                                      // snapshot on A (still on it)
    activeId='sessB'; messages=findSession('sessB').messages;         // USER SWITCHES
    setTimeout(function(){ ${fwd('sendSelectedSteps(m, false)', 'sendSelectedSteps(m, false, _snap)')}; }, 60);`;
}

async function runScenario(chain, forward) {
  const w = makeRealm();
  const ev = (code) => { try { return w.eval(code); } catch (e) { return "__ERR__:" + e.message; } };
  ev(SEED);
  const r = ev(armCode(chain, forward));
  if (typeof r === 'string' && r.startsWith('__ERR__')) { check(`[${chain}] realm arm ok`, false, r); return null; }
  await sleep(900);   // the deferred call fires at 60ms; the stream then completes via the empty stream
  return { aLen: ev("findSession('sessA').messages.length"), bLen: ev("findSession('sessB').messages.length") };
}

(async () => {
  for (const chain of ['auto-resume', 'compaction-resume', 'auto-drive']) {
    const fix = await runScenario(chain, true);
    const ctl = await runScenario(chain, false);
    if (!fix || !ctl) continue;
    check(`[${chain}] FIX: reply landed back on the interrupted task A (>=4)`, fix.aLen >= 4, JSON.stringify(fix));
    check(`[${chain}] FIX: the merely-viewed task B stayed at seed size (==2)`, fix.bLen === 2, JSON.stringify(fix));
    check(`[${chain}] CONTROL: the old no-snapshot call landed on the VIEWED task B (>=4)`, ctl.bLen >= 4, JSON.stringify(ctl));
    check(`[${chain}] CONTROL: the interrupted task A was starved (==2)`, ctl.aLen === 2, JSON.stringify(ctl));
    check(`[${chain}] DIFFERENTIAL: flipping only the snapshot arg flips where the reply lands (load-bearing)`,
          fix.aLen >= 4 && ctl.aLen === 2, `fix=${JSON.stringify(fix)} ctl=${JSON.stringify(ctl)}`);
  }
  console.log(process.exitCode ? "\nSOME E2E OWNER-BINDING TESTS FAILED" : "\nALL E2E OWNER-BINDING TESTS PASSED");
  process.exit(process.exitCode || 0);
})();
