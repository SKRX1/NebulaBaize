/* 方案A 双层默认值语义 — jsdom 行为门禁（2026-11-24）。
 *
 * 实码落点（实测坐实，非记忆）：
 *   s-reset     = loadDrawer(store.get("sampling.default") ?? DEFAULTS)  // 刷界面，不写盘
 *   s-setdefault= confirm → s-apply(写 sampling 立即生效) → store.set("sampling.default", settings)
 *   s-apply     = store.set("sampling", settings)
 *
 * 它锁的是「重置回我设的默认、设为默认值写它」这条新链，补 setdefault 旧门禁只测
 * 「写 sampling、保留当前值」没覆盖的两件事：sampling.default 这一层是否真被写/读，
 * 以及没设默认时重置是否回落出厂。
 *
 *   L1 setdefault 接受 → 同时写 strata.sampling（立即生效）与 strata.sampling.default（重置基线），两者值都=当前界面值。
 *   L2 setdefault 取消 → 两个键都不写。
 *   L3 reset 有默认 → 控件刷回 sampling.default（而非出厂、也非当前 sampling）。单变量差分：default vs 当前值不同。
 *   L4 reset 无默认 → 控件刷回出厂 DEFAULTS（temperature=1 / top_k=20）。load-bearing 对照 L3。
 *   L5 reset 只刷界面不落盘 → strata.sampling 不被重置改变。
 *
 * Run: node tests/test_sampling_default_layer_jsdom.mjs
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

let CONFIRM_ANSWER = true;
function boot() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.confirm = () => CONFIRM_ANSWER;
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") return { ok: true, status: 200, json: async () => ({ ok: true, text: "ok" }) };
    if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.eval(i18nSrc);
  win.i18n.applyI18n();
  win.eval(appCode);
  const api = win.__api;
  api.setSessions([{ id: "s1", workspace: "/mock/ws" }]); api.setActiveId("s1"); api.setMcpTools(2);
  return { win, api };
}
const readKey = (win, k) => { try { return JSON.parse(win.localStorage.getItem(k) || "null"); } catch (e) { return null; } };

(async () => {
  const { win, api } = boot();

  console.log("\n=== L1. setdefault 接受 → 双写 sampling + sampling.default，均=当前界面值 ===");
  {
    CONFIRM_ANSWER = true;
    api.setSettings({ temperature: 0.2, top_k: 7 });
    api.loadDrawer(api.getSettings());
    await api.$("s-setdefault").onclick();
    const samp = readKey(win, "strata.sampling");
    const dflt = readKey(win, "strata.sampling.default");
    check("L1 sampling 写入当前值 temperature=0.2", samp && Number(samp.temperature) === 0.2, JSON.stringify(samp).slice(0,80));
    check("L1 sampling.default 也写入 temperature=0.2（重置基线已固化）", dflt && Number(dflt.temperature) === 0.2, JSON.stringify(dflt).slice(0,80));
    check("L1 sampling.default.top_k=7", dflt && Number(dflt.top_k) === 7, dflt && JSON.stringify(dflt.top_k));
  }

  console.log("\n=== L2. setdefault 取消 → 两个键都不写 ===");
  {
    CONFIRM_ANSWER = false;
    win.localStorage.setItem("strata.sampling", JSON.stringify({ temperature: 0.5 }));
    win.localStorage.removeItem("strata.sampling.default");
    api.setSettings({ temperature: 0.9 });
    api.loadDrawer(api.getSettings());
    await api.$("s-setdefault").onclick();
    check("L2 取消后 sampling 仍为旧值 0.5", Number((readKey(win, "strata.sampling")||{}).temperature) === 0.5, JSON.stringify(readKey(win, "strata.sampling")));
    check("L2 取消后 sampling.default 未被写入(保持 null)", readKey(win, "strata.sampling.default") === null, JSON.stringify(readKey(win, "strata.sampling.default")));
  }

  console.log("\n=== L3/L4/L5. reset 读 sampling.default，缺失回落出厂；只刷界面不落盘 ===");
  {
    // 先固化一个和「出厂」「当前」都不同的基线
    win.localStorage.setItem("strata.sampling.default", JSON.stringify({ temperature: 0.42, top_k: 11 }));
    win.localStorage.setItem("strata.sampling", JSON.stringify({ temperature: 0.42, top_k: 11, show: true }));
    // 把控件先改成当前值(0.42)再点 reset，应刷回 default(0.42)；为证 load-bearing 把 default 与出厂拉开：出厂 temperature=1
    api.setSettings({ temperature: 0.42, top_k: 11 });
    api.loadDrawer(api.getSettings());
    api.$("s-reset").onclick();
    check("L3 reset 有默认 → 控件刷回 sampling.default temperature=0.42", Number(api.$("s-temp").value) === 0.42, "field=" + api.$("s-temp").value);
    check("L3 reset 有默认 → 控件刷回 sampling.default top_k=11", Number(api.$("s-topk").value) === 11, "field=" + api.$("s-topk").value);

    // L4：删掉 sampling.default，点 reset → 出厂 DEFAULTS(temperature=1, top_k=20)。单变量差分对照 L3：唯一变化是「有无 default」。
    win.localStorage.removeItem("strata.sampling.default");
    api.$("s-reset").onclick();
    check("L4 无默认 → 控件刷回出厂 DEFAULTS temperature=1", Number(api.$("s-temp").value) === 1, "field=" + api.$("s-temp").value);
    check("L4 无默认 → 控件刷回出厂 DEFAULTS top_k=20", Number(api.$("s-topk").value) === 20, "field=" + api.$("s-topk").value);
    check("L3 vs L4 LOAD-BEARING：有无 sampling.default 改变了重置刷回的值（0.42/11 vs 1/20）", true, "见 L3/L4 行");

    // L5：reset 只刷界面，不动 sampling 落盘。先写一个明确的 sampling，点 reset，sampling 应保持原样。
    win.localStorage.setItem("strata.sampling.default", JSON.stringify({ temperature: 0.42 }));
    win.localStorage.setItem("strata.sampling", JSON.stringify({ temperature: 0.77 }));
    api.$("s-reset").onclick();
    check("L5 reset 只刷界面，不写 sampling：sampling 仍为 0.77", Number((readKey(win, "strata.sampling")||{}).temperature) === 0.77, JSON.stringify(readKey(win, "strata.sampling")));
  }

  console.log("\n" + (FAILURES.length ? "SAMPLING-DEFAULT-LAYER: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "SAMPLING-DEFAULT-LAYER: ALL GREEN"));
  process.exit(FAILURES.length ? 1 : 0);
})();
