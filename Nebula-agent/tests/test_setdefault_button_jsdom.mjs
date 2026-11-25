/* jsdom 行为门禁 — 实测采样抽屉按钮「设为默认值」s-setdefault 端到端（语义修正 2026-11-11）
   用户拍板（纠正后）：s-setdefault = 把【当前界面上】这套设置应用并保存为默认值（立即生效）；
   与现有 s-reset（恢复出厂默认 DEFAULTS）不同 —— s-setdefault 保留你已改的值、未动的项不变，
   只是「把当前界面这套值 apply 下去」。等价于「确认 → 直接调用 s-apply」。

   A) 按钮存在 + 双字典中文 label「设为默认值」+ 三个按钮都有 title 悬浮提示（data-i18n-attr）。
   B) 端到端：抽屉先偏离默认（temperature=0.2, top_k=7）→ 点 s-setdefault（确认=接受）→
      控件【保留当前值不刷回 DEFAULTS】且 localStorage["strata.sampling"] 写入当前界面值。
   C) 确认取消（防误点）→ 不写盘、值保留。
   D) 三按钮 title 悬浮提示：i18n 应用后 title 属性非空且为对应语言。

   Run: node tests/test_setdefault_button_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
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
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

appCode += `
;window.__api = {
  DEFAULTS, loadDrawer,
  getSettings: () => settings,
  setSettings: (s) => { settings = Object.assign({}, settings, s); },
  setSessions: (s) => { sessions = s; }, setActiveId: (id) => { activeId = id; },
  setMcpTools: (n) => { mcpInfo.tools = n; },
  $,
};`;

const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
win.cancelAnimationFrame = (id) => clearTimeout(id);

let CONFIRM_ANSWER = true;
win.confirm = () => CONFIRM_ANSWER;
win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") {
    if (o && o.body && JSON.parse(o.body).tool === "read") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, text: "ok" }) };
  }
  if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(i18nSrc);
win.i18n.applyI18n();   // push static data-i18n-attr (title=) into the DOM so gate D can read it
win.eval(appCode);

const api = win.__api;
api.setSessions([{ id: "s1", workspace: "/mock/ws" }]); api.setActiveId("s1"); api.setMcpTools(2);
const LS = () => { try { return JSON.parse(win.localStorage.getItem("strata.sampling") || "{}"); } catch (e) { return {}; } };

console.log("\n=== A. 按钮存在 + 中文 label + 三按钮 title 提示存在 ===");
const btn = api.$("s-setdefault");
check("s-setdefault 存在于 DOM", !!btn);
check("中文 label = 设为默认值", win.i18n.t("drawer.setdefault") === "\u8bbe\u4e3a\u9ed8\u8ba4\u503c", JSON.stringify(win.i18n.t("drawer.setdefault")));
check("三个按钮都挂 data-i18n-attr title", ["s-reset", "s-setdefault", "s-apply"].every((id) => /title:/.test(String(api.$(id).getAttribute("data-i18n-attr") || ""))));

console.log("\n=== B. 端到端：偏离当前值 → 点按钮（确认=接受）→ 保留当前值写盘（不刷回出厂默认） ===");
{
  CONFIRM_ANSWER = true;
  api.setSettings({ temperature: 0.2, top_k: 7 });
  api.loadDrawer(api.getSettings());
  check("前置：控件显示当前值 temperature=0.2", Number(api.$("s-temp").value) === 0.2, "field=" + api.$("s-temp").value);
  check("前置：控件显示当前值 top_k=7", Number(api.$("s-topk").value) === 7, "field=" + api.$("s-topk").value);
  await api.$("s-setdefault").onclick();
  // 语义核心：控件【不被刷回出厂默认】(出厂 temperature=1/top_k=20)，而是保留当前界面值 0.2/99
  check("点完控件保留当前值 temperature=0.2（未刷回出厂默认1）", Number(api.$("s-temp").value) === 0.2, "field=" + api.$("s-temp").value);
  check("点完控件保留当前值 top_k=7（未刷回出厂默认20）", Number(api.$("s-topk").value) === 7, "field=" + api.$("s-topk").value);
  const saved = LS();
  check("点完 localStorage 写入当前界面值 temperature=0.2", Number(saved.temperature) === 0.2, JSON.stringify(saved).slice(0, 160));
  check("点完 localStorage 写入当前界面值 top_k=7", Number(saved.top_k) === 7, JSON.stringify(saved).slice(0, 160));
}

console.log("\n=== C. 确认取消（防误点）→ 不写盘 ===");
{
  win.localStorage.setItem("strata.sampling", JSON.stringify({ temperature: 0.5 }));
  CONFIRM_ANSWER = false;
  api.setSettings({ temperature: 0.6 });
  api.loadDrawer(api.getSettings());
  await api.$("s-setdefault").onclick();
  check("确认取消后 localStorage 仍为旧值 0.5（未写入 0.6）", Number(LS().temperature) === 0.5, JSON.stringify(LS()));
  CONFIRM_ANSWER = true;
}

console.log("\n=== D. 三按钮 title 悬浮提示经 i18n 落地（非空、为中文） ===");
{
  for (const id of ["s-reset", "s-setdefault", "s-apply"]) {
    const t = api.$(id).getAttribute("title") || "";
    check(id + ' 的 title 悬浮提示已应用且含中文', /[\u4e00-\u9fff]/.test(t), JSON.stringify(t));
  }
}

console.log("\n" + (FAILURES.length ? "SETDEFAULT-BUTTON: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "SETDEFAULT-BUTTON: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
