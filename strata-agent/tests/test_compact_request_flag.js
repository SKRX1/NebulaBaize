// Regression test: a compaction turn must be tagged body.strata_compact = true so the gateway's
// proactive 92% context guard lets it through. Without the flag, the compaction request that is
// supposed to FIX an overflowing context is itself blocked by that guard, wedging the chat
// permanently (the compact never produces a summary, every later turn stops at "上下文已接近上限").
//
// Loads the REAL app.js in jsdom (no browser) and asserts the POST to v1/chat/completions carries
// the strata_compact marker when pendingCompact is set, and does NOT when it isn't.
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

let captured = null;            // body of the most recent v1/chat/completions POST
function fakeStream() {
  return { ok: true, status: 200, headers: { get: () => "text/event-stream" },
    json: async () => ({}),
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) } };
}
const dom = new JSDOM(html, {
  runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true,
  beforeParse(window) {
    window.fetch = async (url, init) => {
      if (String(url).includes("chat/completions") && init && init.body) {
        try { captured = JSON.parse(init.body); } catch (e) { captured = null; }
      }
      if (String(url).includes("models")) return { ok: true, status: 200, json: async () => ({ models: [], ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
      if (String(url).includes("status")) return { ok: true, status: 200, json: async () => ({ ok: true }), body: { getReader: () => ({ read: async () => ({ done: true }) }) } };
      return fakeStream();
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
  if (!cond) { process.exitCode = 1; }
}

if (typeof w.send !== "function") { console.error("SPIKE FAIL: app.js did not expose send()"); process.exit(2); }
console.log("SPIKE OK: app.js loaded");

async function runCompactTurn() {
  captured = null;
  ev(`messages.length = 0;
      messages.push({role:'user', text:'你好'});
      busy = null;
      pendingCompact = true;
      document.querySelector('#input').value = '请把以上对话压缩成摘要';`);
  ev("send()");
  await sleep(250);             // let streamAssistant reach its fetch
}

(async () => {
  // ---- Test 1: while pendingCompact, the chat/completions body carries strata_compact = true ----
  await runCompactTurn();
  check("compact turn sets body.strata_compact = true",
        !!(captured && captured.strata_compact === true),
        captured ? "got: " + JSON.stringify({ compact: captured.strata_compact, session: captured.strata_session }) : "no body captured");

  // ---- Test 2: a normal (non-compact) turn must NOT set the flag ----
  captured = null;
  ev(`messages.length = 0;
      messages.push({role:'user', text:'你好'});
      busy = null;
      pendingCompact = false;
      document.querySelector('#input').value = '再问一个问题';`);
  ev("send()");
  await sleep(250);
  check("normal turn does NOT set strata_compact",
        !(captured && captured.strata_compact === true),
        captured ? "got: " + JSON.stringify({ compact: captured.strata_compact }) : "no body captured");

  console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL COMPACT-REQUEST-FLAG TESTS PASSED");
  process.exit(process.exitCode || 0);
})();
