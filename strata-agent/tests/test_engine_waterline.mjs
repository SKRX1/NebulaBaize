/* 差分门禁（2026-11-02 拍板锁 / 方案B）：侧边栏任务面板的「引擎水位」子行必须随
   网关代理的 /api/monitor 数据显隐。根因背景：占用条 = 本会话 prompt / 每会话窗口
   (models.json context_window)；47831 监控页 = 共享 KV 驻留池 / 引擎真实 n_ctx。两个口径
   天然不等（本机实测 n_ctx=32768 而声明窗口 131072，前端 ≈ 引擎的 1/4），并列显示后停止
   被误读成同步 bug。

契约（真 app.js + 真 i18n.js + 真 index.html，jsdom）：renderInspector() 里读 engineMonitor——
  A. available 且 context.maxTokens>0 -> #ins-engine hidden=false，含 "Engine pool <pct>%" 与 used/max。
  B. 对照组 engineMonitor=null -> #ins-engine hidden=true。
  C. 对照组 available:false -> #ins-engine hidden=true。
  静态锁：index.html 含 id="ins-engine"；i18n 中英均定义 insp.engine。

Run: node tests/test_engine_waterline.mjs
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
const i18n = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const app = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// static locks
check("static: index.html has #ins-engine", html.includes('id="ins-engine"'));
check("static: i18n defines insp.engine (zh+en)",
  (i18n.match(/"insp\.engine"\s*:/g) || []).length === 2, "count=" + (i18n.match(/"insp\.engine"\s*:/g) || []).length);
check("static: i18n defines insp.engine.tip (zh+en)",
  (i18n.match(/"insp\.engine\.tip"\s*:/g) || []).length === 2);
check("static: app.js polls api/monitor", app.includes('fetch("api/monitor"'));

const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){ return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(i18n);
win.eval(app + `
;window.__api = {
  renderInspector,
  setEngine: (v) => { engineMonitor = v; },
  setMaxCtx: (v) => { maxCtx = v; },
  setUsed: (v) => { lastPromptTokens = v; },
  setTab: (v) => { tab = v; },
};`);
const api = win.__api;
const el = () => doc.getElementById("ins-engine");
api.setMaxCtx(131072); api.setUsed(20000); api.setTab("chat");

// A. available + a real window -> visible, shows Engine pool pct + used/max
api.setEngine({ available: true, context: { usedTokens: 24000, maxTokens: 32768, pct: 73 } });
api.renderInspector();
let a = el();
check("A visible when engine data available", a && a.hidden === false, "hidden=" + (a && a.hidden));
check("A shows Engine pool + pct", (a.textContent || "").includes("Engine pool") && (a.textContent || "").includes("73%"),
  "txt=" + (a && a.textContent));

// B. control: engineMonitor null -> hidden (single-variable difference from A)
api.setEngine(null);
api.renderInspector();
let b = el();
check("B hidden when engine null (control)", b && b.hidden === true, "hidden=" + (b && b.hidden));

// C. control: available:false -> hidden
api.setEngine({ available: false });
api.renderInspector();
let c = el();
check("C hidden when available:false (control)", c && c.hidden === true, "hidden=" + (c && c.hidden));

// back to visible to prove the toggle is reversible (not a one-shot)
api.setEngine({ available: true, context: { usedTokens: 5000, maxTokens: 32768, pct: 15 } });
api.renderInspector();
let d = el();
check("reversible: visible again with new pct", d && d.hidden === false && (d.textContent || "").includes("15%"),
  "txt=" + (d && d.textContent));

console.log(FAILURES.length ? ("\nENGINE WATERLINE: " + FAILURES.length + " FAILED") : "\nENGINE WATERLINE: ALL PASSED");
process.exit(FAILURES.length ? 1 : 0);
