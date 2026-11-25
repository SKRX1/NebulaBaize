// Differential test for the compaction-resume guard (2026-11, plan A).
// Contract: after a compaction writes its summary, the auto-resume of the interrupted
// unfinished task is gated by settings.compactResume (DEFAULT ON = today's behaviour).
//   G3 DEFAULTS carry compactResume: true, so an untouched install behaves as before;
//   G1 switch ON  -> the resume path arms pendingResume (the 3 s undo-window timer),
//                    and the snapshot is consumed (one-shot);
//   G2 switch OFF -> NO pendingResume timer is armed; the snapshot is put back on
//                    resumeSnapshot (the human presses Continue, which re-arms and
//                    compacts/resumes via continueTask);
//   G4 the drawer toggle exists, reflects the saved value on click, and the save
//      path reads it back into settings.
// Like tests/test_compact_resume_owner.js: the REAL i18n.js + app.js + admin.js run
// inside jsdom (runScripts:"dangerously" + injected <script>), which is what makes the
// app's top-level bindings visible to w.eval. The fetch mock must hand out a FRESH
// reader per call — fetchWithRetry retries up to 3 times and a single-shot reader
// starves every retry, so the summary comes back empty and finalize never resumes.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require2 = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require2("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

let html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const inject = (file, marker) => { html = html.replace(marker, `<script>${fs.readFileSync(path.join(WEB, file), "utf8")}</script>`); };
inject("i18n.js", '<script src="web/i18n.js"></script>');
inject("app.js", '<script src="web/app.js"></script>');
inject("app_utils.js", '<script src="web/app_utils.js"></script>');
inject("admin.js", '<script src="web/admin.js"></script>');

const SSE_BODY = 'data: {"choices":[{"delta":{"content":"SUMMARY-OK"}}],"usage":{"prompt_tokens":100,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
function jsonResp(body) {
  return { ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => body, body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
}

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  url: "http://localhost/",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (url) => {
      const u = String(url);
      if (u === "settings") return jsonResp({ shared: false });
      if (u.includes("models")) return jsonResp({ models: [], ok: true });
      if (u.includes("status") || u.includes("metrics") || u.includes("monitor")) return jsonResp({ ok: true });
      if (u.includes("api/chat") || u.includes("chat/completions")) {
        return { ok: true, status: 200, headers: { get: () => "text/event-stream" }, json: async () => ({}),
          body: { getReader: () => {          // FRESH reader per call — retries must still see the body
            let sent = false;
            return { read: async () => (sent ? { done: true, value: undefined }
              : ((sent = true), { done: false, value: new TextEncoder().encode(SSE_BODY) })) };
          } } };
      }
      return jsonResp({});
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

(async () => {
  if (typeof w.send !== "function") { console.error("SPIKE FAIL: app.js did not expose send()"); process.exit(2); }
  console.log("SPIKE OK: app.js loaded");
  ev("window.store = { get: () => null, set: () => {}, del: () => {} }; void 0;");   // keep save() off the network

  // G3: DEFAULTS carries the key (an untouched install keeps today's behaviour)
  check("G3: DEFAULTS.compactResume === true", ev("DEFAULTS.compactResume") === true);

  // G1: switch ON -> finalize arms pendingResume with a live undo-window timer
  ev(`sessions.length = 0;
      sessions.push({id:'sessA', title:'A', messages:[], workspace:''});
      activeId = 'sessA';
      settings.compactResume = true;
      messages = [{role:'user', text:'x'.repeat(2000)}, {role:'assistant', text:'y'.repeat(2000)}];
      pendingCompact = 'auto';
      pendingCompactOwner = 'sessA';
      resumeSnapshot = {leftItems: 2};
      precondenseDepth = 0; chunkedCompacting = false; busy = null;`);
  ev("streamAssistant()");                 // the summarize turn: fetch -> SUMMARY-OK -> finalize
  await sleep(400);
  check("G1: the summarize turn produced a non-empty summary", ev("(messages[0].content||'').includes('SUMMARY-OK')") === true,
        "messages[0]=" + JSON.stringify(String(ev("String(messages[0]&&messages[0].content)")).slice(0, 80)));
  check("G1: switch ON arms pendingResume (undo-window timer alive)",
        ev("!!(pendingResume && pendingResume.timer)") === true,
        "pendingResume=" + JSON.stringify(ev("!!(pendingResume && pendingResume.timer)")));
  check("G1: switch ON consumed the snapshot (one-shot)", ev("resumeSnapshot === null") === true);
  ev("if (pendingResume && pendingResume.timer) clearTimeout(pendingResume.timer); pendingResume = null;");   // cancel before it fires

  // G2: switch OFF -> no timer armed; snapshot put back; the turn ends naturally
  ev(`sessions.length = 0;
      sessions.push({id:'sessA', title:'A', messages:[], workspace:''});
      activeId = 'sessA';
      settings.compactResume = false;
      messages = [{role:'user', text:'x'.repeat(2000)}, {role:'assistant', text:'y'.repeat(2000)}];
      pendingCompact = 'auto';
      pendingCompactOwner = 'sessA';
      resumeSnapshot = {leftItems: 2};
      precondenseDepth = 0; chunkedCompacting = false; busy = null;`);
  ev("streamAssistant()");
  await sleep(400);
  check("G2: the summarize turn produced a non-empty summary", ev("(messages[0].content||'').includes('SUMMARY-OK')") === true,
        "messages[0]=" + JSON.stringify(String(ev("String(messages[0]&&messages[0].content)")).slice(0, 80)));
  check("G2: switch OFF arms NO pendingResume timer", ev("!pendingResume") === true,
        "pendingResume=" + JSON.stringify(ev("!!pendingResume")));
  check("G2: switch OFF puts the snapshot back (Continue re-arms it)",
        ev("!!(resumeSnapshot && resumeSnapshot.leftItems === 2)") === true,
        "resumeSnapshot=" + JSON.stringify(ev("resumeSnapshot")));

  // G4: drawer toggle exists, flips on click, save reads it back
  check("G4: drawer toggle #s-compactresume exists", ev("!!document.getElementById('s-compactresume')") === true);
  ev(`document.getElementById('s-compactresume').setAttribute('aria-checked','true'); void 0;`);
  ev("document.getElementById('s-compactresume').click()");
  check("G4: click flips to OFF", ev("document.getElementById('s-compactresume').getAttribute('aria-checked')") === "false");
  await ev("Promise.resolve($('s-apply').onclick())");
  await sleep(100);
  check("G4: save path reads the toggle back (settings.compactResume === false)",
        ev("settings.compactResume") === false, "got " + JSON.stringify(ev("settings.compactResume")));

  console.log(process.exitCode ? "\nSOME GUARD TESTS FAILED" : "\nCOMPACT-RESUME-GUARD: ALL PASSED");
  process.exit(process.exitCode || 0);
})();
