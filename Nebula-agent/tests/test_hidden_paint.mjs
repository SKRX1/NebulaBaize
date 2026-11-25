/* Gate A: hidden-page compensating paint (single-variable differential).
   Faithful simulation of real-browser behavior: rAF runs while the page is VISIBLE (first chunk paints
   normally), then when the page goes HIDDEN the browser PAUSES rAF -- the live turn's body text freezes,
   and ONLY the liveTimer's A-line (guarded by document.hidden) can repaint it.

   Differential (single variable = document.hidden), live session, liveTimer ticking:
     NEGATIVE  (hidden=false, rAF frozen via noop) -> newest chunk does NOT appear on the bubble (the guard is false, the only live paint channel is blocked, rAF is frozen)
     POSITIVE  (hidden=true,  rAF frozen via noop) -> newest chunk DOES appear on the bubble (the compensation line fires)
   Both arms start from a visible-rAF-painted first chunk so the arms differ ONLY by the hidden state.
   Run: node tests/test_hidden_paint.mjs */
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
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }

// Controllable rAF: a registry we can freeze on demand (simulates the browser pausing rAF when hidden).
let rafMode = "run";
const rafQ = [];
win.requestAnimationFrame = (cb) => { if (rafMode === "run") setTimeout(() => cb(win.performance.now()), 0); return 0; };
win.cancelAnimationFrame = () => {};

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
  get busy(){return busy}, get activeId(){return activeId}, get messages(){return messages},
  renderChat, renderSessions, patchSteps, sendUserMessage, setInputValue:(v)=>{const i=document.getElementById('input'); if(i) i.value=v;},
  setSeed: (sess, aid) => { sessions = sess; activeId = aid; messages = sess.find(s=>s.id===aid).messages; },
};`);
const api = win.__api;
const setHidden = (v) => Object.defineProperty(doc, "hidden", { value: v, configurable: true });
const bubbleText = () => { const bs = doc.querySelectorAll(".st-bubble"); const b = bs[bs.length - 1]; return b ? (b.textContent || "") : ""; };   // assistant bubble is the last

(async () => {
  console.log("=== static lock: the A compensation line exists with the document.hidden guard ===");
  const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  check("[static] A line present: guarded updateAssistant on document.hidden", appCode.includes("if (el && document.hidden) updateAssistant(el, m, true);"));

  console.log("=== seed live session A; rAF in RUN mode so the FIRST chunk paints normally ===");
  const sess = [{id:"a", title:"A task", workspace:"", permission:"auto", messages:[{role:"user", text:"ask A1", images:[], files:[], time:Date.now()}], updatedAt:Date.now()}];
  api.setSeed(sess, "a");
  api.renderSessions(); api.renderChat();

  queue.push('data: {"choices":[{"delta":{"content":"FIRST-VISIBLE"}}]}');
  const streamPromise = api.sendUserMessage("hello A");
  await sleep(150);   // rAF run mode: paint executes, FIRST lands on the bubble
  check("[setup] FIRST chunk painted on the bubble while visible (rAF ran)", bubbleText().includes("FIRST-VISIBLE"),
        "bubble=" + JSON.stringify(bubbleText()));

  // Now freeze rAF (browser pauses it when the page goes hidden) -- but keep document.hidden false for the NEGATIVE arm.
  rafMode = "freeze";
  setHidden(false);
  queue.push('data: {"choices":[{"delta":{"content":"NEG-NEWEST"}}]}');
  await sleep(1200);   // liveTimer ticks many times; document.hidden is false -> the compensation line is guarded OFF, rAF frozen -> NEG-NEWEST never painted
  const negBubble = bubbleText();
  check("[negative] hidden=false: guard blocks the only live paint channel -> NEG-NEWEST NOT on the bubble",
        !negBubble.includes("NEG-NEWEST") && negBubble.includes("FIRST-VISIBLE"),
        "bubble=" + JSON.stringify(negBubble));

  // SAME state, flip ONLY document.hidden -> the compensation line fires on the next tick and paints the same chunk.
  setHidden(true);
  await sleep(1200);   // liveTimer ticks, now document.hidden is true -> compensation paints
  const posBubble = bubbleText();
  check("[positive] hidden=true (single-variable flip): compensation line fires -> NEG-NEWEST now on the bubble",
        posBubble.includes("NEG-NEWEST"),
        "bubble=" + JSON.stringify(posBubble));

  console.log("=== differential summary ===");
  check("[differential] NEG arm frozen, POS arm painted; only document.hidden differed",
        !negBubble.includes("NEG-NEWEST") && posBubble.includes("NEG-NEWEST"));

  console.log("=== regression: patchSteps null-host guard + on-turn client-error dual-sink ===");
  // (2) static lock: the guard line exists in the shipped source
  check("[static] patchSteps guard present",
    appCode.includes('const bodyEl = node.querySelector(".st-steps__body");') && appCode.includes("if (!bodyEl) return;"));
  // (2) runtime: REAL patchSteps (exported via __api), node whose BODY selector returns null
  // (meta selector returns an object) -> guard must short-circuit before reconcileSegs, no throw.
  const nullHostResult = win.eval(`(function(){
    const n = { _sig:null, _user:false, _open:true, open:true,
      querySelector:(sel)=> sel.indexOf('meta')>=0 ? { textContent:'' } : null };
    try { __api.patchSteps(n, [{ src:'x', slot:'s0' }], { tools:[] }, true, null); return 'NO_THROW'; }
    catch (e) { return 'THREW:' + (e && e.constructor ? e.constructor.name : '') + ':' + (e && e.message); }
  })()`);
  check("[runtime] patchSteps body=null -> no throw (guard held)", nullHostResult === "NO_THROW", "result=" + JSON.stringify(nullHostResult));
  // (2) positive control: body present -> patchSteps proceeds PAST the guard (guard must NOT over-block)
  const okHostResult = win.eval(`(function(){
    function mkBody(){ return { textContent:'', children:[], appendChild(){}, replaceChild(){}, lastElementChild:null }; }
    const n = { _sig:null, _user:false, _open:true, open:true,
      querySelector:(sel)=> sel.indexOf('meta')>=0 ? { textContent:'' } : mkBody() };
    try { __api.patchSteps(n, [{ src:'x', slot:'s0' }], { tools:[] }, true, null); return 'PROCEEDED'; }
    catch (e) { return 'THREW:' + (e && e.constructor ? e.constructor.name : '') + ':' + (e && e.message); }
  })()`);
  check("[control] patchSteps body-present -> proceeds past guard", okHostResult === "PROCEEDED", "result=" + JSON.stringify(okHostResult));
  // (1) on-turn client exception must ALSO hit the dual sink -> POST api/interrupt-log, origin=stream, stack present.
  // The test already seeds a LIVE session (activeId set), so _recordClientError takes the on-turn branch.
  // Spy fetch (the page's postQuiet -> fetch); dispatch the REAL window.error handler with a genuine Event.
  const __spy = []; const __ofetch = win.fetch;
  win.fetch = (url, opts) => { const u=String(url); if (u.includes('interrupt-log') && opts && opts.body) __spy.push(JSON.parse(String(opts.body))); return Promise.resolve({ok:true,json:async()=>({})}); };
  const __err = new win.Error('GATE-A-PROBE'); __err.stack = 'Error: GATE-A-PROBE\n    at patchSteps';
  const __ev = new win.Event('error'); __ev.error = __err; win.dispatchEvent(__ev);
  win.fetch = __ofetch;
  const posted = __spy.filter((e) => e && e.entry && e.entry.origin === 'stream' && e.entry.msg && String(e.entry.msg).includes('GATE-A-PROBE'));
  check("[runtime] on-turn client error -> JSONL sink POST (origin=stream, stack present)",
    posted.length >= 1 && posted[0].entry.stack && String(posted[0].entry.stack).includes('patchSteps'),
    "posted=" + JSON.stringify(posted.map((e)=>({origin:e.entry.origin,msg:e.entry.msg,hasStack:!!e.entry.stack}))));

  queue.push(null);
  await streamPromise;
  await sleep(60);

  const fails = results.filter(([, c]) => !c);
  console.log("");
  console.log(fails.length ? "GATE-A HIDDEN-PAINT: " + fails.length + " FAILURE(S)" : "GATE-A HIDDEN-PAINT: ALL PASSED");
  process.exit(fails.length ? 1 : 0);
})();
