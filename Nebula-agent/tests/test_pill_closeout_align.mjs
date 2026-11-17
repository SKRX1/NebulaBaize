/* 差分门禁（2026-11-02 拍板锁）：收尾完成窗口内 pill 文字必须与图标同步翻 done/idle，
   不得停留在上一 poll 帧的 "generating · … tok/s"。防"正文已完成、状态条滞后一个轮询周期"回归。

契约（真 app.js + 真 i18n.js + 真 index.html，jsdom 加载）：setPill(state,text,working) 里——
  A. 完成窗口内 (Date.now()<nebDoneUntil) 且 working=false -> pill.dataset.state="done"、pill-text=t(mon.state.idle)。
     这正是 streamAssistant 正常收尾(bumpNebDone置窗+busy=null->render走idle分支working=false)的真实路径。
  B. 对照组·窗口外 (bump前 nebDoneUntil=0，真实时钟下 Date.now()<0 恒 false) -> setPill("generating",X,false)
     原样保留 X（done覆盖不触发）。
  C. 对照组·窗口内但 working=true -> done分支被 !working 挡住，dataset.state="reading"、文案保留原值。

测试本体纯 ASCII：语言设 en、断言比较取 t() 当前串与 ASCII 字面，中文只作展示不参与匹配（遵 RULES）。
Run: node tests/test_pill_closeout_align.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", { configurable: true, value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } } });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { setPill, bumpNebDone, t };`);
const api = win.__api;
const T = (k) => api.t(k);

const pill = doc.getElementById("pill");
const pillText = doc.getElementById("pill-text");
check("DOM has #pill and #pill-text", !!pill && !!pillText, JSON.stringify({pill:!!pill,text:!!pillText}));
if (!pill || !pillText) { console.log("\nFAILED: missing pill DOM, cannot continue."); process.exit(1); }

/* ═══════ B (run first while nebDoneUntil is still 0 -> outside the window) ═══════ */
console.log("\n=== B: OUTSIDE closeout window -> setPill keeps its own state/text ===");
{
  api.setPill("generating", "STALE-text-generating", false);   // working=false but window not armed yet
  check("B1 dataset.state stays generating (no done override)", pill.dataset.state === "generating", JSON.stringify(pill.dataset.state));
  check("B2 text is the caller's string, NOT auto-idle", pillText.textContent === "STALE-text-generating", JSON.stringify(pillText.textContent));
}

/* ═══════ C: INSIDE window but working=true -> guard !working blocks the done override ═══════ */
console.log("\n=== C: inside window, working=true -> done branch NOT taken (guard holds) ===");
{
  api.bumpNebDone();                                          // arm the closeout window (now .. +1.3 s real time)
  api.setPill("reading", "READ-text", true);                  // working=true blocks !working condition
  check("C1 dataset.state stays reading (guard held)", pill.dataset.state === "reading", JSON.stringify(pill.dataset.state));
  check("C2 text is the caller's string, NOT auto-idle", pillText.textContent === "READ-text", JSON.stringify(pillText.textContent));
}

/* ═══════ A: INSIDE window AND working=false -> text+state flip to done/idle (the fix) ═══════ */
console.log("\n=== A: inside window, working=false -> pill aligns with the icon (done / idle) ===");
{
  // still within the just-armed window on a real (sub-second) test run
  api.setPill("generating", "STALE-text-generating-81.3", false);   // simulate: text lagging last poll frame, busy cleared
  check("A1 dataset.state flips to done", pill.dataset.state === "done", JSON.stringify(pill.dataset.state));
  check("A2 text flips to the idle label (icon+text aligned)", pillText.textContent === T("mon.state.idle"), JSON.stringify({got:pillText.textContent, want:T("mon.state.idle")}));
}

console.log("");
if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | ")); process.exit(1); }
console.log("PILL-CLOSEOUT-ALIGN: ALL GREEN");
process.exit(0);
