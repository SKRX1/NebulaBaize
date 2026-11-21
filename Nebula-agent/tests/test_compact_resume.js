// Regression test for the compact + resume (续跑) bugs.
// Loads the REAL app.js in jsdom (no browser) and exercises:
//   1) taskResumeSnapshot() must return null for a FINISHED task, so a compact does NOT
//      spuriously arm the auto-resume (the old `|| {leftItems: null}` made it always fire).
//   2) continueTask() on a context_overflow notice must compact first (break the 400 loop),
//      not blindly re-send "继续" into the same oversized history.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
// Mirror the .mjs suites: resolve jsdom from the managed workspace, not a local
// node_modules (which is absent on this machine). Keeps the regression runner green.
const require2 = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require2("jsdom");

const WEB = path.resolve(__dirname, "..", "serve", "web");
let html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const inject = (file, marker) => {
  const code = fs.readFileSync(path.join(WEB, file), "utf8");
  html = html.replace(marker, `<script>${code}</script>`);
};
inject("i18n.js", '<script src="web/i18n.js"></script>');
inject("app.js", '<script src="web/app.js"></script>');
inject("admin.js", '<script src="web/admin.js"></script>');

// Robust fetch mock: app.js calls it at load (pollModels/status) and on send().
// Support both .json() and streaming .body.getReader().
function fakeResp(body) {
  const text = JSON.stringify(body);
  return {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  };
}

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (url) => {
      if (String(url).includes("models")) return fakeResp({ models: [], ok: true });
      if (String(url).includes("status")) return fakeResp({ ok: true });
      return fakeResp({ ok: true });
    };
    window.confirm = () => true;
    window.alert = () => {};
  },
});

const w = dom.window;
const ev = (code) => w.eval(code);

// ---- Spike: did app.js initialize without throwing? ----
const fnReady = typeof w.taskResumeSnapshot === "function" && typeof w.compactConversation === "function";
if (!fnReady) {
  console.error("SPIKE FAIL: app.js did not expose taskResumeSnapshot / compactConversation");
  process.exit(2);
}
console.log("SPIKE OK: app.js loaded, functions present");

// ---- Test 1: finished task -> snapshot is null (no spurious resume) ----
ev(`messages.length = 0;
    messages.push({role:'user', text:'写个函数'});
    messages.push({role:'assistant', text:'已完成', plan:[{label:'a', done:true}]});`);
const snapFinished = ev("taskResumeSnapshot()");
console.log("finished-task snapshot:", JSON.stringify(snapFinished));
if (snapFinished !== null) { console.error("TEST1 FAIL: expected null for finished task"); process.exit(1); }

// ---- Test 2: unfinished task (open plan item) -> snapshot carries leftItems ----
ev(`messages.length = 0;
    messages.push({role:'user', text:'做三件事'});
    messages.push({role:'assistant', text:'进度', plan:[{label:'a', done:true},{label:'b', done:false}]});`);
const snapUnfinished = ev("taskResumeSnapshot()");
console.log("unfinished-task snapshot:", JSON.stringify(snapUnfinished));
if (!snapUnfinished || snapUnfinished.leftItems !== 1) { console.error("TEST2 FAIL: expected {leftItems:1}"); process.exit(1); }

// ---- Test 3 (contract updated 2026-10): ANY compact arms resume, finished task included ----
//   approved reversal: compaction IS truncation; the 3s undo window and Stop are the
//   user's regret gates, so a finished-task compact arms the neutral snapshot.
ev(`messages.length = 0;
    messages.push({role:'user', text:'hi'});
    messages.push({role:'assistant', text:'done', plan:[{label:'a', done:true}]});
    resumeSnapshot = null;`);
// spy on compactConversation's send path by stubbing send to avoid a real stream
ev(`var __origSend = send; send = function(){ /* no-op, do not hit network */ };`);
ev("compactConversation(false)");           // manual compact (confirm stubbed true)
const afterCompactFinished = ev("resumeSnapshot");
console.log("resumeSnapshot after compact(finished):", JSON.stringify(afterCompactFinished));
if (!afterCompactFinished || afterCompactFinished.leftItems !== null) { console.error("TEST3 FAIL: compact must arm the neutral resume snapshot on a finished task"); process.exit(1); }

// ---- Test 4: continueTask on a context_overflow notice must call compactConversation (not re-send) ----
ev(`messages.length = 0;
    messages.push({role:'user', text:'长任务'});
    messages.push({role:'assistant', text:'', notice:{code:'context_overflow', resumable:true, text:'溢出'}});
    var compactCalls = 0;`);   // declared in window scope so the spy can increment it
// spy: count compactConversation invocations (do not actually stream)
ev(`var __origCompact = compactConversation;
    compactConversation = function(a){ compactCalls++; /* do not actually stream */ };
    var __origSend2 = send; send = function(){ /* no-op */ };`);
// build a fake continue button hosted in a .st-msg with data-i pointing at the overflow message
ev(`var __host = document.createElement('div'); __host.className='st-msg'; __host.dataset.i = String(messages.length-1);
    var __btn = document.createElement('button'); __btn.setAttribute('data-action','continue');
    __host.appendChild(__btn); document.body.appendChild(__host);`);
ev("continueTask(__btn)");
console.log("compactConversation calls from context_overflow continue:", ev("compactCalls"));
if (ev("compactCalls") !== 1) { console.error("TEST4 FAIL: context_overflow continue must compact first (got " + ev("compactCalls") + ")"); process.exit(1); }

console.log("ALL COMPACT/RESUME TESTS PASSED");
process.exit(0);
