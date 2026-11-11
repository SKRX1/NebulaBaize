/* jsdom 行为级门禁 — 守「默认开直写」契约的 i18n 中文渲染 + propose 端到端
   （与 tests/test_autorules_dynamic.mjs 互补：那份锁逻辑契约+英文，本份锁 i18n 中文渲染路径）。

   A) i18n 中文开关 s-autorules：默认语言 zh-CN，label/hint/DOM span 文本均为正确中文，
      #s-autorules 存在且 aria-checked=true。
   B) propose 直写契约（冗余锁，与 dynamic 交叉印证）：默认 autoRulesMemory=true → autoWriteOn('rules')=true；
      关掉→false；knowledge 走总闸默认 false。
   C) 端到端实跑 propose：模拟模型吐 propose-rules 块 → 调 maybeProposeMemory →
      默认开时走「直写 RULES.md+审计」而非落 draft；关开关后同一条应落 RULES.draft.md。

   关键：jsdom 下每个 window.eval 是独立词法作用域，app.js 顶层 let（settings/sessions/
   activeId/pendingDraft）跨 eval 不可见，故 i18n 单独 eval（经 window.i18n 桥），
   app+探针拼成【同一次】eval 让顶层 let 对探针可见。mock window.fetch 拦 mcp/call。

   Run: node tests/test_autorules_i18n_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);   // 向上解析到工作区根 node_modules
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appSrc  = fs.readFileSync(path.join(WEB, "app.js"),  "utf8");
const html    = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

// jsdom 缺的浏览器 API polyfill（app.js 顶层会用到）
const polyfill = `
  window.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} takeRecords(){return [];} };
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  if (!URL.createObjectURL) URL.createObjectURL = () => 'blob:stub';
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
  if (!window.crypto || !crypto.randomUUID) { window.crypto = window.crypto || {}; crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&0x3|0x8)).toString(16);}); }
  if (!window.matchMedia) window.matchMedia = function(){return {matches:false, media:'', addEventListener:function(){}, removeEventListener:function(){}, addListener:function(){}, removeListener:function(){}, onchange:null};};
`;

const probeAB = `
  window.__probe = window.__probe || {};
  try {
    window.__probe.A_lang = (document.documentElement.getAttribute('lang') || '(none)');
    window.__probe.A_labelZh = window.i18n.t('drawer.autorules');
    window.__probe.A_hintZh_hasMandarin = /[\\u4e00-\\u9fff]/.test(window.i18n.t('drawer.autorules.hint'));
    window.__probe.A_dom_switch = document.querySelector('#s-autorules') ? 'EXISTS' : 'MISSING';
    window.__probe.A_dom_aria = document.querySelector('#s-autorules') ? document.querySelector('#s-autorules').getAttribute('aria-checked') : null;
    var span = document.querySelector('[data-i18n="drawer.autorules"]');
    window.__probe.A_dom_span_text = span ? span.textContent : 'NO-SPAN';
    window.__probe.B_settingsAutoRules = settings.autoRulesMemory;
    window.__probe.B_autoWriteOn_default = autoWriteOn('rules');
    settings.autoRulesMemory = false;
    window.__probe.B_autoWriteOn_off = autoWriteOn('rules');
    settings.autoRulesMemory = true;
    window.__probe.B_autoWriteOn_knowledge_default = autoWriteOn('knowledge');
  } catch (e) { window.__probe.ERROR_AB = String((e && e.stack) || e); }
`;

const probeC = `
  window.__writes = [];
  var _origFetch = window.fetch;
  window.fetch = async function (url, opt) {
    var u = String(url);
    if (u.indexOf('mcp/call') >= 0) {
      var body = {}; try { body = JSON.parse((opt && opt.body) || '{}'); } catch (e) {}
      var args = body.args || {};
      var rec = { tool: body.tool, path: args.path, content: args.content };
      if (body.tool === 'read') { return { ok:true, status:200, json: async function(){ return {ok:true, text:''}; } }; }
      if (body.tool === 'write') { window.__writes.push(rec); return { ok:true, status:200, json: async function(){ return {ok:true}; } }; }
      return { ok:true, status:200, json: async function(){ return {ok:true}; } };
    }
    return _origFetch.apply(this, arguments);
  };
  window.__probeC = function (on) {
    return (async function () {
      sessions.length = 0;
      sessions.push({ id: 'test', workspace: '/mock/ws', messages: [] });
      activeId = 'test';
      mcpInfo = { servers: [{name:'filesystem'}], tools: 35 };
      settings.autoRulesMemory = on;
      settings.autoMemory = false;
      pendingDraft = []; rulesSel = new Set();
      window.__writes = [];
      var modelText = '正文……\\n\\n\`\`\`propose-rules\\n- 端到端测试条目 harness-probe-marker\\n\`\`\`\\n';
      await maybeProposeMemory({ text: modelText });
      return window.__writes.map(function(w){ return { tool: w.tool, path: String(w.path||'').replace(/\\\\/g,'/') }; });
    })();
  };
`;

// i18n 单独 eval（它经 window.i18n 桥）；默认语言须为 zh → 测中文渲染
const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
const { window } = dom;
window.eval(polyfill);
window.eval(i18nSrc);
window.eval(appSrc + "\n;\n" + probeAB + "\n;\n" + probeC);

const writesOn  = await window.__probeC(true);
const writesOff = await window.__probeC(false);
const p = window.__probe || {};

const hasWrite = (ws, end, draft) => ws.some((w) => w.tool === "write"
  && String(w.path).endsWith(end) && (draft ? /draft/.test(w.path) : !/draft/.test(w.path)));

console.log("\n=== A. i18n 中文渲染 + DOM 接线 ===");
check("默认语言 zh-CN", p.A_lang === "zh-CN", String(p.A_lang));
check("labelZh = 工作区规则自动沉淀", /工作区规则自动沉淀/.test(p.A_labelZh || ""), JSON.stringify(p.A_labelZh));
check("hint 含中文（非乱码）", p.A_hintZh_hasMandarin === true);
check("#s-autorules 存在于 DOM", p.A_dom_switch === "EXISTS");
check("#s-autorules aria-checked=true", p.A_dom_aria === "true", String(p.A_dom_aria));
check("DOM span 文本为正确中文", p.A_dom_span_text === "工作区规则自动沉淀", JSON.stringify(p.A_dom_span_text));

console.log("\n=== B. propose 直写契约（开关→autoWriteOn）===");
check("settings.autoRulesMemory 默认 true", p.B_settingsAutoRules === true, String(p.B_settingsAutoRules));
check("autoWriteOn(rules)=true（默认开直写）", p.B_autoWriteOn_default === true, String(p.B_autoWriteOn_default));
check("关掉开关 autoWriteOn(rules)=false", p.B_autoWriteOn_off === false, String(p.B_autoWriteOn_off));
check("knowledge 走总闸默认 false（对照）", p.B_autoWriteOn_knowledge_default === false, String(p.B_autoWriteOn_knowledge_default));

console.log("\n=== C. 端到端实跑 propose（默认开=直写 / 关=落draft）===");
check("默认开：写 RULES.md（直写）", hasWrite(writesOn, "/RULES.md", false), JSON.stringify(writesOn));
check("默认开：无 draft 写入", !writesOn.some((w) => /draft/.test(w.path)));
check("默认开：审计 auto-rules.md 写入", hasWrite(writesOn, "/.strata-memory/auto-rules.md", false));
check("关开关：落 RULES.draft.md（草稿待审）", writesOff.some((w) => /RULES\.draft\.md/.test(w.path)), JSON.stringify(writesOff));

console.log("\n" + (FAILURES.length ? "AUTORULES-I18N-JSDOM: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "AUTORULES-I18N-JSDOM: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
