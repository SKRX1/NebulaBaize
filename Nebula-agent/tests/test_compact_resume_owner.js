// Regression test for the "custom model -> click Continue -> compaction wedged the old task"
// fix (2026-11-08). Two guarantees:
//   C1: when a compaction request FAILS, the resume snapshot must SURVIVE. History is untouched on
//       failure, so the interrupted task is still there and the user can retry; wiping the snapshot
//       here is exactly what left "compaction failed but the task no longer resumes".
//   C2: finalize carries a per-compact OWNER (pendingCompactOwner). A cross-session finalize must
//       only clear a pending compact that does NOT belong to the originating session; clearing one
//       that the ORIGINATOR still owns is how a failed compaction lost its resume on a mid-stream
//       switch and wedged the old task (only a brand-new task ran).
//
// Loads the REAL app.js in jsdom (no browser), like tests/test_compact_request_flag.js.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
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

function emptyStream() {   // reader returns done at once -> a summarise turn yields an empty result
  return { ok: true, status: 200, headers: { get: () => "text/event-stream" },
    json: async () => ({}),
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
}
const dom = new JSDOM(html, {
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
const w = dom.window;
const ev = (code) => w.eval(code);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, cond, extra) {
  console.log((cond ? "OK   " : "FAIL ") + name + (extra ? "  " + extra : ""));
  if (!cond) process.exitCode = 1;
}
if (typeof w.send !== "function") { console.error("SPIKE FAIL: app.js did not expose send()"); process.exit(2); }
console.log("SPIKE OK: app.js loaded");

(async () => {
  // ================= C1: a FAILED compaction keeps the resume snapshot =================
  // Seed two sessions so the switch/resume machinery has real targets; run the fold as sessA.
  ev(`sessions.length = 0;
      sessions.push({id:'sessA', title:'A', messages:[], workspace:''});
      sessions.push({id:'sessB', title:'B', messages:[], workspace:''});
      activeId = 'sessA';`);
  // Make the fold take the chunked path (total > budget) and let llmSummarize FAIL
  // (empty stream -> empty summary -> throw). The catch must KEEP resumeSnapshot now.
  ev(`pendingCompact = true;
      pendingCompactOwner = 'sessA';
      resumeSnapshot = {leftItems: 7};
      messages = [
        {role:'user', text:'x'.repeat(2000)},
        {role:'assistant', text:'y'.repeat(2000)},
        {role:'user', text:'z'.repeat(2000)},
        {role:'assistant', text:'w'.repeat(2000)}
      ];
      precondenseDepth = 0; chunkedCompacting = false; busy = null;`);
  ev("precondenseAndCompact(false)");
  await sleep(300);   // let llmSummarize fetch -> empty -> throw -> catch
  check("C1: a failed compaction KEEPS resumeSnapshot (was wiped)",
        ev("!!resumeSnapshot") === true,
        "resumeSnapshot=" + JSON.stringify(ev("resumeSnapshot")));
  check("C1: the failed compact cleared its own pendingCompact",
        ev("!pendingCompact") === true,
        "pendingCompact=" + JSON.stringify(ev("pendingCompact")));

  // ================= C2: finalize respects the per-compact owner =================
  // Case (a): the pending compact belongs to the ORIGINATING session (sessA). A mid-stream switch to
  // sessB must NOT clear it — the originator keeps its own compaction-resume.
  ev(`sessions.length = 0;
      sessions.push({id:'sessA', title:'A', messages:[], workspace:''});
      sessions.push({id:'sessB', title:'B', messages:[], workspace:''});
      activeId = 'sessA';
      messages = [{role:'user', text:'hello'}, {role:'assistant', text:'hi'}];
      pendingCompact = 'manual';
      pendingCompactOwner = 'sessA';
      resumeSnapshot = {leftItems: null};
      busy = null;`);
  ev("streamAssistant()");                 // records busy.sessionId = 'sessA', then awaits fetch
  ev("activeId = 'sessB';");               // user switched away mid-stream BEFORE finalize
  await sleep(350);                         // finalize runs: _ownerSid='sessA' !== activeId='sessB'
  check("C2a: owner==originator -> finalize KEEPS pendingCompact (no leak)",
        ev("pendingCompact") === 'manual',
        "pendingCompact=" + JSON.stringify(ev("pendingCompact")) +
        " owner=" + JSON.stringify(ev("pendingCompactOwner")));

  // Case (b): the pending compact belongs to ANOTHER view (owner != originator) -> finalize drops it
  // (the original behavior, preserved).
  ev(`sessions.length = 0;
      sessions.push({id:'sessA', title:'A', messages:[], workspace:''});
      sessions.push({id:'sessB', title:'B', messages:[], workspace:''});
      activeId = 'sessA';
      messages = [{role:'user', text:'hello'}, {role:'assistant', text:'hi'}];
      pendingCompact = 'manual';
      pendingCompactOwner = 'sessZ';        // belongs to neither the originator nor the current view
      resumeSnapshot = null;
      busy = null;`);
  ev("streamAssistant()");
  ev("activeId = 'sessB';");
  await sleep(350);
  check("C2b: owner!=originator -> finalize DROPS pendingCompact (old behavior kept)",
        ev("!pendingCompact") === true,
        "pendingCompact=" + JSON.stringify(ev("pendingCompact")));

  console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL C1/C2 RESUME-OWNER TESTS PASSED");
  process.exit(process.exitCode || 0);
})();
