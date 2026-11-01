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
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = {
  get busy(){return busy}, get activeId(){return activeId}, get messages(){return messages},
  renderChat, renderSessions, sendUserMessage, setInputValue:(v)=>{const i=document.getElementById('input'); if(i) i.value=v;},
  setSeed: (sess, aid) => { sessions = sess; activeId = aid; messages = sess.find(s=>s.id===aid).messages; },
};`);
const api = win.__api;
const setHidden = (v) => Object.defineProperty(doc, "hidden", { value: v, configurable: true });
const bubbleText = () => { const bs = doc.querySelectorAll(".st-bubble"); const b = bs[bs.length - 1]; return b ? (b.textContent || "") : ""; };   // assistant bubble is the last

(async () => {
  console.log("=== static lock: the A compensation line exists with the document.hidden guard ===");
  const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
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

  queue.push(null);
  await streamPromise;
  await sleep(60);

  const fails = results.filter(([, c]) => !c);
  console.log("");
  console.log(fails.length ? "GATE-A HIDDEN-PAINT: " + fails.length + " FAILURE(S)" : "GATE-A HIDDEN-PAINT: ALL PASSED");
  process.exit(fails.length ? 1 : 0);
})();
