/* Regression for the stale-edit crash (bug:unhandledrejection, app.js messages[i].text).
 *
 * Root cause (one-hand evidence, 2026-11-13 04:53):
 *   confirmEdit() is async and AWAITS the modal paste gate (`await Promise.allSettled(pendingPastes)`)
 *   BEFORE it calls editResend(i, ...). The index `i` is snapshotted from `editingIndex` before that
 *   await. If the conversation changes DURING the await — a branch switch (`messages = clone(b.messages)`),
 *   an undo, or any stream finalize that shortens `messages` — then when confirmEdit resumes, messages[i]
 *   is undefined and `messages[i].text` throws a TypeError. Because it throws inside the async,
 *   fire-and-forget #edit-send handler (no .catch), it surfaces as an unhandled promise rejection, not a
 *   sync error. The stack pointed straight at it: editResend -> confirmEdit -> reading 'text'.
 *
 * This test reproduces the race deterministically: open the modal on message i, occupy the paste gate with
 * a promise we control, shorten `messages` past index i while confirmEdit is parked at the await, then let
 * the gate resolve. The fix must (a) raise NO unhandled rejection and (b) cancel the resend (issue NO chat
 * completion) rather than reading .text off undefined — which is what the pre-fix code did here.
 *
 * Load-bearing (differential): remove the guard and messages[i].text throws again -> both checks turn red.
 *
 * Run standalone: node tests/test_edit_resend_stale.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }

const seeded = [
  { role: "user", text: "First question", time: 1 },
  { role: "assistant", text: "First answer.", time: 2 },
  { role: "user", text: "Third question", time: 3 },      // index 2 = the one we edit
  { role: "assistant", text: "Third answer.", time: 4 },
  { role: "user", text: "Fifth question", time: 5 },
];
win.localStorage.setItem("strata.chat", JSON.stringify(seeded));

const completions = [];
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("v1/chat/completions")) { completions.push(u); return { ok: true, status: 200, json: async () => ({}), body: { getReader() { return { read() { return Promise.resolve({ value: undefined, done: true }); } }; } } }; }
  return { ok: true, status: 200, json: async () => ({}) };
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// count unhandled rejections raised INSIDE the jsdom realm (the app's own promises)
let realmRejections = 0;
win.addEventListener("unhandledrejection", () => { realmRejections++; });

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  confirmEdit, editResend, openEditModal, closeEditModal,
  getMessages: () => messages,
  setMessages: (v) => { messages = v; },
  getPending: () => pendingPastes,
};`;
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);

const api = win.__api;

const main = async () => {
  console.log("=== stale-edit race: messages shortened while confirmEdit awaits the paste gate ===");
  await sleep(30);

  check("api exposed", typeof api.confirmEdit === "function" && typeof api.getPending === "function");
  check("seeded thread has >= 3 messages", api.getMessages().length >= 3, `len=${api.getMessages().length}`);

  const EDIT_IDX = 2;
  api.openEditModal(EDIT_IDX);
  const modal = doc.querySelector("#edit-modal");
  check("edit modal opened on message index " + EDIT_IDX, !!modal && !modal.hidden);
  const ta = modal && modal.querySelector("#edit-area");
  check("modal prefilled with the target message text", !!ta && ta.textContent === "Third question", ta ? JSON.stringify(ta.textContent) : "no edit area");
  if (!modal || !ta) { console.log("\nFAILED (no modal, cannot continue)"); win.close(); process.exit(1); }
  ta.textContent = "Third question EDITED";

  // occupy the paste gate with a promise we control -> confirmEdit will park at
  // `await Promise.allSettled(pendingPastes)` and yield the event loop.
  let releaseGate;
  const gate = new Promise((res) => { releaseGate = res; });
  api.getPending().add(gate);

  // fire-and-forget, exactly like #edit-send.onclick (no .catch): a rejection here = unhandledrejection
  api.confirmEdit();

  await sleep(10);   // confirmEdit is now parked at the await; the index is already snapshotted

  // the conversation changes during the await: shorten past the snapshotted index (branch switch / undo)
  api.setMessages(seeded.slice(0, 2));   // now messages[2] is undefined

  releaseGate();      // let the paste gate resolve -> confirmEdit resumes and calls editResend(i, ...)

  await sleep(60);

  check("NO unhandled rejection was raised", realmRejections === 0, `rejections=${realmRejections}`);
  check("the stale resend was CANCELLED (no chat completion issued)", completions.length === 0, `completions=${completions.length}`);

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); win.close(); process.exit(1); }
  console.log("EDIT-RESEND-STALE: ALL PASSED");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
