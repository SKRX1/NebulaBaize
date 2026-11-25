/* E2E browser-like run: A streams -> switch to B -> copy/edit history -> back to A
   shows the newest stream content -> A finishes -> badge goes out.
   Same jsdom harness as test_sidebar_tree.mjs; all app calls go through the exposed __api. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");
const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window; const doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.confirm = () => true;
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
let copied = "";
Object.defineProperty(win.navigator, "clipboard", { value: { writeText: async (txt) => { copied = txt; } }, configurable: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, cond, extra = "") => { results.push([label, cond]); console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : "")); };

/* ---- controllable stream reader: chunks queued on demand ---- */
const queue = [];              // pending data-lines; null sentinel = end
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
  get sessions(){return sessions}, get activeId(){return activeId}, get messages(){return messages},
  get busy(){return busy},
  renderChat, renderSessions, selectSession, sendUserMessage, send, setInputValue: (v) => { const i = document.getElementById('input'); if (i) i.value = v; },
  setSeed: (sess, aid) => { sessions = sess; activeId = aid; messages = sess.find(s=>s.id===aid).messages; },
};`);
const api = win.__api;

/* ================= the run ================= */
(async () => {
  console.log("=== seed: two tasks; A is the originator and starts streaming ===");
  const sess = [
    {id: "a", title: "A task", workspace: "", permission: "auto", messages: [{role: "user", text: "ask A1", images: [], files: [], time: Date.now()}], updatedAt: Date.now()},
    {id: "b", title: "B task", workspace: "", permission: "auto", messages: [{role: "user", text: "ask B1", images: [], files: [], time: Date.now()}], updatedAt: Date.now()},
  ];
  api.setSeed(sess, "a");
  api.renderSessions(); api.renderChat();

  const rowA = () => { const r = doc.querySelector('.st-session[data-sid="a"]'); return r && /running/.test(r.className); };   // single-dot merge: row .running
  const rowB = () => { const r = doc.querySelector('.st-session[data-sid="b"]'); return r && /running/.test(r.className); };   // single-dot merge: row .running

  console.log("=== step 1: start the stream on A ===");
  queue.push('data: {"choices":[{"delta":{"content":"stream-chunk-1"}}]}');
  const streamPromise = api.sendUserMessage("hello A");   // pushes the user msg, then streamAssistant
  await sleep(50);
  check("stream is running, originator is A", api.activeId === "a" && api.busy && api.busy.sessionId === "a");
  check("sidebar badge lights A's row", !!rowA());
  check("B's row has no badge", !rowB());

  console.log("=== step 2: new chunk arrives, switch to B mid-stream ===");
  queue.push('data: {"choices":[{"delta":{"content":"stream-chunk-2"}}]}');
  await sleep(30);
  api.selectSession("b");
  await sleep(30);
  check("we now view B", api.activeId === "b");
  check("badge STILL on A (the originator)", !!rowA() && !rowB());
  check("B shows its own history", api.messages.some((x) => x.text === "ask B1"));

  console.log("=== step 3: on B, copy the history message ===");
  const bMsg = [...doc.querySelectorAll(".st-msg")].find((n) => (n.textContent || "").includes("ask B1"));
  const copyBtn = bMsg && bMsg.querySelector('[data-action="copy"]');
  check("the history message exposes the copy button", !!copyBtn);
  if (copyBtn) { copyBtn.click(); await sleep(10); }
  check("copy delivered B's history text", copied.includes("ask B1"), "copied=" + JSON.stringify(copied));

  console.log("=== step 4: on B, edit the history message (textarea accepts typing) ===");
  const editBtn = bMsg && bMsg.querySelector('[data-action="edit"]');
  check("the history message exposes the edit button", !!editBtn);
  if (editBtn) { editBtn.click(); await sleep(10); }
  const area = doc.querySelector("#edit-area");
  check("the edit textarea is open", !!area);
  if (area) { area.value = "edited B1 text"; check("textarea accepts typed text", area.value === "edited B1 text"); }

  console.log("=== step 5: a new chunk lands while viewing B; switch back to A -> newest content visible ===");
  queue.push('data: {"choices":[{"delta":{"content":"stream-chunk-3-NEWEST"}}]}');
  await sleep(30);
  api.selectSession("a");
  await sleep(30);
  const streamMsg = api.messages.find((x) => x.role === "assistant");
  check("back on A: the live message shows the newest chunk", streamMsg && String(streamMsg.text).includes("stream-chunk-3-NEWEST"),
        "text=" + (streamMsg ? JSON.stringify(streamMsg.text) : "none"));
  check("badge still marks A as the running task", !!rowA() && !rowB());

  console.log("=== step 6: stream finishes -> attribution correct, badge out ===");
  queue.push(null);
  await streamPromise;
  await sleep(60);
  check("busy cleared", !api.busy);
  check("badge is OUT everywhere (A finished)", !rowA() && !rowB());
  const aSess = api.sessions.find((s) => s.id === "a");
  check("A's saved history holds the finished stream", aSess && aSess.messages.some((x) => x.role === "assistant" && String(x.text).includes("stream-chunk-3-NEWEST")));
  const bSess = api.sessions.find((s) => s.id === "b");
  check("B's stored history is its own (user msg only, unedited-draft not committed)",
        bSess && bSess.messages.length === 1 && bSess.messages[0].text === "ask B1");

  console.log("=== step 7: send-guard re-check -- type on B while A streams: typing ok, send guarded ===");
  queue.push('data: {"choices":[{"delta":{"content":"second-run-chunk"}}]}');
  const p2 = api.sendUserMessage("again A");
  await sleep(40);
  api.selectSession("b"); await sleep(20);
  check("typing on B is possible (badge only on A)", !!rowA() && !rowB());
  const beforeLen = api.messages.length;
  api.setInputValue("text typed on B");
  await api.send();                          // composer guard: busy -> warn toast, no append
  await sleep(30);
  check("send on B is guarded (no message added)", api.messages.length === beforeLen,
        "len " + beforeLen + " -> " + api.messages.length);
  // 2026-10-21: the guard must be VISIBLE -- the composer path now pops a warn toast
  const toasts = [...doc.querySelectorAll("#toasts .st-toast")];
  const busyToast = toasts.find((n) => (n.textContent || "").includes("Still writing"));
  check("the guard answered with a visible warn toast", !!busyToast,
        "toasts in DOM: " + toasts.length + (busyToast ? " (title: " + JSON.stringify(busyToast.querySelector(".st-toast__title").textContent) + ")" : ""));
  queue.push(null);
  await p2; await sleep(40);
  check("second stream ended cleanly, badge out", !api.busy && !rowA() && !rowB());
  const aSess2 = api.sessions.find((s) => s.id === "a");
  check("second stream landed in A's history too", aSess2 && aSess2.messages.some((x) => x.role === "assistant" && String(x.text).includes("second-run-chunk")));

  const fails = results.filter(([, c]) => !c);
  console.log("");
  console.log(fails.length ? "E2E: " + fails.length + " FAILURE(S)" : "E2E: ALL PASSED");
  process.exit(fails.length ? 1 : 0);
})();
