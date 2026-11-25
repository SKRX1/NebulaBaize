/* Differential test for the 2026-10-21 design change: the SHOW switch now owns the LATEST
 * message's thoughts, not only the live stream.
 *
 * The rule under test (app.js thinkOpen, manual intent wins first):
 *   1  show ON  + latest message          -> thought OPEN      (the user's A)
 *   2  show ON  + an older message        -> folded            (history stays scannable)
 *   3  show OFF + latest message          -> folded            (the switch owns it both ways)
 *   4  show ON  + latest + manual fold    -> folded            (a manual toggle beats the rule)
 *   5  show ON  + older + manual expand  -> open              (the old manual-keep rule survives)
 *   6  show ON  + streaming latest        -> open (and stays open when the first answer token lands)
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom, like test_think_segments.mjs.
 * Run: node tests/test_think_latest_open.mjs
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
const check = (label, cond, detail) => {
  const ok = !!cond;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) FAILURES.push(label);
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

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  t: (k, p) => t(k, p),
  answerSpec, paintBubble, msgEl, updateAssistant, latestMsg, thinkOpen,
  setMessages: (v) => { messages = v; },
  setBusy: (v) => { busy = v; },
  setShow: (v) => { settings.show = v; }, getShow: () => settings.show, getSettings: () => settings, setStepsFold: (v) => { settings.stepsFold = v; },
};`;
win.eval(appCode);
const api = win.__api;

const THOUGHT = "First sentence of the thought. Then more reasoning follows here.";
const mk = (extra) => ({ role: "assistant", time: Date.now(), reasoning: THOUGHT, text: "answer", tools: [], ...extra });

function paint(m, streaming) {
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.updateAssistant(el, m, !!streaming);
  return el;
}
const foldOf = (el) => [...el.querySelectorAll(".st-think")].map((d) => d.open);

// ─── 1: show ON, single (latest) message → open ───────────────────────────
console.log("\n=== 1: latest message keeps its thought open while show is ON ===");
{
  api.setShow(true);
  const m = mk();
  api.setMessages([m]);
  const el = paint(m, false);
  check("the latest thought is open", foldOf(el).every((o) => o), JSON.stringify(foldOf(el)));
  el.remove();
}

// ─── 2: show ON, the OLDER of two messages → folded ───────────────────────
console.log("\n=== 2: an older message stays folded ===");
{
  api.setShow(true);
  const old = mk({ time: 1000 }), latest = mk({ time: 2000 });
  api.setMessages([old, latest]);
  const elOld = paint(old, false);
  const elNew = paint(latest, false);
  check("the older thought stays folded", foldOf(elOld).every((o) => !o), JSON.stringify(foldOf(elOld)));
  check("the newest thought is open", foldOf(elNew).every((o) => o), JSON.stringify(foldOf(elNew)));
  elOld.remove(); elNew.remove();
}

// ─── 3: show OFF, latest message → folded (the switch owns it both ways) ───
console.log("\n=== 3: show OFF folds the latest thought too ===");
{
  api.setShow(false);
  const m = mk();
  api.setMessages([m]);
  const el = paint(m, false);
  check("show OFF means folded even for the latest", foldOf(el).every((o) => !o), JSON.stringify(foldOf(el)));
  el.remove();
}

// ─── 4: show ON, latest, but the user folded it by hand → folded ──────────
console.log("\n=== 4: a manual fold beats the auto-expand ===");
{
  api.setShow(true);
  const m = mk({ thinkOpen: {} });
  api.setMessages([m]);
  const el = paint(m, false);
  const slot = el.querySelector(".st-think").dataset.slot;
  m.thinkOpen[slot] = false;                     // the user clicked it shut
  api.updateAssistant(el, m, false);
  check("the manual fold holds", foldOf(el).every((o) => !o), JSON.stringify(foldOf(el)));
  el.remove();
}

// ─── 5: show ON, older message, but the user expanded it → open ───────────
console.log("\n=== 5: a manual expand on an older turn still works ===");
{
  api.setShow(true);
  const old = mk({ time: 1000, thinkOpen: {} }), latest = mk({ time: 2000 });
  api.setMessages([old, latest]);
  const elOld = paint(old, false);
  paint(latest, false);
  const slot = elOld.querySelector(".st-think").dataset.slot;
  old.thinkOpen[slot] = true;                    // the user pinned it open
  api.updateAssistant(elOld, old, false);
  check("the pinned thought stays open", foldOf(elOld).every((o) => o), JSON.stringify(foldOf(elOld)));
  elOld.remove();
}

// ─── 6: streaming latest: stays open when the first answer token lands ────
console.log("\n=== 6: the stream keeps its thought open after the first answer token ===");
{
  api.setShow(true);
  const m = { role: "assistant", time: Date.now(), reasoning: THOUGHT, text: "", tools: [] };
  api.setMessages([m]);
  const el = paint(m, true);
  check("open while only reasoning streams", foldOf(el).every((o) => o), JSON.stringify(foldOf(el)));
  m.text = "answer";
  api.updateAssistant(el, m, true);
  check("still open after the answer starts (design change B)", foldOf(el).every((o) => o), JSON.stringify(foldOf(el)));
  el.remove();
}

// --- T7 (2026-10-21): segment-level scroll mid-stream ---
{
  // reasoning split by ONE tool into two thought slices: th0 (before) + th1 (the live tail)
  const m = { role: "assistant", time: Date.now(),
              reasoning: "First thought slice here. Second thought slice here.",
              text: "", tools: [{ at: 0, rat: 25, server: "x", tool: "t", state: "ok" }], };
  const spec = api.answerSpec(m);
  const thinkSlots = spec.filter((s) => s.think != null).map((s) => s.slot);
  check("T7 setup: the thought was split into two segments", thinkSlots.length === 2, JSON.stringify(thinkSlots));

  const el = paint(m, true);   // mid-stream: only the LAST thought segment is the live one
  const fold = [...el.querySelectorAll(".st-think")].map((d) => ({ slot: d.dataset.slot, open: d.open }));
  const openSlots = fold.filter((f) => f.open).map((f) => f.slot);
  const closedSlots = fold.filter((f) => !f.open).map((f) => f.slot);
  check("T7 mid-stream: only the live (last) thought segment is open", openSlots.length === 1 && openSlots[0] === thinkSlots[thinkSlots.length - 1],
        JSON.stringify(fold));
  check("T7 mid-stream: the earlier thought segment auto-collapsed", closedSlots.length === 1 && closedSlots[0] === thinkSlots[0],
        JSON.stringify(closedSlots));
  el.remove();

  // same message, finished (non-streaming, latest): the whole message opens (T1 rule survives)
  api.setMessages([m]);   // register m as the newest so latestMsg sees it (T7 assertion needs this)
  api.setStepsFold(false);   // work-log group folds earlier thoughts when stepsFold is on; test the segment-scroll rule itself
  const el2 = paint(m, false);
  const allOpen = [...el2.querySelectorAll(".st-think")].every((d) => d.open);
  check("T7 finished latest: every thought segment opens", allOpen, JSON.stringify([...el2.querySelectorAll(".st-think")].map((d) => d.open)));
  el2.remove();
}

console.log("");
if (FAILURES.length) {
  console.log(`THINK LATEST-OPEN: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("THINK LATEST-OPEN: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);   // app.js leaves timers running in jsdom; exit explicitly
