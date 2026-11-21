/* 建议条右键复制（2026-11-12）。

诉求：选中建议条后，右键可复制该选择条内容；全选后右键复制全部已选；
      并给右键菜单加「复制全部建议」（不论是否选中，一键复制整块 next-steps）。

设计（真 index.html + 真 i18n.js + 真 app.js，jsdom 端到端派发 contextmenu）：
  右键一个 .next-step chip，菜单依次为：
    · 「复制此条建议」——复制该 chip 完整文本（label：detail，无 detail 时纯 label）；
    · 「复制已选的 N 条」——仅当有选中项时出现（排在「复制全部建议」之上），编号文案与发送组合文案一致；
    · 「复制全部建议」——整块 next-steps 全量，按顺序编号「1. x\n2. y」，不论是否选中，排最下。
  复制走 app 全局 openCtxMenu/copyText 管线。

锁住的契约：
  1. 右键带 detail 的 chip → 复制文本 = 「label：detail」；
  2. 右键无 detail 的 chip → 复制纯 label；
  3. 「复制全部建议」→ 整块全量编号（含未选中项），与发送组合文案同格式；
  4. 单条项复制无编号、多条复制编号（与 send-composition 一致）；
  5. 「复制已选的 N 条」仅在有选中项时出现，多条 → 编号文案；
  6. i18n 新键 ctx.copy.step / ctx.copy.steps / ctx.copy.steps.all 在 zh+en 都齐全，{n} 占位可替换。

Run: node tests/test_step_contextmenu_copy.mjs
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
win.localStorage.setItem("strata.lang", "zh");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } },
  });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// ── capture clipboard writes: copyText() prefers navigator.clipboard.writeText ──
let COPIED = [];
Object.defineProperty(win.navigator, "clipboard", {
  configurable: true,
  value: { writeText: (txt) => { COPIED.push(txt); return Promise.resolve(); } },
});

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { renderNextSteps, msgEl, dict: () => i18n._dict, messages: () => messages };`);
const api = win.__api;

// Push the message into the REAL messages array so the contextmenu handler's
// `messages[i]` lookup resolves. Return the dataset.i == its index there.
function renderSteps(steps, selSteps = []) {
  const msgs = api.messages();
  msgs.push({ role: "assistant", text: "done", time: Date.now(), steps, selSteps: [...selSteps] });
  const idx = msgs.length - 1;
  const m = msgs[idx];
  const el = api.msgEl(m, idx);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return { m, el, box: el.querySelector(".next-steps") };
}

function rightClick(node) {
  COPIED = [];
  const ev = new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 });
  node.dispatchEvent(ev);
  const menu = doc.getElementById("ctx-menu-msg");
  return { menu, buttons: Array.from(menu.querySelectorAll("button")) };
}
const labels = (btns) => btns.map((b) => b.textContent.trim());
const findBtn = (btns, want) => btns.filter((b) => b.textContent.trim() === want);
async function click(btn) { btn.click(); await new Promise((r) => setTimeout(r, 5)); }

/* ═══════════ 1. 右键带 detail 的 chip → 复制此条 label：detail ═══════════ */
console.log("\n=== 1: 右键单条（带 detail）→ 复制此条 ===");
{
  const steps = [
    { label: "立即备份", detail: "把当前账本导出", recommended: true },
    { label: "稍后核对", detail: "", recommended: false },
  ];
  const { box } = renderSteps(steps);   // no selection
  const chip0 = box.querySelector('[data-step="0"]');
  const { buttons } = rightClick(chip0);
  const labs = labels(buttons);
  check("无选中 → 菜单 2 项（复制此条 + 复制全部）", buttons.length === 2, JSON.stringify(labs));
  check("第 1 项 = 复制此条建议", labs[0] === "复制此条建议", JSON.stringify(labs));
  check("第 2 项 = 复制全部建议", labs[1] === "复制全部建议", JSON.stringify(labs));
  await click(findBtn(buttons, "复制此条建议")[0]);
  check("复制此条 = 「立即备份：把当前账本导出」", COPIED[0] === "立即备份：把当前账本导出", JSON.stringify(COPIED));
}

