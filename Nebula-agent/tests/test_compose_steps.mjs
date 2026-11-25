/* 点击建议条 = 直接执行，不再回问句（2026-10-24 落地 A+B+C）。

契约（真 app.js + 真 i18n.js，jsdom 加载）：composeStepsMessage 产出的发送文本，
对「可执行档」(recommended/普通/avoid) 与「? hold 档」都要读起来像拍板指令，不能读起来像问题。

锁住的差分象限：
  1. 单个可执行档 → 发送文本以 exec.prefix（拍板执行令）开头；
  2. 单个 ? hold 档 → 发送文本以 hold.confirm（点击即拍板·按默认执行）开头（C 档专属分支）；
  3. 多选含至少一个可执行档 → combo 编号 + 结尾追加 exec.prefixAll 提醒；
  4. 对照组：多选全是 ? hold 档 → combo 编号但不追加 exec.prefixAll（无执行令可加）；
  5. 三个新键 exec.prefix / exec.prefixAll / hold.confirm 在 zh 与 en 都齐全。

断言一律经 t()/dict 取当前语言串比对，测试本体保持纯 ASCII（中文只作展示不参与字面匹配）。
Run: node tests/test_compose_steps.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
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
win.localStorage.setItem("strata.lang", "zh");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } },
  });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { composeStepsMessage, t, dict: () => i18n._dict };`);
const api = win.__api;
const T = (k) => api.t(k);

/* ═══════ 1. 单个可执行档 → 发送文本以拍板执行令开头 ═══════ */
console.log("\n=== 1: single executable tier -> exec prefix at head ===");
{
  const steps = [{ label: "run regression", detail: "", recommended: true, avoid: false, hold: false }];
  const out = api.composeStepsMessage(steps, [0], "");
  check("starts with exec.prefix", out.startsWith(T("nextsteps.exec.prefix")), JSON.stringify(out));
  check("the decision body is still present", out.includes("run regression"), JSON.stringify(out));
}

/* ═══════ 2. 单个 ? hold 档 → 发送文本以「点击即拍板」标签开头（C 档专属分支） ═══════ */
console.log("\n=== 2: single hold tier -> hold.confirm at head (C branch) ===");
{
  const steps = [{ label: "confirm word count", detail: "default 16384", recommended: false, avoid: false, hold: true }];
  const out = api.composeStepsMessage(steps, [0], "");
  check("starts with hold.confirm", out.startsWith(T("nextsteps.hold.confirm")), JSON.stringify(out));
  check("the question content rides along", out.includes("16384"), JSON.stringify(out));
  // the C branch must NOT prepend the plain exec prefix (it uses its own decision label)
  check("hold-only does NOT get the plain exec prefix", !out.startsWith(T("nextsteps.exec.prefix")), JSON.stringify(out));
}

/* ═══════ 3. 多选含至少一个可执行档 → combo 编号 + 结尾追加 exec.prefixAll ═══════ */
console.log("\n=== 3: batch with an executable tier -> combo + prefixAll tail ===");
{
  const steps = [
    { label: "task one", detail: "", recommended: true, avoid: false, hold: false },
    { label: "task two", detail: "", recommended: false, avoid: false, hold: true },
  ];
  const out = api.composeStepsMessage(steps, [0, 1], "");
  check("combo header present", out.includes(T("nextsteps.combo")), JSON.stringify(out));
  check("both items numbered", /^1\. /m.test(out) && /^2\. /m.test(out), JSON.stringify(out));
  check("the hold item still carries the decision label", out.includes(T("nextsteps.hold.confirm")), JSON.stringify(out));
  check("prefixAll reminder appended because an executable tier is present",
        out.trimEnd().endsWith(T("nextsteps.exec.prefixAll")), JSON.stringify(out));
}

/* ═══════ 4. 对照组：多选全是 ? hold 档 → combo 编号但不追加 exec.prefixAll ═══════ */
console.log("\n=== 4: control, batch all-hold -> combo but NO prefixAll ===");
{
  const steps = [
    { label: "q one", detail: "default A", recommended: false, avoid: false, hold: true },
    { label: "q two", detail: "default B", recommended: false, avoid: false, hold: true },
  ];
  const out = api.composeStepsMessage(steps, [0, 1], "");
  check("combo header present", out.includes(T("nextsteps.combo")), JSON.stringify(out));
  check("NO prefixAll when every pick is hold",
        !out.includes(T("nextsteps.exec.prefixAll")), JSON.stringify(out));
}

/* ═══════ 5. i18n 三个新键 zh + en 齐全 ═══════ */
console.log("\n=== 5: i18n new keys present in both languages ===");
{
  const dict = api.dict();
  for (const k of ["nextsteps.exec.prefix", "nextsteps.exec.prefixAll", "nextsteps.hold.confirm"])
    check(`zh+en both have ${k}`, !!dict.zh[k] && !!dict.en[k], JSON.stringify({ zh: dict.zh[k], en: dict.en[k] }));
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("COMPOSE-STEPS: ALL GREEN");
process.exit(0);
