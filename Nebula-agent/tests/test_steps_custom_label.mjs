/* 差分门禁（2026-11-02 拍板锁）：选建议条后输入框有内容 -> 按钮文案必含"自定义"标识，
   且 action row 的实时预览行 .next-steps__custom 必须显字。防"选完 chip 打字按钮不刷新"回归。

契约（真 app.js + 真 i18n.js，jsdom 加载）：syncStepsSendLabel 重算时——
  A. composer(#input) 空        -> 按钮 = send.n（无自定义），预览行 hidden=true、文本为空；
  B. composer 有内容           -> 按钮必含"自定义/+ custom"(send.custom)，预览行 hidden=false 且 textContent 非空；
  C. IME/paste 兜底绑定存在    -> app.js 源码里 composer 上确有 compositionend 与 paste->__nsSync（中文打字/粘贴即时刷新）；
  D. i18n custom.preview 键 zh+en 齐全。

测试本体保持纯 ASCII：断言统一把语言设为 en，比较用 t() 取当前串，中文字面不参与匹配（遵 RULES「测试断言走 ASCII」）。
Run: node tests/test_steps_custom_label.mjs
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
win.localStorage.setItem("strata.lang", "en");     // pure-ASCII assertions compare against en strings
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", { configurable: true, value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } } });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const APP_SRC = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(APP_SRC + `
;window.__api = { syncStepsSendLabel, t };`);
const api = win.__api;
const T = (k) => api.t(k);

/* build an action row mirroring renderNextSteps output: send button + preview span */
function mountRow() {
  const host = doc.createElement("div");
  host.innerHTML = '<span class="next-steps__acts">' +
    '<button data-steps-send data-n="2">seed</button>' +
    '<button data-steps-clear>clear</button>' +
    '<span class="next-steps__custom"></span></span>';
  doc.body.appendChild(host);
}
mountRow();

const composer = doc.getElementById("input");   // contenteditable composer (present in index.html)
const btn = () => doc.querySelector("[data-steps-send]");
const prev = () => doc.querySelector(".next-steps__custom");

/* ═══════ A: empty composer -> send.n label, preview hidden & empty ═══════ */
console.log("\n=== A: empty composer -> plain count label, no custom ===");
{
  if (composer) composer.textContent = "";       // jsdom has no innerText; ceText falls back to textContent
  api.syncStepsSendLabel();
  check("A1 button equals send.n (no +custom)", btn().textContent.trim() === T("nextsteps.send.n").replace("{n}","2"), JSON.stringify(btn().textContent));
  check("A2 preview hidden", prev().hidden === true, JSON.stringify(prev().hidden));
  check("A3 preview text empty", (prev().textContent || "") === "", JSON.stringify(prev().textContent));
}

/* ═══════ B: typed content -> button MUST carry the custom marker + preview shows it ═══════ */
console.log("\n=== B: typed content -> label MUST include custom, preview non-empty ===");
{
  if (composer) composer.textContent = "some typed instruction";
  api.syncStepsSendLabel();
  check("B1 button contains the custom marker", btn().textContent.includes(T("nextsteps.send.custom").replace("{n}","2")), JSON.stringify(btn().textContent));
  check("B2 label carries the picked-count n=2", (btn().textContent||"").includes("2"), JSON.stringify(btn().textContent));
  check("B3 preview visible", prev().hidden === false, JSON.stringify(prev().hidden));
  check("B4 preview text non-empty", (prev().textContent || "").trim().length > 0, JSON.stringify(prev().textContent));
}

/* ═══════ C: IME/paste fallback bound on the composer in app.js source ═══════ */
console.log("\n=== C: compositionend + paste->__nsSync fallback present (IME refresh) ===");
{
  check("C1 composer has a compositionend listener", /addEventListener\(\s*["']compositionend["']/.test(APP_SRC), "");
  check("C2 the fallback handler is invoked on that binding", /addEventListener\(\s*["']compositionend["'],\s*\w+\)/.test(APP_SRC) && APP_SRC.includes("__nsSync"), "");
  check("C3 paste fallback refreshes via __nsSync", /addEventListener\(\s*["']paste["'][^\n]*__nsSync/.test(APP_SRC), "");
}

/* ═══════ D: i18n custom.preview present in zh + en ═══════ */
console.log("\n=== D: preview key exists (en already loaded; check both dicts) ===");
{
  const dict = win.eval("typeof i18n!=='undefined' ? (i18n._dict||i18n.dict||null) : null");
  if (dict && dict.zh && dict.en) {
    check("D1 zh+en both have custom.preview", !!dict.zh["nextsteps.custom.preview"] && !!dict.en["nextsteps.custom.preview"], JSON.stringify({zh:dict.zh["nextsteps.custom.preview"],en:dict.en["nextsteps.custom.preview"]}));
  } else {
    // fallback: grep the i18n source for the key in both language blocks
    const src = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
    check("D1 custom.preview present (grep, expect >=2 occurrences zh+en)",
      (src.match(/nextsteps\.custom\.preview/g) || []).length >= 2, String((src.match(/nextsteps\.custom\.preview/g)||[]).length));
  }
}

console.log("");
if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | ")); process.exit(1); }
console.log("STEPS-CUSTOM-LABEL: ALL GREEN");
process.exit(0);
