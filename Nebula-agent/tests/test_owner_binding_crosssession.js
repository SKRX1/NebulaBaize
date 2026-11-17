// Reproduction of the CROSS-SESSION RESUME landing bug (screenshot-confirmed, 2026-11).
//
// The screenshot: an auto-resume was armed on TASK A. The user then switched to NEW task B and the
// "continue the interrupted task" line was sent there. The resume REPLY landed on B, not on A.
//
// ROOT CAUSE (verified against source, not from memory): streamAssistant starts on A (busy.origin=A).
// The user switches to B (activeId=B). The stream finalizes; finalize's cross-session block
// (`_ownerSid && _ownerSid !== activeId`) correctly writes the assistant message back to owner session A
// and saveSessions() -- but it does NOT return. Execution falls through to the finalize tail and, because
// pendingCompact is false, calls maybeAutoResume(m). That chain snapshots the owner via activeSession()
// -- which is now B -- so the deferred send(false, <snapshot>) lands on B.
//
// This is the ONE leg the sibling tests miss: test_owner_binding_jsdom.js locks the SEND-LEG forward
// argument assuming the arm runs while STILL ON A; test_owner_binding_e2e.js arms the chain while still
// on A then switches. Both sidestep the real divergence: finalize ALREADY ran cross-session, so
// activeSession() == B at snapshot time.
//
// This test drives the REAL send() -> REAL streamAssistant -> REAL finalize in a live jsdom realm, with
// the user switching to B mid-stream (before finalize resumes) exactly as the real user did. The single
// load-bearing variable is the PRODUCTION code itself:
//   PRE-FIX : finalize's cross-session block does not forward owner -> resume lands on the viewed B -> RED.
//   POST-FIX: that block forwards `owner` into the resume chain -> resume lands on A -> GREEN.
// No activeSession monkey-patch: the assertion must flip purely from the production change.
//
// Loads the REAL app.js in jsdom (no browser), like tests/test_owner_binding_e2e.js.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const require2 = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require2("jsdom");

const WEB = path.resolve(__dirname, "..", "serve", "web");
let HTML = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
for (const [marker, file] of [["<script src=\"web/i18n.js\"></script>", "i18n.js"],
    ["<script src=\"web/app.js\"></script>", "app.js"], ["<script src=\"web/admin.js\"></script>", "admin.js"]])
  HTML = HTML.replace(marker, `<script>${fs.readFileSync(path.join(WEB, file), "utf8")}</script>`);

// A real SSE stream: one content delta (so the turn "made real progress"), then a finish_reason:length
// chunk (so finalize stamps m.truncated -> the auto-resume rail arms), then the [DONE] marker.
function sseStream() {
  const enc = new TextEncoder();
  const evs = [
    'data: {"choices":[{"delta":{"content":"halfway through the real job"}}]}\n',
    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n',
    'data: [DONE]\n',
  ];
  let sent = false;
  return { ok: true, status: 200, headers: { get: () => "text/event-stream" },
    json: async () => ({}),
    body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined }
        : (sent = true, { done: false, value: enc.encode(evs.join("")) })) }) } };
}
function makeRealm() {
  const d = new JSDOM(HTML, {
    runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = async (url) => {
        const u = String(url);
        if (u.includes("models")) return { ok: true, status: 200, json: async () => ({ models: [], ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        if (u.includes("status")) return { ok: true, status: 200, json: async () => ({ ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
        return sseStream();
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

// Seed A as the interrupted task (the turn that arms the resume); seed B as the NEW task the user opens
// and switches the view to mid-stream.
const SEED = `sessions.length = 0;
  sessions.push({id:'sessA', title:'A-interrupted', messages:[{role:'user',text:'real job'}], workspace:''});
  sessions.push({id:'sessB', title:'B-newview', messages:[{role:'user',text:'fresh'}], workspace:''});
  settings.autoresume = true; settings.compactResume = true; settings.chainmax = 24; settings.autosteps = false;
  autoResumeChain = 0; emptyRoundChain = 0; earlyDoneChain = 0; autoDriveDepth = 0; autoDriveAbort = false;
  chunkedCompacting = false; pendingCompact = false; pendingCompactOwner = null;
  resumeSnapshot = null; pendingResume = null; pendingPastes = new Map(); attachments = []; busy = null;`;

(async () => {
  const w = makeRealm();
  const ev = (c) => { try { return w.eval(c); } catch (e) { return "__ERR__:" + e.message; } };

  ev(SEED);
  // The turn is started while STILL ON A: send() reads composer text, so feed it. messages points at A so
  // streamAssistant pushes its assistant body into A and busy.origin = A (the genuine originating view).
  ev(`activeId='sessA'; messages=findSession('sessA').messages;`);
  ev(`ceSetText($("input"), 'please continue');`);
  ev(`send(false);`);   // streams on A -> busy.origin=A; the async body awaits fetchWithRetry

  // The user switched to B BEFORE finalize's cross-session check runs (this is the mid-stream switch):
  ev(`activeId='sessB'; messages=findSession('sessB').messages;`);

  // Give the async chain time: stream resolves -> finalize (cross-session block on owner A) ->
  // maybeAutoResume arms pendingResume (3s) -> deferred send lands the resume reply.
  await sleep(6000);

  const aLen = ev("findSession('sessA').messages.length");
  const bLen = ev("findSession('sessB').messages.length");
  console.log(`A(interrupted task)=${aLen}  B(viewed new task)=${bLen}`);

  // The resume reply (user + assistant) must land on the task it belongs to (A), so A grows to >=4
  // (seed user + the finalize-armed assistant turn's body already counted + resume user + resume body).
  // The merely-VIEWED new task B must stay at seed size (==1) -- it must NOT receive the resume reply.
  check("The resume reply lands on the INTERRUPTED task A it belongs to (A >= 3)", aLen >= 3, `A=${aLen}`);
  check("The merely-VIEWED new task B must NOT receive the resume reply (B == 1)", bLen === 1, `B=${bLen}`);
  check("DIFFERENTIAL load-bearing: only the production forward decides landing (A>=3, B==1)",
        aLen >= 3 && bLen === 1, `A=${aLen} B=${bLen}`);

  console.log(process.exitCode ? "\nRED (pre-fix: reply landed on the viewed B, the screenshot bug)" : "\nGREEN (post-fix: reply lands back on the interrupted task A)");
  process.exit(process.exitCode || 0);
})();
