/* Regression test for the recoverable turn-stop UI.
 *
 * Bug this pins: one `turn budget exceeded` stop showed up as FIVE identical red boxes.
 * `updateAssistant` appended a `.msg-error` node on every repaint, so the rAF frames
 * between the error chunk and the end of the turn each added another copy.
 *
 * Also pins the new wording contract: a stop (turn budget / idle watchdog / round cap) is a
 * neutral `.msg-notice` with a 继续 button — not a red error — and it is translatable.
 *
 * Boots the REAL index.html + app.js + i18n.js in jsdom.
 * Run: node tests/test_stop_notice.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
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
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");

win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = { updateAssistant, noticeText, msgEl, setLang: (l) => { setLang(l); } };`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;

// ── 1) one error bubble, no matter how many repaints ────────────────────────────
console.log("\n=== 1: a single error must not pile up ===");
{
  const m = { role: "assistant", text: "", reasoning: "", time: Date.now(), error: "upstream error: boom" };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  for (let i = 0; i < 5; i++) api.updateAssistant(el, m, i < 4);   // streaming repaints, then final
  const errs = el.querySelectorAll(".msg-error");
  check("exactly one .msg-error after 5 paints", errs.length === 1, `got ${errs.length}`);
  check("the error text is shown", errs[0] && /boom/.test(errs[0].textContent));
  el.remove();
}

// ── 2) a stop notice is neutral, single, and offers 继续 ────────────────────────
console.log("\n=== 2: stop notice (not an error) + continue button ===");
{
  const m = {
    role: "assistant", text: "已写入 14 个文件", reasoning: "", time: Date.now(),
    tools: [{ id: "c1", name: "filesystem__write", state: "done", at: 0, rat: 0 }],
    notice: { code: "turn_budget", budget_s: 3600, rounds: 12, resumable: true },
    canContinue: true,
  };
  const el = api.msgEl(m, 1);
  doc.getElementById("chat").appendChild(el);
  for (let i = 0; i < 4; i++) api.updateAssistant(el, m, i < 3);
  const notes = el.querySelectorAll(".msg-notice");
  check("exactly one .msg-notice", notes.length === 1, `got ${notes.length}`);
  check("no red .msg-error for a stop", el.querySelectorAll(".msg-error").length === 0);
  check("notice names the 60-minute ceiling and the round count",
    notes[0] && /60/.test(notes[0].textContent) && /12/.test(notes[0].textContent),
    notes[0] && notes[0].textContent);
  const cont = el.querySelector(".continue-btn");
  check("continue button is offered", cont && !cont.hidden);
  check("tool calls and answer text survive the stop",
    !!el.querySelector(".st-bubble") && /已写入 14 个文件/.test(el.querySelector(".st-bubble").textContent));
  el.remove();
}

// ── 3) error + notice can coexist, one each ─────────────────────────────────────
console.log("\n=== 3: both banners, still one of each ===");
{
  const m = { role: "assistant", text: "partial", time: Date.now(), error: "upstream error: x", notice: { code: "idle", idle_s: 180 } };
  const el = api.msgEl(m, 2);
  doc.getElementById("chat").appendChild(el);
  for (let i = 0; i < 3; i++) api.updateAssistant(el, m, false);
  check("one .msg-error", el.querySelectorAll(".msg-error").length === 1);
  check("one .msg-notice", el.querySelectorAll(".msg-notice").length === 1);
  el.remove();
}

// ── 4) wording is translated, not hard-coded ────────────────────────────────────
console.log("\n=== 4: notice text comes from i18n ===");
{
  // Read the dictionaries directly: switching the live language re-renders the whole shell
  // (and starts its polling timers), which is out of scope here.
  const zh = win.i18n._dict.zh, en = win.i18n._dict.en;
  check("zh wording exists for the round cap",
    /上限/.test(zh["chat.notice.rounds"] || "") && /\{n\}/.test(zh["chat.notice.rounds"] || ""),
    zh["chat.notice.rounds"]);
  check("zh and en use the same placeholders for every notice", [
    ["chat.notice.budget", ["{m}", "{n}"]],
    ["chat.notice.idle", ["{s}"]],
    ["chat.notice.rounds", ["{n}"]],
  ].every(([k, ph]) => ph.every((p) => (zh[k] || "").includes(p) && (en[k] || "").includes(p))));
  const idle = api.noticeText({ code: "idle", idle_s: 180 });
  check("idle text names the stall window", /180/.test(idle), idle);
  const unknown = api.noticeText({ code: "weird", text: "custom text" });
  check("unknown code falls back to the server text", unknown === "custom text", unknown);
}

console.log("");
if (FAILURES.length) {
  console.log("STOP NOTICE: " + FAILURES.length + " FAILED");
  FAILURES.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("STOP NOTICE: ALL PASSED");
process.exit(0);   // jsdom keeps the app's polling timers alive; end the run explicitly