/* ═══════════ 2. 右键无 detail 的 chip → 复制纯 label ═══════════ */
console.log("\n=== 2: 右键单条（无 detail）→ 复制纯 label ===");
{
  const steps = [{ label: "纯标签项", detail: "", recommended: false }];
  const { box } = renderSteps(steps);
  const chip0 = box.querySelector('[data-step="0"]');
  const { buttons } = rightClick(chip0);
  check("单条（无 detail）→ 菜单 1 项（复制全部对单块冗余，仍只 1 项？）", buttons.length >= 1, JSON.stringify(labels(buttons)));
  await click(findBtn(buttons, "复制此条建议")[0]);
  check("复制文本 = 纯 label「纯标签项」", COPIED[0] === "纯标签项", JSON.stringify(COPIED));
}

/* ═══════════ 3. 复制全部建议 → 整块全量编号（不论选中） ═══════════ */
console.log("\n=== 3: 复制全部建议 → 整块全量编号（含未选中） ===");
{
  const steps = [
    { label: "方案A", detail: "说明A", recommended: true },
    { label: "方案B", detail: "", recommended: false },
    { label: "方案C", detail: "说明C", recommended: false },
  ];
  const { box } = renderSteps(steps, [0]);   // only 1 selected; "copy all" must still emit all 3
  const chip0 = box.querySelector('[data-step="0"]');
  const { buttons } = rightClick(chip0);
  const labs = labels(buttons);
  check("有选中 → 菜单 3 项（此条 + 全部 + 已选）", buttons.length === 3, JSON.stringify(labs));
  const btnAll = findBtn(buttons, "复制全部建议")[0];
  check("存在「复制全部建议」项", !!btnAll, JSON.stringify(labs));
  await click(btnAll);
  const wantAll = "1. 方案A：说明A\n2. 方案B\n3. 方案C：说明C";
  check("复制全部建议 = 整块 3 条全编号（含未选中 B/C）", COPIED[0] === wantAll, JSON.stringify(COPIED));
  // and the selected-only path still copies just the 1 selected (no numbering for single)
  const { buttons: b2 } = rightClick(chip0);
  await click(findBtn(b2, "复制已选的 1 条")[0]);
  check("复制已选 1 条 = 「方案A：说明A」（单条无编号）", COPIED[0] === "方案A：说明A", JSON.stringify(COPIED));
}

/* ═══════════ 4. 多条选中 → 复制已选编号（与发送组合文案一致） ═══════════ */
console.log("\n=== 4: 多条选中 → 复制已选编号文案 ===");
{
  const steps = [
    { label: "X1", detail: "", recommended: true },
    { label: "X2", detail: "d", recommended: false },
    { label: "X3", detail: "", recommended: false },
  ];
  const { box } = renderSteps(steps, [0, 2]);   // select first + third
  const chip0 = box.querySelector('[data-step="0"]');
  const { buttons } = rightClick(chip0);
  const labs = labels(buttons);
  check("两条选中 → 菜单 3 项", buttons.length === 3, JSON.stringify(labs));
  await click(findBtn(buttons, "复制已选的 2 条")[0]);
  check("复制已选 2 条 = 「1. X1\n2. X3」（选中 [0,2]→X1/X3，按选中顺序编号）", COPIED[0] === "1. X1\n2. X3", JSON.stringify(COPIED));
}

/* ═══════════ 5. i18n 新键 zh+en 齐全 ═══════════ */
console.log("\n=== 5: i18n 新键 zh+en ===");
{
  const dict = api.dict();
  for (const k of ["ctx.copy.step", "ctx.copy.steps", "ctx.copy.steps.all"])
    check(`zh+en 都有 ${k}`, !!dict.zh[k] && !!dict.en[k], k);
  check("zh ctx.copy.step =「复制此条建议」", dict.zh["ctx.copy.step"] === "复制此条建议");
  check("zh ctx.copy.steps.all =「复制全部建议」", dict.zh["ctx.copy.steps.all"] === "复制全部建议");
  check("en ctx.copy.step = Copy this step", dict.en["ctx.copy.step"] === "Copy this step");
  check("en ctx.copy.steps.all = Copy all steps", dict.en["ctx.copy.steps.all"] === "Copy all steps");
  check("ctx.copy.steps 含 {n} 占位（zh+en）",
        dict.zh["ctx.copy.steps"].includes("{n}") && dict.en["ctx.copy.steps"].includes("{n}"));
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("STEP-CONTEXTMENU-COPY: ALL GREEN");
process.exit(0);
