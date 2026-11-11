/* jsdom 行为门禁 — 实测采样抽屉新增按钮 s-setdefault「设为默认值」端到端
   语义（与用户拍板一致）：点击 = 弹确认 → 把抽屉所有控件刷成 DEFAULTS → 立即触发「应用」写盘。
   写盘走 store.set → localStorage("strata.sampling")，故断言读 localStorage 而非 fetch。

   A) 按钮存在 + data-i18n=drawer.setdefault + 双字典中文 label「设为默认值」。
   B) 端到端：先 setSettings 出一个偏离默认值（temperature=0.2）并 loadDrawer→
      点 s-setdefault（确认=接受）→ 控件刷回 DEFAULTS 且 localStorage["strata.sampling"].temperature=1。
   C) 确认取消（防误点）：偏离值仍在、点完 localStorage 不被刷成默认。

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
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

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
win.eval(appCode);

const api = win.__api;
api.setSessions([{ id: "s1", workspace: "/mock/ws" }]); api.setActiveId("s1"); api.setMcpTools(2);
const LS = () => { try { return JSON.parse(win.localStorage.getItem("strata.sampling") || "{}"); } catch (e) { return {}; } };

console.log("\n=== A. 按钮存在 + 中文 label ===");
const btn = api.$("s-setdefault");
check("s-setdefault 存在于 DOM", !!btn);
check("data-i18n=drawer.setdefault", btn && btn.getAttribute("data-i18n") === "drawer.setdefault");
check("中文 label = 设为默认值", win.i18n.t("drawer.setdefault") === "\u8bbe\u4e3a\u9ed8\u8ba4\u503c", JSON.stringify(win.i18n.t("drawer.setdefault")));
check("确认文案含中文（非乱码）", /[\u4e00-\u9fff]/.test(win.i18n.t("drawer.setdefault.confirm")));

console.log("\n=== B. 端到端：偏离值 → 点按钮（确认=接受）→ 刷回默认 + 立即写盘 ===");
{
  CONFIRM_ANSWER = true;
  api.setSettings({ temperature: 0.2 });
  api.loadDrawer(api.getSettings());
  check("前置：控件显示偏离值 0.2", Number(api.$("s-temp").value) === 0.2, "field=" + api.$("s-temp").value);
  await api.$("s-setdefault").onclick();
  const saved = LS();
  check("点完控件刷回 DEFAULTS（temperature=1）", Number(api.$("s-temp").value) === 1, "field=" + api.$("s-temp").value);
  check("点完 localStorage 已写盘且 temperature 回默认 1", Number(saved.temperature) === 1, JSON.stringify(saved).slice(0, 160));
}

console.log("\n=== C. 确认取消（防误点）→ 不刷默认、不写盘 ===");
{
  CONFIRM_ANSWER = false;
  win.localStorage.setItem("strata.sampling", JSON.stringify({ temperature: 0.3 }));
  api.setSettings({ temperature: 0.3 });
  api.loadDrawer(api.getSettings());
  await api.$("s-setdefault").onclick();
  check("确认取消后控件仍保留偏离值 0.3（未被刷）", Number(api.$("s-temp").value) === 0.3, "field=" + api.$("s-temp").value);
  check("确认取消后 localStorage 仍是 0.3（未写默认）", Number(LS().temperature) === 0.3, JSON.stringify(LS()));
  CONFIRM_ANSWER = true;
}

console.log("\n" + (FAILURES.length ? "SETDEFAULT-BUTTON: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "SETDEFAULT-BUTTON: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
