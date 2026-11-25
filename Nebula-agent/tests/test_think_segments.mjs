/* Regression test for how a turn's THINKING is shown.
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom and drives the real render path.
 * The rule under test: a turn is ONE timeline - the thought that led to a call sits next to that
 * call - and every thought folds to a single line unless it is the one still being written.
 *
 *   T1  time order: reasoning slices (by `rat`) and answer slices (by `at`) interleave around the
 *       tool blocks, so the DOM order is th, tool, md, tool, th, md - not "one blob, then tools".
 *   T2  folded by default: a finished turn shows only a one-sentence peek + a char count.
 *   T3  the live thought: while only reasoning streams, that segment is open and titled 思考中.
 *   T4  a long thought is marked "deep" so one burst can't take over the screen.
 *   T5  a burst of identical calls is labelled 1/3, 2/3, 3/3 instead of reading as loose blocks.
 *   T6  fold-all / expand-all: one button over the whole turn, label flips with the state.
 *   T7  no reasoning at all -> the old plain markdown answer, no thought block appears.
 *   T8  opening a folded thought builds its body lazily (a 20k-char body is never built unseen).
 *
 * Run: node tests/test_think_segments.mjs
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
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");   // stable English strings

win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  t: (k, p) => t(k, p),
  answerSpec, paintBubble, msgEl, updateAssistant, thinkPeek, toolSeq, foldAll, syncFoldBtn,
  setMessages: (v) => { messages = v; },
  setBusy: (v) => { busy = v; },
  setShow: (v) => { settings.show = v; },
};`;
win.eval(appCode);
const api = win.__api;

// reasoning / text are built so the slice boundaries are unambiguous at a glance
const R = "0123456789" + "abcdefghij" + "klmnopqrst";       // 30 chars
const A = "wxyz";                                            // 4 chars of answer
const turn = () => ({
  role: "assistant", time: Date.now(),
  reasoning: R, text: A,
  tools: [
    {id: "1", name: "read_file", server: "fs", tool: "read_file", at: 0, rat: 10, state: "done", ok: true, result: "r1"},
    {id: "2", name: "run_command", server: "shell", tool: "run_command", at: 2, rat: 20, state: "done", ok: true, result: "r2"},
  ],
});
const slots = (spec) => spec.map((s) => s.slot);
const seg = (spec, slot) => spec.find((s) => s.slot === slot);

console.log("\n=== T1: one timeline (thought / call / answer interleaved) ===");
{
  const spec = api.answerSpec(turn());
  check("segments come out in the order they happened  " + JSON.stringify(slots(spec)),
        JSON.stringify(slots(spec)) === JSON.stringify(["th0", "t0", "md1", "th1", "t1", "th2", "md2"]));
  check("each thought sits directly in front of the call it produced",
        slots(spec).indexOf("th1") + 1 === slots(spec).indexOf("t1"));
  check("the thought before call #1 is its own slice  " + JSON.stringify(seg(spec, "th0").think),
        seg(spec, "th0").think === "0123456789");
  check("the thought between the two calls is its own slice  " + JSON.stringify(seg(spec, "th1").think),
        seg(spec, "th1").think === "abcdefghij");
  check("the thought after call #2 is its own slice  " + JSON.stringify(seg(spec, "th2").think),
        seg(spec, "th2").think === "klmnopqrst");
  check("the answer is split where the calls happened", seg(spec, "md1").src === "wx" && seg(spec, "md2").src === "yz");
}

console.log("\n=== T2: a finished turn folds itself to one line per thought ===");
{
  const m = turn();
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  const thinks = [...el.querySelectorAll(".st-think")];
  check("three thought segments rendered", thinks.length === 3, `got ${thinks.length}`);
  check("all of them are folded", thinks.every((d) => !d.open));
  check("each shows a one-line peek", thinks.every((d) => (d.querySelector(".st-think__peek").textContent || "").length > 0));
  check("the peek is a sentence, not the whole thought", api.thinkPeek("先确认配置来源。然后再检查字典。") === "先确认配置来源。",
        JSON.stringify(api.thinkPeek("先确认配置来源。然后再检查字典。")));
  check("each shows its size", thinks.every((d) => /\d/.test(d.querySelector(".st-think__chars").textContent || "")));
  check("a folded body is left empty (built on demand)", thinks.every((d) => !d.querySelector(".st-collapse__body").textContent));
  el.remove();
}

console.log("\n=== T3: the thought still being written stays open ===");
{
  const m = {role: "assistant", time: Date.now(), reasoning: R, text: "", tools: []};
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, true);
  const d = el.querySelector(".st-think");
  check("the live thought is open", !!d && d.open);
  check("it is titled as running  " + JSON.stringify(d.querySelector(".st-think__title").textContent),
        d.querySelector(".st-think__title").textContent === "Thinking…");
  check("its body carries the whole thought", d.querySelector(".st-collapse__body").textContent === R);
  check("it is flagged live for the CSS", d.dataset.state === "live");
  // the design changed (2026-10-21): while the answer streams the thought is STILL the latest
  // turn being written, so with show on it stays open; only a manual fold or a NEW turn folds it
  m.text = "答案";
  api.updateAssistant(el, m, true);
  const d2 = el.querySelector(".st-think");
  check("the answer arriving does NOT steal the latest thought (show on)", d2.open);
  el.remove();
}

console.log("\n=== T4: a long thought is marked deep ===");
{
  const m = {role: "assistant", time: Date.now(), reasoning: "x".repeat(1200), text: "", tools: []};
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  const d = el.querySelector(".st-think");
  check("flagged long", d.dataset.long === "1");
  check("titled as deep thinking  " + JSON.stringify(d.querySelector(".st-think__title").textContent),
        d.querySelector(".st-think__title").textContent === "Deep thinking");
  el.remove();
}

console.log("\n=== T5: a burst of identical calls reads as one run ===");
{
  const m = {role: "assistant", time: Date.now(), reasoning: "", text: "ok",
             tools: [0, 1, 2].map((i) => ({id: String(i), name: "read_file", server: "fs", tool: "read_file",
                                           at: 0, rat: 0, state: "done", ok: true, result: "r" + i}))};
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  const seqs = [...el.querySelectorAll(".tool-call__seq")].map((n) => n.textContent);
  check("labelled 1/3, 2/3, 3/3  " + JSON.stringify(seqs), JSON.stringify(seqs) === JSON.stringify(["1/3", "2/3", "3/3"]));
  const same = [...el.querySelectorAll(".tool-call")].map((n) => n.dataset.same);
  check("the 2nd and 3rd are marked as a continuation  " + JSON.stringify(same),
        JSON.stringify(same) === JSON.stringify(["0", "1", "1"]));
  el.remove();
}

console.log("\n=== T6: fold all / expand all over the whole turn ===");
{
  const m = turn();
  api.setMessages([m]);
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  const btn = el.querySelector("[data-action='fold']");
  check("the button is offered (more than one block)", btn && !btn.hidden);
  check("it offers to expand while things are folded  " + JSON.stringify(btn.textContent), btn.textContent === "Expand all");
  btn.dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  const thinks = [...el.querySelectorAll(".st-think")], calls = [...el.querySelectorAll(".tool-call")];
  check("everything opens", thinks.every((d) => d.open) && calls.every((d) => d.open));
  const btn2 = el.querySelector("[data-action='fold']");
  check("it now offers to fold  " + JSON.stringify(btn2.textContent), btn2.textContent === "Collapse all");
  btn2.dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("and everything folds again", [...el.querySelectorAll(".st-think")].every((d) => !d.open)
                                   && [...el.querySelectorAll(".tool-call")].every((d) => !d.open));
  el.remove();
}

console.log("\n=== T7: a plain answer keeps the plain layout ===");
{
  const m = {role: "assistant", time: Date.now(), reasoning: "", text: "只是回答", tools: []};
  const spec = api.answerSpec(m);
  check("no thought segment at all  " + JSON.stringify(slots(spec)), JSON.stringify(slots(spec)) === JSON.stringify(["md0"]));
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  check("no thought block in the DOM", el.querySelectorAll(".st-think").length === 0);
  el.remove();
}

console.log("\n=== T8: opening a folded thought builds its body then ===");
{
  const m = turn();
  api.setMessages([m]);
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, false);
  const d = el.querySelector(".st-think");
  check("starts empty", !d.querySelector(".st-collapse__body").textContent);
  d.open = true;
  d.dispatchEvent(new win.Event("toggle", {bubbles: true}));
  check("the body appears on open", d.querySelector(".st-collapse__body").textContent === "0123456789");
  check("and the choice is remembered", !!(m.thinkOpen && m.thinkOpen.th0 === true));
  el.remove();
}

console.log("\n=== T9: a thought is never cut in the middle of a sentence ===");
{
  const src = "先确认配置来源。再检查字典里的翻译是否齐全。";
  // tool #1 fires 5 chars in - right inside the first sentence
  const spec = api.answerSpec({role: "assistant", text: "", reasoning: src, tools: [
    {id: "1", name: "a", server: "s", tool: "a", at: 0, rat: 5, state: "done", ok: true, result: "r"},
    {id: "2", name: "b", server: "s", tool: "b", at: 0, rat: 25, state: "done", ok: true, result: "r"},
  ]});
  const ths = spec.filter((s) => s.think != null).map((s) => s.think);
  check("the cut moves to the end of that sentence  " + JSON.stringify(ths[0]), ths[0] === "先确认配置来源。");
  check("the slices still re-join to the original thought", ths.join("") === src, JSON.stringify(ths));
  check("every slice before the last ends on a sentence",
        ths.slice(0, -1).every((s) => /[。！？!?；;\n]$/.test(s)), JSON.stringify(ths));
}

console.log("");
if (FAILURES.length) {
  console.log(`THINK SEGMENTS: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("THINK SEGMENTS: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);   // app.js leaves timers running in jsdom; exit explicitly
