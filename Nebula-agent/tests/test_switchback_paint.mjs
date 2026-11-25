/* Gate B: switch-back immediate paint.
   Mechanism: renderChat (the switch-back entry) rebuilds rows, then the new B-hook calls paintLive()
   which paints the RUNNING turn's tail segment right now, instead of waiting for the next rAF-scheduled
   chunk. Differential: after a chunk lands in the origin session's messages array while viewing another
   session, switching back shows it IMMEDIATELY (positive); while staying on the other session the live
   session's newest chunk is not on screen (negative). Same jsdom-boot as test_switch_busy_e2e.
   Run: node tests/test_switchback_paint.mjs */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window; const doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, cond, extra = "") => { results.push([label, cond]); console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : "")); };

const queue = [];
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
  if (opts.body && String(opts.method || "GET").toUpperCase() === "POST" && String(opts.body).includes("messages")) {
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
      while (queue.length === 0) await sleep(5);
      const line = queue.shift();
      if (line === null) return { done: true, value: null };
      return { done: false, value: new TextEncoder().encode(line + "\n") };
    } }) } };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) + `
;window.__api = {
  get busy(){return busy}, get activeId(){return activeId}, get messages(){return messages}, get sessions(){return sessions},
  renderChat, renderSessions, selectSession, sendUserMessage,
  setSeed: (sess, aid) => { sessions = sess; activeId = aid; messages = sess.find(s=>s.id===aid).messages; },
};`);
const api = win.__api;
const bubblesText = () => [...doc.querySelectorAll(".st-msg")].map((n) => (n.textContent || "")).join(" | ");

(async () => {
  console.log("=== static lock: the B hook is present at the renderChat tail ===");
  const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  check("[static] B hook present: paintLive() at renderChat tail", appCode.includes("if (busy) paintLive();"));
  check("[static] paintLive helper defined as a real function",
        /function\s+paintLive\s*\(\s*\)\s*\{[\s\S]*?liveMsgEl\s*\(\s*busy\.msg\s*\)/.test(appCode));

  console.log("=== seed: A is the originator and starts streaming ===");
  const sess = [
    {id:"a", title:"A task", workspace:"", permission:"auto", messages:[{role:"user", text:"ask A1", images:[], files:[], time:Date.now()}], updatedAt:Date.now()},
    {id:"b", title:"B task", workspace:"", permission:"auto", messages:[{role:"user", text:"ask B1", images:[], files:[], time:Date.now()}], updatedAt:Date.now()},
  ];
  api.setSeed(sess, "a");
  api.renderSessions(); api.renderChat();

  queue.push('data: {"choices":[{"delta":{"content":"CHUNK-ONE"}}]}');
  const streamPromise = api.sendUserMessage("hello A");
  await sleep(120);
  check("stream running, origin A", api.activeId === "a" && api.busy && api.busy.sessionId === "a");
  check("A's bubble shows CHUNK-ONE", bubblesText().includes("CHUNK-ONE"), "screen=" + JSON.stringify(bubblesText()));

  console.log("=== a NEW chunk lands, then switch to B; on B the newest A content is NOT painted ===");
  queue.push('data: {"choices":[{"delta":{"content":"CHUNK-NEWEST"}}]}');
  await sleep(60);                 // chunk lands in A's messages array (generator accumulates it)
  api.selectSession("b");
  await sleep(120);
  check("we now view B", api.activeId === "b");
  check("[negative] on B screen, A's newest chunk is NOT shown (B cannot paint a viewed-away session)",
        !bubblesText().includes("CHUNK-NEWEST"), "screen=" + JSON.stringify(bubblesText()));

  console.log("=== switch back to A: the B hook paints the newest chunk IMMEDIATELY ===");
  api.selectSession("a");
  await sleep(120);
  check("[positive] back on A: newest chunk appears on screen immediately (paintLive fired)",
        bubblesText().includes("CHUNK-NEWEST"), "screen=" + JSON.stringify(bubblesText()));

  console.log("=== differential: same chunk in data both arms; screen differs only via switch-back ===");
  const aMsg = api.sessions.find((s) => s.id === "a").messages.find((x) => x.role === "assistant");
  check("[differential] A's messages array already held the newest chunk before switching back",
        aMsg && String(aMsg.text).includes("CHUNK-NEWEST"));

  queue.push(null);
  await streamPromise;
  await sleep(60);
  check("stream ended, busy cleared", !api.busy);

  const fails = results.filter(([, c]) => !c);
  console.log("");
  console.log(fails.length ? "GATE-B SWITCHBACK: " + fails.length + " FAILURE(S)" : "GATE-B SWITCHBACK: ALL PASSED");
  process.exit(fails.length ? 1 : 0);
})();
