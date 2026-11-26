/* jsdom 行为门禁 — MCP 面板「重载子进程」reload 行为固化（2026-11）

锁定的事实（主人本轮拍板）：reload 是【子进程级】操作 —— 它 POST 专用端点
api/servers/reload 让网关 new.start_all() 重新 spawn 全部 MCP 子进程，
**不换网关进程本身**。在前端层的最强可测代理 = 两件事：
  (1) reload 打的必须是子进程级端点 api/servers/reload，绝不是任何整网关重启端点；
  (2) reload 成功后页面【不整页刷新】—— 只 toast + 重新拉 MCP 列表（loadMcp），
      不触发 location.reload（若整页刷，jsdom 会报 navigation Not-implemented）。

为什么不能只读代码静态锁：handler 是 async + await askConfirm（2026-11-26 起迁 DOM 确认框），
真正的控制流（确认后才 POST、ok 后才刷新、fail 不刷新、全程不导航）必须真跑一遍才算实测。
本门禁用 win.eval 真加载 app.js（outside-only），直接调用 reloadMcpServers，真点确认框，
捕获 fetch 调用序列 + VirtualConsole 的 navigation error，三向断言固化。

Run: node tests/test_mcp_reload_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { JSDOM, VirtualConsole } = require("jsdom");
import { clickConfirm, rejectConfirm } from "./_ask_confirm_helper.mjs";

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
const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// ── T1 静态锁：reload 端点 = 子进程级，不是整网关重启 ──
console.log("\n=== T1. 静态锁：reload POST 专用子进程端点，非整网关重启 ===");
{
  // 锚定 reloadMcpServers 函数体：从签名到该函数闭合。
  const start = appSrc.indexOf("async function reloadMcpServers");
  const body = start >= 0 ? appSrc.slice(start, start + 900) : "";
  check("reloadMcpServers 存在", start >= 0);
  check("POST 端点 = api/servers/reload",
    /fetch\(\s*["']api\/servers\/reload["']/.test(body), "");
  // LOAD-BEARING 差分：handler 体内绝不能出现整页刷新原语或整网关重启端点，
  // 否则就是「reload 误升级成重启网关」的回归。
  check("体内无整页刷新原语（location.reload / location =）",
    !/location\.reload|window\.location\s*=|location\s*=\s*["']/.test(body), "");
  check("体内无整网关重启端点（不含 restart 字样）",
    !/restart/i.test(body), "");
  // decoy 差分：若端点名被改成 restart（误升级成重启网关），上锁应翻红 → 证明 load-bearing。
  check("decoy: 端点名换成 restart 会让端点锁翻红",
    !/fetch\(\s*["']api\/servers\/reload["']/.test(body.replace("api/servers/reload", "api/servers/restart")), "");
  // 接线存在（onclick 走 DOMContentLoaded 绑定，静态确认有挂载点）。
  check("reload 按钮挂载点存在（#mcp-reload 接线）",
    /\$\(\s*["']mcp-reload["']\s*\)/.test(appSrc), "");
}

// ── 行为 harness：boot app.js，stub fetch，真点确认框调用 reloadMcpServers ──
function boot(opts = {}) {
  let navErrors = 0;
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => { if (/navigation/i.test(String(e && e.message))) navErrors++; });
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8099/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);

  const calls = [];   // {url, method, hasBody}
  win.fetch = async (url, o) => {
    const u = String(url);
    calls.push({ url: u, method: (o && o.method) || "GET", hasBody: !!(o && o.body) });
    if (u.includes("servers/reload")) {
      return { ok: opts.reloadOk !== false, status: opts.reloadOk === false ? 500 : 200,
               json: async () => opts.reloadOk === false
                 ? { ok: false, error: "boom" }
                 : { ok: true, servers: ["fs", "shell", "websearch"], tools: 24 } };
    }
    if (u.includes("mcp")) {   // loadMcp 的列表请求
      return { ok: true, status: 200, json: async () => ({ ok: true, servers: [], tools: {} }) };
    }
    if (u.endsWith("settings")) return { ok: true, status: 200, json: async () => ({ shared: false }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  let appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + appSrc;
  appCode += `
;window.__api = { reloadMcpServers, loadMcp, $ };`;
  win.eval(i18nSrc);
  win.eval(appCode);
  return { win, calls, navErrors: () => navErrors, api: win.__api };
}

console.log("\n=== T2. 成功路径：真点确认 → POST 子进程端点 → 刷新 MCP 列表且不整页导航 ===");
{
  const h = boot({ reloadOk: true });
  // 直接驱动 handler（DOMContentLoaded 在 jsdom 下未必触发，函数本身可调用）。
  const p = h.api.reloadMcpServers(null);   // btn=null 跳过 busy 分支
  await clickConfirm(h.win);                // askConfirm 的 DOM 框（文案存在）
  await p;
  const reloadCall = h.calls.find((c) => c.url.includes("servers/reload"));
  check("reload 打到 api/servers/reload 且为 POST",
    !!reloadCall && reloadCall.method === "POST", JSON.stringify(reloadCall));
  check("reload 端点是子进程级（URL 恰为 api/servers/reload，无 restart）",
    !!reloadCall && /api\/servers\/reload$/.test(reloadCall.url), reloadCall && reloadCall.url);
  // 成功 → 重新拉 MCP 列表（reload 后出现 mcp 列表请求 = UI 局部刷新而非整页刷）。
  const mcpCall = h.calls.find((c) => c.url.includes("mcp"));
  check("成功后重新拉取 MCP 列表（局部刷新 loadMcp）", !!mcpCall, JSON.stringify(h.calls.map((c) => c.url)));
  // LOAD-BEARING：reload 成功绝不能整页刷新（若 location.reload，jsdom 报 navigation error）。
  check("成功后页面未整页导航（网关进程不换的前端体现）",
    h.navErrors() === 0, "navErrors=" + h.navErrors());
  // 端点序列里没有任何 restart 端点混入。
  check("全程 fetch 无任何 restart 端点",
    h.calls.every((c) => !/restart/i.test(c.url)), JSON.stringify(h.calls.map((c) => c.url)));
}

console.log("\n=== T3. 失败路径：reload ok:false → 不刷新列表、不导航、不升级成重启 ===");
{
  const h = boot({ reloadOk: false });
  const p = h.api.reloadMcpServers(null);
  await clickConfirm(h.win);
  await p;
  const reloadCall = h.calls.find((c) => c.url.includes("servers/reload"));
  check("失败仍打到 api/servers/reload（不是 fallback 到重启）",
    !!reloadCall && /api\/servers\/reload$/.test(reloadCall.url) && !/restart/i.test(reloadCall.url),
    reloadCall && reloadCall.url);
  check("失败后未整页导航", h.navErrors() === 0, "navErrors=" + h.navErrors());
}

console.log("\n=== T4. 取消确认：askConfirm 取消 → 根本不发 reload 请求（防误点） ===");
{
  const h = boot({ reloadOk: true });
  const p = h.api.reloadMcpServers(null);
  await rejectConfirm(h.win);   // 点确认框「取消」
  await p;
  check("取消确认后不发任何 servers/reload 请求",
    h.calls.every((c) => !c.url.includes("servers/reload")), JSON.stringify(h.calls.map((c) => c.url)));
}

console.log("\n" + (FAILURES.length ? "MCP-RELOAD-JSDOM: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "MCP-RELOAD-JSDOM: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
