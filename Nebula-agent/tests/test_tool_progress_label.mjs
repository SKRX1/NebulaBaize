/* 工具卡标题的三态锁（2026-10-27，A+B 根治）。

背景（截图红框）：一个还在跑的长命令，卡片展开着、标题写死「错误」、下面挂着
「shell__exec 仍在运行，已 45s」的实时进度。用户以为报错了——其实没有，那只是
heartbeat 每 30s 发一次的 progress 事件。

根因（app.js toolBodyHtml）：标题原本是二元判定
  tool.ok ? t("tool.result") : t("mon.state.error")
而 progress 分支只把文本追加进 result、把 state 设为 running，**只有最终 result
事件才设 ok**。所以进度还在流、没收到最终 result 时 ok===undefined → falsy →
标题落进「错误」。

修复（A+B 融合，一处三元）：
  state==="running"  -> 中性「运行中」（A：进行中/progress 流走中性）
  ok===false         -> 红「错误」（B：只有显式 false 才红）
  其余（含 ok===true）-> 正常区「结果」

注意：toolBodyHtml 里有【两个】 .tool-call__label —— 第一个是参数区固定标题
"Arguments"，第二个才是结果区标题（三态修复落点）。本测试取最后一个 label 断言。
全差分（语言锁 en，按英文标签断言）：
  1. running 态（ok 仍 undefined，progress 流）：结果标题必须是 Running，绝不能再是 Error
     （这一条正是根因回归锁——旧的二元判定会让它变红）。
  2. done + ok===false：结果标题必须是 Error（真失败才红）。
  3. done + ok===true：结果标题必须是 Result（正常区）。
  4. 三态各自独立：Running / Error / Result 互不相同（差分互斥）。

Run: node tests/test_tool_progress_label.mjs
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
const win = dom.window;
const doc = win.document;

win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
// Append the expose line IN THE SAME eval as app.js -- a top-level `function` in app.js
// is not a window global after a lone win.eval; the existing render tests use this
// exact `;window.__api = {...}` trick for the same reason.
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") +
  ';window.__api = { toolBodyHtml, t, fmt, esc };');
const api = win.__api;

const labelOf = (tool) => {
  const d = doc.createElement("div");
  d.innerHTML = api.toolBodyHtml(tool);
  // TWO labels exist (arguments header + result header). The three-state fix lives on
  // the RESULT header -> take the LAST one.
  const lbls = d.querySelectorAll(".tool-call__label");
  const lbl = lbls[lbls.length - 1];
  return lbl ? lbl.textContent.trim() : "(none)";
};

/* ═══════════ 1. running 态（progress 流）：中性 Running，绝不能再是 Error ═══════════ */
console.log("\n=== 1: running/progress 走中性，不再是错误（根因回归锁） ===");
{
  const running = { state: "running", result: "live progress append", ok: undefined, open: true };
  const l = labelOf(running);
  check("running 结果标题 = Running（中性，非错误）", l === "Running", JSON.stringify(l));
  check("running 结果标题绝不能再是 Error（旧二元判定的 bug）", l !== "Error", JSON.stringify(l));
}

/* ═══════════ 2. done + ok===false：真失败才红 ═══════════ */
console.log("\n=== 2: ok===false 才标红 ===");
{
  const failed = { state: "done", result: "final", ok: false, open: true };
  const l = labelOf(failed);
  check("ok===false 结果标题 = Error（真失败）", l === "Error", JSON.stringify(l));
}

/* ═══════════ 3. done + ok===true：正常区 ═══════════ */
console.log("\n=== 3: ok===true 走正常区 ===");
{
  const good = { state: "done", result: "final", ok: true, open: true };
  const l = labelOf(good);
  check("ok===true 结果标题 = Result（正常区）", l === "Result", JSON.stringify(l));
}

/* ═══════════ 4. 三态互斥差分 ═══════════ */
console.log("\n=== 4: 三态互斥差分 ===");
{
  const running = labelOf({ state: "running", result: "x", ok: undefined, open: true });
  const failed  = labelOf({ state: "done", result: "x", ok: false, open: true });
  const good    = labelOf({ state: "done", result: "x", ok: true,  open: true });
  check("running ≠ 错误（progress 不能串成失败）", running !== failed, `${running}/${failed}`);
  check("running ≠ 结果（进行中不能串成已完成）", running !== good, `${running}/${good}`);
  check("错误 ≠ 结果（失败与成功各锁各的）", failed !== good, `${failed}/${good}`);
  check("三态各自独立：Running / Error / Result 互不相同",
        new Set([running, failed, good]).size === 3, `${running}/${failed}/${good}`);
}

console.log(`\n${FAILURES.length ? "FAILURES:\n - " + FAILURES.join("\n - ") : "REGRESSION: ALL GREEN"}`);
process.exit(FAILURES.length ? 1 : 0);
