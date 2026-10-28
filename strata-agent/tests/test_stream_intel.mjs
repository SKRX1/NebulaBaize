/* Regression test for the "boost model intelligence" upgrades (F1-F6 batch).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom, then verifies:
 *
 *   F1  base system prompt is always present (even with no workspace) and pins the Chinese-output rule;
 *       the cnThink toggle adds the Chinese-reasoning rule (off by default).
 *   F2  persona injection: per-session persona wins over the global default.
 *   F3  on-demand knowledge recall: recallKnowledge returns text on a hit, "" on empty/short; the hit is
 *       injected into the prompt as a system message.
 *   F4  auto-compact triggers (pendingCompact + a chat request) only when idle, enabled, and near the ceiling.
 *   F5  auto-learn: after a real task, writes a note via filesystem and ingests it into the knowledge base.
 *
 * Run: node tests/test_stream_intel.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
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
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.localStorage.setItem("strata.lang", "en");   // stable English strings

// Boot-time fetch mock (health / mcp / metrics). Per-test mocks override afterwards.
win.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

// Expose the symbols we test. app.js is strict-mode, so its top-level `let`s aren't on `window`;
// the appended assignment shares the same eval scope and can read/reassign them.
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__api = {
  apiMessages, BASE_SYSTEM, recallKnowledge, recallQuery, maybeAutoLearn, maybeAutoCompact, compactConversation,
  loadDrawer, applyDrawer: () => { const h = $("s-apply").onclick; return h ? h() : undefined; }, DEFAULTS,
  workspaceSystem, userText, activeSession, t,
  extractMemoryProposals, maybeProposeMemory, approveRulesDraft, discardRulesDraft, loadMemoryState,
  renderRulesBanner, renderRulesDraftBody, syncRulesMergeBtn,
  getRulesSel: () => rulesSel, setRulesSel: (v) => { rulesSel = v; },
  getWorkspaceRules: () => workspaceRules, setWorkspaceRules: (v) => { workspaceRules = v; },
  getPendingDraft: () => pendingDraft, setPendingDraft: (v) => { pendingDraft = v; },
  getSettings: () => settings, setSettings: (s) => { settings = Object.assign({}, settings, s); },
  getMessages: () => messages, setMessages: (m) => { messages = m; },
  getSessions: () => sessions, setSessions: (s) => { sessions = s; },
  setActiveId: (id) => { activeId = id; },
  setLastRag: (v) => { lastRag = v; }, getLastRag: () => lastRag,
  setMaxCtx: (v) => { maxCtx = v; }, setLastPromptTokens: (v) => { lastPromptTokens = v; },
  setMcpTools: (n) => { mcpInfo.tools = n; },
  setPendingCompact: (v) => { pendingCompact = v; }, getPendingCompact: () => pendingCompact,
  resetResume: () => { resumeSnapshot = null; resumeBadge = null; if (pendingResume) { clearTimeout(pendingResume.timer); pendingResume = null; } },
  setBusy: (v) => { busy = v; },
  renderMemory, renderKbCard, renderRulesCard, renderNotesCard, renderGlobalCard, mcpTxt,
  renderNextSteps, composeStepsMessage, sendSelectedSteps, send, syncStepsSendLabel,
  paintBubble, patchTool, toolHtml, answerSpec, livePlan, applyPlan, extractPlan,
  renderInspector, render, syncCtxFromSession,
  openImageView, closeImageView, renderAttachments, msgEl,
  getAttachments: () => attachments, setAttachments: (v) => { attachments = v; },
  getCompactCount: () => compactCount, getLastPromptTokens: () => lastPromptTokens,
  getLastCacheTokens: () => lastCacheTokens,
  PROJECT_MEMORY, fsRead, fsWrite,
  extractDesign, detectLang, designLangOf, designFileName,
  maybeProposeDesign, approveDesignDraft, discardDesignDraft, generateDesignFromChat,
  getPendingDesign: () => pendingDesign, setPendingDesign: (v) => { pendingDesign = v; },
};`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = win.__api;
let pass = true;

// Helper: build a chat of N alternating user/assistant turns.
function chat(n) {
  const m = [];
  for (let i = 0; i < n; i++) m.push(i % 2 === 0 ? { role: "user", text: "q" + i } : { role: "assistant", text: "a" + i });
  return m;
}

// ================================================================ F1 + F6: base system prompt
console.log("\n=== F1/F6: base system prompt + Chinese-output + cnThink ===");
{
  api.setSessions([]); api.setActiveId(null); api.setSettings({ cnThink: false, persona: "" });
  api.setMessages([{ role: "user", text: "hi" }]);
  const msgs = api.apiMessages();
  const first = msgs[0];
  check("first message is the always-on base system prompt (no workspace)", first && first.role === "system");
  check("base prompt pins Chinese output", first && /always (write|answer) in (simplified )?Chinese|简体中文|中文/.test(first.content), JSON.stringify(first && first.content.slice(0, 30)));
  check("cnThink OFF -> no Chinese-reasoning rule in base prompt", first && !/think in Chinese|中文思考|思考语言/.test(first.content));

  api.setSettings({ cnThink: true });
  const m2 = api.apiMessages()[0];
  check("cnThink ON -> base prompt adds Chinese-reasoning rule", /think in Chinese|思考语言|中文思考/.test(m2.content));
  api.setSettings({ cnThink: false });
}

// ================================================================ F1b: cnThink dual-position (首因 + 近因) — 修复「多轮后大多不中文思考」
console.log("\n=== F1b: cnThink 单锚注入（合并后首因版为唯一锚点） ===");
{
  api.setSessions([]); api.setActiveId(null); api.setLastRag("");
  // 多轮历史：大量英文代码/报错上下文，模拟「漂移」场景
  api.setMessages([
    { role: "user", text: "Fix the TypeError in src/app.js: cannot read property 'x' of undefined" },
    { role: "assistant", text: "Let me check the stack trace. The error occurs in render() when this.props is null." },
    { role: "user", text: "Also the build fails with 'module not found' in webpack.config.js" },
    { role: "assistant", text: "The resolve.alias is missing. Add it and rerun npm run build." },
  ]);
  api.setSettings({ cnThink: true });
  const msgs = api.apiMessages();
  const sysMsgs = msgs.filter((x) => x.role === "system");
  const firstSys = sysMsgs[0];
  const lastSys = sysMsgs[sysMsgs.length - 1];
  check("cnThink ON -> 首条 system 含强制中文思考规则（首因）",
        /思考语言·强制/.test(firstSys.content), JSON.stringify(firstSys.content.slice(0, 40)));
  check("cnThink ON -> 合并后只有1条 system 且含中文思考规则（单锚）",
        sysMsgs.length === 1 && /思考语言·强制/.test(sysMsgs[0].content),
        JSON.stringify({n: sysMsgs.length, first: sysMsgs[0].content.slice(0, 40)}));
  check("cnThink ON -> 首因规则位于 BASE_SYSTEM 之前（不再是末尾温柔一句）",
        firstSys.content.indexOf("思考语言·强制") < firstSys.content.indexOf("【语言】"));
  // 关闭后两条都不应出现
  api.setSettings({ cnThink: false });
  const off = api.apiMessages();
  check("cnThink OFF -> 首条 system 不再含中文思考规则", !/思考语言/.test(off[0].content));
  check("cnThink OFF -> no separate cnThink system message (merged into first, gate removes it)",
        !off.some((x) => x.role === "system" && /思考语言·强制·重申/.test(x.content)));
  api.setSettings({ cnThink: false });
}

// ================================================================ F2: persona injection
console.log("\n=== F2: persona (session wins over global) ===");
{
  // global default only
  api.setSessions([]); api.setActiveId(null);
  api.setSettings({ persona: "You are a senior backend engineer" });
  const msgs = api.apiMessages();
  check("global persona injected as a system message", msgs.some((m) => m.role === "system" && /senior backend engineer/.test(m.content)));

  // session persona overrides global
  api.setSessions([{ id: "s1", workspace: "/tmp/proj", persona: "SESSION persona text" }]);
  api.setActiveId("s1");
  api.setSettings({ persona: "GLOBAL should be overridden" });
  const m2 = api.apiMessages();
  check("session persona wins", m2.some((m) => m.role === "system" && /SESSION persona text/.test(m.content)));
  check("global persona NOT injected when session has its own", !m2.some((m) => m.role === "system" && /GLOBAL should be overridden/.test(m.content)));
  api.setSessions([]); api.setActiveId(null); api.setSettings({ persona: "" });
}

// ================================================================ F3: on-demand recall
console.log("\n=== F3: on-demand knowledge recall ===");
{
  const recallMock = (text) => async (url, o) => {
    const body = o && o.body ? JSON.parse(o.body) : {};
    // mcp/call answers in the hub envelope {ok, text, ...} - JSON, not raw text
    if (body.server === "memory" && body.tool === "recall")
      return { ok: true, status: 200, json: async () => ({ ok: true, text }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.fetch = recallMock("relevant learned chunk about the build pipeline");
  const hit = await api.recallKnowledge("how does the build work");
  check("recall returns the hit text", hit === "relevant learned chunk about the build pipeline");

  win.fetch = recallMock("no sources");
  const empty = await api.recallKnowledge("anything");
  check("recall returns '' when KB empty", empty === "");

  win.fetch = recallMock("x");
  const short = await api.recallKnowledge("anything");
  check("recall returns '' for a trivially short result", short === "");

  // injection into apiMessages
  api.setLastRag("KB-SNIPPET-XYZ");
  const m = api.apiMessages();
  check("recalled knowledge injected as a system message", m.some((x) => x.role === "system" && /KB-SNIPPET-XYZ/.test(x.content) && /relevant|经验知识|retrieved/.test(x.content)));
  api.setLastRag("");
}

// ================================================================ F4: auto-compact trigger
console.log("\n=== F4: auto-compact (idle + near ceiling) ===");
{
  api.setMessages(chat(8));
  api.setMaxCtx(32768); api.setLastPromptTokens(30000); api.setSettings({ autocompact: true });
  api.setBusy(null); api.setPendingCompact(false);
  let chatCalls = 0;
  win.fetch = (url) => {
    const u = String(url);
    if (u.endsWith("v1/chat/completions")) { chatCalls++; return { ok: true, status: 200, json: async () => ({}), body: { getReader() { return { read: async () => ({ value: undefined, done: true }) }; } } }; }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  api.maybeAutoCompact();
  // pendingCompact now records WHICH kind of compaction is in flight ("auto" | "manual"), so the panel can
  // announce it; the old boolean contract is gone.
  check("auto-compact sets pendingCompact", api.getPendingCompact() === "auto");
  await sleep(60);
  check("auto-compact starts a summarise request", chatCalls >= 1);

  // not triggered when disabled
  api.setPendingCompact(false); api.setSettings({ autocompact: false });
  api.maybeAutoCompact();
  check("auto-compact does NOT trigger when disabled", api.getPendingCompact() === false);

  // not triggered when context low
  api.setSettings({ autocompact: true }); api.setLastPromptTokens(5000);
  api.setPendingCompact(false); api.maybeAutoCompact();
  check("auto-compact does NOT trigger when context is low", api.getPendingCompact() === false);

  // not triggered while busy
  api.setLastPromptTokens(30000); api.setBusy({ controller: new win.AbortController(), msg: {} } );
  api.setPendingCompact(false); api.maybeAutoCompact();
  check("auto-compact does NOT trigger while busy", api.getPendingCompact() === false);

  api.setBusy(null); api.setPendingCompact(false); api.setMessages([]); win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
}

// ================================================================ F5: auto-learn (write + ingest)
console.log("\n=== F5: auto-learn writes + ingests a task summary ===");
{
  api.setSessions([{ id: "s1", workspace: "/tmp/proj" }]); api.setActiveId("s1");
  api.setSettings({ autolearn: true }); api.setMcpTools(2);
  api.setMessages([
    { role: "user", text: "Refactor the parser" },
    { role: "assistant", text: "I refactored the parser to use a tokenizer. It now handles edge cases and is 20% faster. ".repeat(3),
      tools: [{ name: "filesystem__write", arguments: { path: "/tmp/proj/parser.py", content: "x" } }] },
  ]);
  const calls = [];
  win.fetch = async (url, o) => {
    const u = String(url); const body = o && o.body ? JSON.parse(o.body) : {};
    if (u === "mcp/call") {
      calls.push(body);
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) };
    }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const m = api.getMessages()[1];
  await api.maybeAutoLearn(m);
  const write = calls.find((c) => c.server === "filesystem" && c.tool === "write");
  const ingest = calls.find((c) => c.server === "memory" && c.tool === "ingest");
  check("auto-learn wrote a note via filesystem.write", !!write && /Refactor the parser/.test(write.args.content) && /\.strata-memory\//.test(write.args.path));
  check("auto-learn ingested the note into the knowledge base", !!ingest && /auto-/.test(ingest.args.source));
  // G3: the note records the actual operation (file written) so future "edited parser.py" recalls can hit it
  check("auto-learn note records the file actually acted on (G3)", !!write && /filesystem__write/.test(write.args.content) && /\/tmp\/proj\/parser\.py/.test(write.args.content));

  // not triggered when disabled
  api.setSettings({ autolearn: false }); api.setMcpTools(2);
  const calls2 = [];
  win.fetch = async (url, o) => { const u = String(url); if (u === "mcp/call") calls2.push(JSON.parse(o.body)); return { ok: true, status: 200, text: async () => "ok" }; };
  await api.maybeAutoLearn(m);
  check("auto-learn does NOT run when disabled", calls2.length === 0);

  api.setSessions([]); api.setActiveId(null); api.setSettings({ autolearn: false }); api.setMcpTools(0); api.setMessages([]);
}

// ================================================================ F3b: recall query survives short follow-ups (G2)
console.log("\n=== F3b: recall query survives short follow-ups (G2) ===");
{
  api.setMessages([{ role: "user", text: "如何给这个组件加注释" }]);
  check("normal last message is used as-is", api.recallQuery() === "如何给这个组件加注释");

  api.setMessages([{ role: "user", text: "写一个解析函数" }, { role: "assistant", text: "好" }, { role: "user", text: "继续" }]);
  check("short follow-up falls back to + concatenates previous user msg", api.recallQuery() === "写一个解析函数\n继续");

  api.setMessages([{ role: "user", text: "解释这段代码" }, { role: "assistant", text: "..." }, { role: "user", text: "为什么" }]);
  check("follow-up keyword '为什么' concatenates previous", api.recallQuery() === "解释这段代码\n为什么");

  api.setMessages([{ role: "user", text: "好的" }]);
  check("lone short message still returns something (no crash)", api.recallQuery() === "好的");
  api.setMessages([]);
}

// ================================================================ F7: G1 base working-principles
console.log("\n=== F7: G1 base working-principles in BASE_SYSTEM ===");
{
  const b = api.BASE_SYSTEM;
  check("BASE_SYSTEM still pins Chinese output", /简体中文|中文/.test(b));
  check("BASE_SYSTEM adds 工作准则 (clarify / prefer tools / structure / cite sources)",
        /工作准则/.test(b) && /澄清/.test(b) && /优先调用工具/.test(b) && /结构化/.test(b) && /标明它来自经验库/.test(b));
  check("BASE_SYSTEM does NOT carry the Chinese-thinking rule phrase (keeps cnThink toggle meaningful)",
        !/中文思考|思考语言|think in Chinese/.test(b));
}

// ================================================================ F8: G4 workspace self-check prompt
console.log("\n=== F8: G4 workspace self-check prompt ===");
{
  const w = api.workspaceSystem("/tmp/proj");
  check("workspace prompt tells the model to verify results / fix errors before declaring done",
        /确认结果/.test(w) && /先修复/.test(w));
}

// ================================================================ F6b: settings-UI wiring for cnThink
console.log("\n=== F6b: cnThink settings toggle (default-off + wiring) ===");
{
  // default-off guarantee (the feature must be opt-in, never on by surprise)
  check("DEFAULTS.cnThink is false (opt-in by default)", api.DEFAULTS && api.DEFAULTS.cnThink === false);

  // drawer reflects the current setting
  api.setSettings({ cnThink: false });
  api.loadDrawer();
  const el = doc.getElementById("s-cnthink");
  check("drawer shows cnThink OFF when setting is false", el && el.getAttribute("aria-checked") === "false");

  // toggle ON (mimics the user's click), then apply via the real s-apply handler
  el.setAttribute("aria-checked", "true");
  await api.applyDrawer();
  check("toggling ON + apply sets settings.cnThink = true", api.getSettings().cnThink === true);

  // end-to-end: with cnThink on, the system prompt now carries the Chinese-reasoning rule
  const sys = api.apiMessages()[0];
  check("after enabling in settings, prompt enforces Chinese reasoning", sys && /思考语言|中文思考|think in Chinese/.test(sys.content));

  // toggle back OFF and apply -> reverts
  doc.getElementById("s-cnthink").setAttribute("aria-checked", "false");
  await api.applyDrawer();
  check("toggling back OFF reverts settings.cnThink = false", api.getSettings().cnThink === false);

  api.setSettings({ cnThink: false });
}

// ================================================================ H1: work memory on by default
console.log("\n=== H1: work memory (auto-learn) ON by default ===");
{
  check("DEFAULTS.autolearn is true (work memory auto-captures tasks)", api.DEFAULTS && api.DEFAULTS.autolearn === true);
}

// ================================================================ H2: workspace rules tier
console.log("\n=== H2: workspace rules tier (propose -> draft -> approve) ===");
{
  // H2a: parse a propose-rules block (strips fences and leading bullets)
  const parsed = api.extractMemoryProposals("rules", "正文...\n\n```propose-rules\n- 约定一\n- 约定二\n```\n");
  check("extractMemoryProposals pulls the list out of the block", parsed.length === 2 && parsed[0] === "约定一" && parsed[1] === "约定二");
  check("extractMemoryProposals returns [] when no block", api.extractMemoryProposals("rules", "no block here").length === 0);

  // H2b: workspace prompt always carries the propose-rules convention, and injects the approved
  // rules section only when workspaceRules is non-empty.
  const wEmpty = api.workspaceSystem("/tmp/proj");
  check("workspace prompt instructs the model to propose-rules", /propose-rules/.test(wEmpty));
  check("no approved-rules section when workspaceRules empty", !/本工作空间操作约定/.test(wEmpty));

  api.setWorkspaceRules("已有约定A\n已有约定B");
  const wRules = api.workspaceSystem("/tmp/proj");
  check("approved rules injected as a system section when present", /本工作空间操作约定/.test(wRules) && /已有约定A/.test(wRules) && /已有约定B/.test(wRules));
  api.setWorkspaceRules("");

  // H2c: maybeProposeMemory stages a draft via filesystem (autoMemory OFF -> no auto-apply)
  api.setSessions([{ id: "s1", workspace: "/tmp/proj" }]); api.setActiveId("s1"); api.setMcpTools(2);
  api.setPendingDraft([]); api.setSettings({ autoMemory: false });
  const c3 = { calls: [] };
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") { const b = o && o.body ? JSON.parse(o.body) : {}; c3.calls.push(b); return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) }; }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const mProp = { role: "assistant", text: "做完了。\n\n```propose-rules\n- 部署前必须重启 Strata\n- 前端改动硬刷新生效\n```\n" };
  await api.maybeProposeMemory(mProp);
  const draft = api.getPendingDraft();
  check("maybeProposeMemory stages the proposed entries as a draft", draft.length === 2 && /部署前必须重启 Strata/.test(draft.join("\n")));
  const draftWrite = c3.calls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.draft\.md$/.test(c.args.path));
  check("draft is written to <ws>/RULES.draft.md", !!draftWrite && /部署前必须重启 Strata/.test(draftWrite.args.content));
  const rulesWrite = c3.calls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.md$/.test(c.args.path) && !/RULES\.draft\.md$/.test(c.args.path));
  check("proposal does NOT auto-write RULES.md (needs approval)", !rulesWrite);

  // H2d: approveRulesDraft merges into RULES.md and clears the draft
  api.setWorkspaceRules("已有约定A"); api.setPendingDraft(["部署前必须重启 Strata", "前端改动硬刷新生效"]);
  const c4 = { calls: [], reads: { "/tmp/proj/RULES.md": "已有约定A" } };
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") {
      const b = o && o.body ? JSON.parse(o.body) : {}; c4.calls.push(b);
      if (b.server === "filesystem" && b.tool === "read") return { ok: true, status: 200, json: async () => ({ ok: true, text: c4.reads[b.args.path] || "" }) };
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) };
    }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await api.approveRulesDraft();
  const rulesW = c4.calls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.md$/.test(c.args.path) && !/RULES\.draft\.md$/.test(c.args.path));
  check("approve merges into RULES.md", !!rulesW && /部署前必须重启 Strata/.test(rulesW.args.content) && /已有约定A/.test(rulesW.args.content));
  check("approval clears the pending draft", api.getPendingDraft().length === 0);
  check("approval updates the injected workspaceRules", api.getWorkspaceRules() === "已有约定A\n部署前必须重启 Strata\n前端改动硬刷新生效");

  // H2e: discardRulesDraft just clears the draft
  api.setPendingDraft(["临时约定Z"]);
  await api.discardRulesDraft();
  check("discard clears the pending draft", api.getPendingDraft().length === 0);

  // H2f: loadMemoryState reads approved rules + pending draft from disk on workspace switch
  const c5 = { reads: { "/tmp/proj/RULES.md": "盘上约定1", "/tmp/proj/RULES.draft.md": "盘上草稿2" } };
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") {
      const b = o && o.body ? JSON.parse(o.body) : {};
      if (b.server === "filesystem" && b.tool === "read") return { ok: true, status: 200, json: async () => ({ ok: true, text: c5.reads[b.args.path] || "" }) };
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) };
    }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  await api.loadMemoryState("/tmp/proj");
  check("loadMemoryState reads approved RULES.md", api.getWorkspaceRules() === "盘上约定1");
  check("loadMemoryState reads pending RULES.draft.md", api.getPendingDraft().length === 1 && api.getPendingDraft()[0] === "盘上草稿2");

  api.setSessions([]); api.setActiveId(null); api.setMcpTools(0); api.setWorkspaceRules(""); api.setPendingDraft([]); api.setMessages([]);
}

// ================================================================ H3: suggestion multi-select + expandable approval banner
console.log("\n=== H3: next-step multi-select + expandable approval banner ===");
{
  // ---- next-steps chips: click TOGGLES; the action row sends the picked ones together ----
  const steps = [
    {label: "浏览器实玩", detail: "打开 index.html 玩一轮反馈手感"},
    {label: "性能压测", detail: ""},
    {label: "横屏适配", detail: "把静音状态与最高分持久化"},
  ];
  api.setMessages([{role: "assistant", text: "done", steps}]);
  const host = doc.createElement("div");
  host.className = "st-msg"; host.dataset.i = "0";
  host.innerHTML = '<div class="next-steps" hidden></div>';
  doc.getElementById("chat").appendChild(host);
  api.renderNextSteps(host, api.getMessages()[0]);
  const chips = () => [...host.querySelectorAll(".next-step")];
  check("chips render one button per suggestion", chips().length === 3);
  check("no action row before any selection", !host.querySelector("[data-steps-send]"));

  chips()[0].dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("click selects a chip (multi-select mode)", chips()[0].classList.contains("next-step--on"));
  check("selected chip exposes aria-pressed", chips()[0].getAttribute("aria-pressed") === "true");
  check("action row appears with the picked count", !!host.querySelector("[data-steps-send]") && /Send selected \(1\)/.test(host.querySelector("[data-steps-send]").textContent));

  chips()[2].dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("a second chip can be selected as well", chips()[0].classList.contains("next-step--on") && chips()[2].classList.contains("next-step--on"));
  check("action row counts both picks", /Send selected \(2\)/.test(host.querySelector("[data-steps-send]").textContent));

  chips()[0].dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("clicking a selected chip unselects it", !chips()[0].classList.contains("next-step--on") && chips()[2].classList.contains("next-step--on"));

  host.querySelector("[data-steps-clear]").dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("clear drops the whole selection", !host.querySelector("[data-steps-send]") && !host.querySelector(".next-step--on"));

  // composed message text (pure function - send() itself needs the network)
  check("single pick gets exec prefix + label", api.composeStepsMessage(steps, [1]) === api.t("nextsteps.exec.prefix") + " 性能压测");
  check("single pick with detail gets exec prefix", api.composeStepsMessage(steps, [0]) === api.t("nextsteps.exec.prefix") + " 浏览器实玩：打开 index.html 玩一轮反馈手感");
  const combo = api.composeStepsMessage(steps, [0, 1, 2]);
  check("multi pick composes a numbered batch", /Please do the following in order:/.test(combo) && /1\. 浏览器实玩：/.test(combo) && /3\. 横屏适配：/.test(combo));
  check("empty selection composes nothing", api.composeStepsMessage(steps, []) === "");
  host.remove();

  // ---- rules banner: expandable list, per-item checkboxes, partial merge ----
  api.setSessions([{id: "s1", workspace: "/tmp/proj"}]); api.setActiveId("s1"); api.setMcpTools(2);
  const seed = () => { api.setPendingDraft(["约定甲", "约定乙", "约定丙"]); api.setRulesSel(new Set(["约定甲", "约定乙", "约定丙"])); api.renderRulesBanner(); };
  seed();
  const banner = doc.getElementById("rules-draft-banner");
  const body = doc.getElementById("rules-draft-body");
  const peek = doc.getElementById("rules-draft-peek");
  const mergeBtn = doc.getElementById("rules-draft-merge");
  check("banner shows while a draft is pending", banner.hidden === false);
  check("proposal panel starts collapsed", body.hidden === true && peek.getAttribute("aria-expanded") === "false");

  peek.dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("peek expands the proposal list", body.hidden === false && peek.getAttribute("aria-expanded") === "true");
  check("panel lists every proposed rule", body.querySelectorAll("[data-rd-i]").length === 3 && /约定乙/.test(body.textContent));
  check("every row is ticked by default", body.querySelectorAll("[data-rd-i]:checked").length === 3);
  check("merge keeps its full-approval label while all are ticked", mergeBtn.textContent === "Merge into RULES.md" && mergeBtn.disabled === false);

  const box1 = body.querySelectorAll("[data-rd-i]")[1];
  box1.checked = false;
  box1.dispatchEvent(new win.Event("change", {bubbles: true}));
  check("unchecking one row switches merge to a partial label", /Merge selected \(2\)/.test(mergeBtn.textContent));
  check("selection state tracks the checkbox", api.getRulesSel().size === 2 && !api.getRulesSel().has("约定乙"));

  let all = doc.getElementById("rules-draft-body").querySelector("[data-rd-all]");
  all.checked = false;
  all.dispatchEvent(new win.Event("change", {bubbles: true}));
  check("select-all off empties the selection and disables merge", api.getRulesSel().size === 0 && mergeBtn.disabled === true);
  all = doc.getElementById("rules-draft-body").querySelector("[data-rd-all]");   // re-rendered: re-query
  all.checked = true;
  all.dispatchEvent(new win.Event("change", {bubbles: true}));
  check("select-all on ticks everything again", api.getRulesSel().size === 3 && mergeBtn.disabled === false);

  // ---- partial merge must KEEP the un-approved lines (data-loss regression) ----
  const c6 = { calls: [], reads: { "/tmp/proj/RULES.md": "旧约定" } };
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") {
      const b = o && o.body ? JSON.parse(o.body) : {}; c6.calls.push(b);
      if (b.server === "filesystem" && b.tool === "read") return { ok: true, status: 200, text: async () => c6.reads[b.args.path] || "" };
      return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) };
    }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  seed();
  await api.approveRulesDraft(["约定乙"]);
  const w6 = c6.calls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.md$/.test(c.args.path) && !/RULES\.draft\.md$/.test(c.args.path));
  const d6 = c6.calls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.draft\.md$/.test(c.args.path));
  check("partial merge writes only the approved line to RULES.md", !!w6 && /约定乙/.test(w6.args.content) && !/约定甲/.test(w6.args.content));
  check("partial merge KEEPS the other lines in the draft file", !!d6 && /约定甲/.test(d6.args.content) && /约定丙/.test(d6.args.content));
  check("pending draft shrinks to exactly the un-approved lines", JSON.stringify(api.getPendingDraft()) === JSON.stringify(["约定甲", "约定丙"]));

  // ---- per-item drop from the panel ----
  seed();
  doc.getElementById("rules-draft-body").querySelector("[data-rd-del]").dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  await sleep(10);
  check("per-item drop removes just that line", JSON.stringify(api.getPendingDraft()) === JSON.stringify(["约定乙", "约定丙"]));
  check("banner still shows for the remaining lines", doc.getElementById("rules-draft-banner").hidden === false);
  check("panel re-renders without the dropped line", doc.getElementById("rules-draft-body").querySelectorAll("[data-rd-i]").length === 2);

  api.setSessions([]); api.setActiveId(null); api.setWorkspaceRules(""); api.setPendingDraft([]); api.setRulesSel(new Set());
}

// ================================================================ Memory management view (M1-M6)
console.log("\n=== Memory view: KB / rules / notes / global ===");
{
  // Dedicated mcp/call mock that inspects the tool + args and records every call.
  const memCalls = [];
  win.fetch = async (url, o) => {
    const u = String(url);
    if (!u.endsWith("mcp/call")) {
      if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
      if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const body = o && o.body ? JSON.parse(o.body) : {};
    memCalls.push(body);
    const { server, tool, args } = body;
    // every mcp/call branch answers in the hub envelope {ok, text}
    if (server === "memory" && tool === "sources") return { ok: true, status: 200, json: async () => ({ ok: true, text: "design-spec.md: 14 chunks\nauto-2026-10-17-x: 3 chunks" }) };
    if (server === "memory" && tool === "read_source") return { ok: true, status: 200, json: async () => ({ ok: true, text: "[chunk 1]\nsource content" }) };
    if (server === "memory" && tool === "recall") return { ok: true, status: 200, json: async () => ({ ok: true, text: "[semantic] recalled" }) };
    if (server === "memory" && tool === "ingest") return { ok: true, status: 200, json: async () => ({ ok: true, text: "ingested 5 chunks" }) };
    if (server === "memory" && tool === "forget") return { ok: true, status: 200, json: async () => ({ ok: true, text: "deleted" }) };
    if (server === "filesystem" && tool === "read") {
      if ((args.path || "").endsWith("MEMORY.md")) return { ok: true, status: 200, json: async () => ({ ok: true, text: "# global memory\n- a convention" }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, text: "# RULES\n- rule a\n- rule b" }) };
    }
    if (server === "filesystem" && tool === "write") return { ok: true, status: 200, json: async () => ({ ok: true, text: "wrote" }) };
    if (server === "filesystem" && tool === "list") return { ok: true, status: 200, json: async () => ({ ok: true, text: "auto-2026-10-17-x.md\nother.txt" }) };
    if (server === "filesystem" && tool === "delete") return { ok: true, status: 200, json: async () => ({ ok: true, text: "deleted" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
  };
  win.confirm = () => true;

  api.setMcpTools(1);
  api.setSessions([{ id: "s1", title: "t", workspace: "E:/ws", permission: "full", messages: [] }]);
  api.setActiveId("s1");
  api.setWorkspaceRules("");
  api.setPendingDraft([]);

  // M1: KB list renders sources with a delete control
  await api.renderKbCard();
  const kbHtml = doc.getElementById("mem-kb-list").innerHTML;
  check("KB card lists a parsed source name", /design-spec\.md/.test(kbHtml));
  const delBtn = doc.querySelector('#mem-kb-list [data-kb-del="auto-2026-10-17-x"]');
  check("KB card has a delete control per source", !!delBtn);

  // M2: deleting a KB source calls memory.forget with that source id
  memCalls.length = 0;
  if (delBtn) delBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const forgot = memCalls.find((c) => c.server === "memory" && c.tool === "forget" && c.args.source === "auto-2026-10-17-x");
  check("KB delete calls memory.forget(source)", !!forgot);

  // M3: viewing a KB source calls read_source and fills the body
  memCalls.length = 0;
  const viewBtn = doc.querySelector('#mem-kb-list [data-kb-view="design-spec.md"]');
  if (viewBtn) viewBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const read = memCalls.find((c) => c.server === "memory" && c.tool === "read_source" && c.args.source === "design-spec.md");
  check("KB view calls read_source(source)", !!read);
  const pre = doc.querySelector('#mem-kb-list .mem-src-body');
  check("KB view fills the source body", pre && !pre.hidden && /source content/.test(pre.textContent));

  // M4: rules card loads RULES.md into the editor; saving writes it back
  await api.renderRulesCard();
  const edit = doc.getElementById("mem-rules-edit");
  check("rules card loads RULES.md into the editor", edit && /rule a/.test(edit.value));
  edit.value = "# RULES\n- edited rule";
  doc.getElementById("mem-rules-save").dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const wrote = memCalls.find((c) => c.server === "filesystem" && c.tool === "write" && /RULES\.md$/.test(c.args.path) && c.args.content === "# RULES\n- edited rule");
  check("rules save writes RULES.md via filesystem", !!wrote);
  check("rules save updates in-memory workspaceRules", api.getWorkspaceRules() === "# RULES\n- edited rule");

  // M5: notes card lists auto-*.md; deleting also forgets the KB source derived from the filename
  await api.renderNotesCard();
  const noteDel = doc.querySelector('#mem-notes-list [data-note-del$="auto-2026-10-17-x.md"]');
  check("notes card lists an auto-*.md note with a delete control", !!noteDel);
  memCalls.length = 0;
  if (noteDel) noteDel.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await sleep(10);
  const fsDel = memCalls.find((c) => c.server === "filesystem" && c.tool === "delete" && /auto-2026-10-17-x\.md$/.test(c.args.path));
  const noteForget = memCalls.find((c) => c.server === "memory" && c.tool === "forget" && c.args.source === "auto-2026-10-17-x");
  check("note delete removes the file via filesystem.delete", !!fsDel);
  check("note delete also forgets the derived KB source", !!noteForget);

  // M6: global MEMORY.md is shown read-only
  await api.renderGlobalCard();
  const gb = doc.getElementById("mem-global-body");
  check("global MEMORY.md body is populated (read-only)", gb && /global memory/.test(gb.textContent) && gb.textContent !== "");
}

console.log("\n=== Design documents (.design/ folder) ===");
{
  // unit: extraction / filename / language
  const ex = api.extractDesign("前文说明\n\n```design\n# 登录功能设计\n\n## 目标\n做一个登录页\n```\n\n后文说明\n");
  check("extractDesign pulls title + body from a ```design block", ex && ex.title === "登录功能设计" && /做一个登录页/.test(ex.body));
  check("extractDesign returns null without a block", api.extractDesign("no design here") === null);
  check("designFileName keeps zh title + .md", api.designFileName("登录功能设计") === "登录功能设计.md");
  check("designFileName strips illegal chars", !/[\\/:*?"<>|]/.test(api.designFileName('a/b:c*?"<>name')) && api.designFileName("x").endsWith(".md"));
  check("detectLang flags Chinese as zh", api.detectLang("请实现一个登录功能页面") === "zh");
  check("detectLang flags English as en", api.detectLang("Please implement a login page") === "en");

  api.setSettings({ designLang: "zh" });
  check("designLangOf returns zh when forced", api.designLangOf() === "zh");
  api.setSettings({ designLang: "auto" });
  api.setMessages([{ role: "user", text: "请实现一个登录功能页面" }]);
  check("designLangOf follows conversation (zh) under auto", api.designLangOf() === "zh");
  api.setMessages([{ role: "user", text: "Please implement a login page" }]);
  check("designLangOf follows conversation (en) under auto", api.designLangOf() === "en");

  // integration: propose -> approve -> discard, capturing filesystem writes
  api.setSessions([{ id: "s1", workspace: "/tmp/proj" }]); api.setActiveId("s1"); api.setMcpTools(2);
  api.setPendingDesign(null);
  const dCalls = [];
  win.fetch = async (url, o) => {
    const u = String(url);
    if (u === "mcp/call") { const b = o && o.body ? JSON.parse(o.body) : {}; dCalls.push(b); return { ok: true, status: 200, text: async () => "ok", json: async () => ({ ok: true, text: "ok" }) }; }
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
    if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } } ) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const mDesign = { role: "assistant", text: "规划如下：\n\n```design\n# 登录功能设计\n\n## 目标\n做一个登录页\n\n## 任务分解\n- [ ] 写前端\n- [ ] 写后端\n```\n\n完成。\n" };
  await api.maybeProposeDesign(mDesign);
  check("maybeProposeDesign stages the design as pending", api.getPendingDesign() && api.getPendingDesign().title === "登录功能设计");
  check("maybeProposeDesign writes nothing until approved", !dCalls.find((c) => c.server === "filesystem" && c.tool === "write" && /\.design\//.test(c.args.path)));

  api.setPendingDesign(null);
  await api.maybeProposeDesign({ role: "assistant", text: "没有设计块" });
  check("maybeProposeDesign ignores messages without a design block", api.getPendingDesign() === null);

  dCalls.length = 0;
  api.setPendingDesign({ title: "登录功能设计", body: "# 登录功能设计\n\n## 目标", file: "登录功能设计.md", ws: "/tmp/proj" });
  await api.approveDesignDraft();
  const dWrite = dCalls.find((c) => c.server === "filesystem" && c.tool === "write" && c.args.path === "/tmp/proj/.design/登录功能设计.md");
  check("approveDesignDraft writes under <ws>/.design/", !!dWrite && /## 目标/.test(dWrite.args.content));
  check("approveDesignDraft clears pendingDesign", api.getPendingDesign() === null);

  api.setPendingDesign({ title: "x", body: "y", file: "x.md", ws: "/tmp/proj" });
  await api.discardDesignDraft();
  check("discardDesignDraft clears pendingDesign", api.getPendingDesign() === null);

  // generateDesignFromChat aggregates plan/next-steps when no explicit design block
  api.setMessages([
    { role: "user", text: "做一个登录功能" },
    { role: "assistant", text: "好的。\n```plan\n- [ ] 写前端\n- [ ] 写后端\n```\n\n```next-steps\n- 测试一下\n```\n" },
  ]);
  dCalls.length = 0;
  await api.generateDesignFromChat();
  const genWrite = dCalls.find((c) => c.server === "filesystem" && c.tool === "write" && /\.design\//.test(c.args.path));
  check("generateDesignFromChat writes an aggregated doc under .design/", !!genWrite && /任务计划/.test(genWrite.args.content) && /下一步建议/.test(genWrite.args.content));
}

// ================================================================= H4: live panel + stable badges + chips+text
console.log("\n=== H4: live task panel, badge reuse (no strobe), chips + custom text ===");
{
  // --- a) streaming repaints must NOT recreate the tool blocks: that restarted the badge blink (strobe) ---
  const bubble = doc.createElement("div");
  const msg = {role: "assistant", text: "搞定", tools: [
    {id: "a", name: "fs_write", server: "filesystem", tool: "write", arguments: {path: "a.txt"}, at: 0,
     state: "done", ok: true, ms: 120, result: "ok"},
    {id: "b", name: "sh", server: "shell", tool: "run", arguments: {command: "ls"}, at: 2, state: "running"},
  ]};
  api.paintBubble(bubble, msg, true);
  const dets0 = [...bubble.querySelectorAll(".tool-call")];
  const badge0 = dets0[0].querySelector(".st-badge");
  const badge1 = dets0[1].querySelector(".st-badge");
  msg.text = "搞定" + "，正在写文件".repeat(4);
  api.paintBubble(bubble, msg, true);
  api.paintBubble(bubble, msg, true);
  const dets1 = [...bubble.querySelectorAll(".tool-call")];
  check("repaint keeps the same tool <details> nodes", dets1.length === 2 && dets1[0] === dets0[0] && dets1[1] === dets0[1]);
  check("repaint keeps the same badge element (blink is not restarted)", dets1[0].querySelector(".st-badge") === badge0);
  msg.tools[1].state = "done"; msg.tools[1].ok = true; msg.tools[1].ms = 80; msg.tools[1].result = "a.txt";
  api.paintBubble(bubble, msg, true);
  const det2 = bubble.querySelectorAll(".tool-call")[1];
  check("finishing a call patches state in place", det2.dataset.state === "done");
  check("finishing a call keeps its badge node", det2.querySelector(".st-badge") === badge1);
  check("finishing a call renders the done label", /Done/.test(det2.querySelector(".st-badge").textContent), det2.querySelector(".st-badge").textContent);
  check("the trailing prose still grows", /正在写文件/.test(bubble.textContent));
  msg.tools.push({id: "c", name: "sh", server: "shell", tool: "run", arguments: {command: "pwd"}, at: msg.text.length, state: "writing"});
  api.paintBubble(bubble, msg, true);
  check("a new tool block is appended without touching the others", bubble.querySelectorAll(".tool-call").length === 3 &&
    bubble.querySelectorAll(".tool-call")[0] === dets0[0]);

  // --- b) the panel follows the CURRENT turn, live, even before the plan fence closes ---
  const planText = () => doc.getElementById("ins-plan-list").textContent;
  api.setMessages([{role: "user", text: "做个登录页"}]);
  api.setBusy({controller: {}, msg: {role: "assistant", text: "开始。\n```plan\n- [x] 写前端\n- [ ] 写后端\n"}});
  api.renderInspector();
  check("live plan shows while the fence is still open", /写前端/.test(planText()) && /写后端/.test(planText()), planText());
  check("live plan counts the ticked items", doc.getElementById("ins-plan-count").textContent === "1/2",
    doc.getElementById("ins-plan-count").textContent);
  check("live plan is marked as running", doc.getElementById("ins-plan-live").hidden === false);
  // the next task starts: its message has no checklist yet -> the previous task's list must disappear
  api.setBusy({controller: {}, msg: {role: "assistant", text: "我先看看目录结构"}});
  api.renderInspector();
  check("a new turn no longer shows the previous task's checklist", !/写前端/.test(planText()), planText());
  check("it says the checklist is pending instead", /Waiting for this turn/.test(planText()), planText());
  // idle: only the NEWEST answer may supply a checklist
  api.setBusy(null);
  api.setMessages([
    {role: "user", text: "old"}, {role: "assistant", text: "done", plan: [{done: true, label: "旧任务一步"}]},
    {role: "user", text: "new"}, {role: "assistant", text: "no plan in here"},
  ]);
  api.renderInspector();
  check("an older task's checklist is not resurrected", !/旧任务一步/.test(planText()), planText());
  api.setMessages([{role: "user", text: "one"}, {role: "assistant", text: "x", plan: [{done: false, label: "当前任务一步"}]}]);
  api.renderInspector();
  check("the newest answer's checklist is shown", /当前任务一步/.test(planText()), planText());
  check("B idle+unticked shows the reminder", /unticked item/i.test(planText()), planText());
  api.setMessages([{role: "user", text: "one"}, {role: "assistant", text: "x", plan: [{done: true, label: "allDoneStep"}]}]);
  api.renderInspector();
  check("B idle+fully-ticked does NOT show the reminder", /allDoneStep/.test(planText()) && !/unticked item/i.test(planText()), planText());

  // --- c) context fill follows the engine's live prompt size, not just the end-of-turn usage chunk ---
  api.setMaxCtx(262144); api.setLastPromptTokens(0);
  api.setBusy({controller: {}, msg: {role: "assistant", text: ""}});
  api.render({engine: {max_context: 262144}, live: {state: "generating", prompt_tokens: 84000}});
  check("context fill tracks the live prompt size (84000/262144 ≈ 32%)",
    doc.getElementById("ins-ctx-pct").textContent === "32%", doc.getElementById("ins-ctx-pct").textContent);
  check("context sub-line shows the live token count", /84\.0k|84k/.test(doc.getElementById("ins-ctx-sub").textContent),
    doc.getElementById("ins-ctx-sub").textContent);
  api.setBusy(null);
  // --- d) auto-compaction is visible instead of silent ---
  // F4 scenario above ends clean - under the 2026-11 contract (compaction IS
  // truncation, always resume) its undo window is still open and the panel row
  // shows the auto-resumed segment; close it before checking the threshold wording.
  api.resetResume();
  api.setSettings({autocompact: true});
  api.renderInspector();
  api.renderInspector();
  check("panel names the auto-compact threshold (adaptive: floor 50% when physical 262K  128K)", /Auto-compact at 50%/.test(doc.getElementById("ins-ctx-note").textContent),
    doc.getElementById("ins-ctx-note").textContent);
  api.setSettings({autocompact: false});
  api.renderInspector();
  check("panel says when auto-compact is off", /Auto-compact: off/.test(doc.getElementById("ins-ctx-note").textContent),
    doc.getElementById("ins-ctx-note").textContent);
  api.setSettings({autocompact: true});

  // --- e) switching a task restores that task's occupancy (it used to leak across sessions) ---
  api.setMessages([{role: "assistant", text: "x", stats: {prompt: 12345, completion: 10, ctxUsed: 12345, ctxMax: 32768, cache: 6789}}]);
  api.syncCtxFromSession();
  check("switching restores the context readout", api.getLastPromptTokens() === 12345 && api.getLastCacheTokens() === 6789,
    `${api.getLastPromptTokens()}/${api.getLastCacheTokens()}`);
  api.setMessages([{role: "user", text: "fresh"}]);
  api.syncCtxFromSession();
  check("an empty task clears the readout", api.getLastPromptTokens() === 0);

  // --- f) plan blocks leave the prose and do not break tool anchors ---
  const withPlan = {text: "前\n```plan\n- [x] 甲\n```\n中间\n```plan\n- [x] 甲\n- [ ] 乙\n```\n尾巴",
                    tools: [{id: "x", name: "t", at: "前\n```plan\n- [x] 甲\n```\n中间\n```plan\n- [x] 甲\n- [ ] 乙\n```\n尾巴".length, state: "done"}]};
  const found = api.applyPlan(withPlan);
  check("applyPlan keeps the LAST checklist", found.length === 2 && found[1].label === "乙", JSON.stringify(found));
  check("applyPlan cuts every plan block out of the prose", !/```plan/.test(withPlan.text), withPlan.text);
  check("applyPlan shifts tool anchors with the removed text", withPlan.tools[0].at === withPlan.text.length,
    `${withPlan.tools[0].at} vs ${withPlan.text.length}`);

  // --- g) chips + typed text go out as ONE message ---
  const steps = [{label: "横屏适配", detail: "改 CSS"}, {label: "性能压测"}];
  check("custom text alone composes to itself", api.composeStepsMessage(steps, [], "顺手改字体") === "顺手改字体");
  const one = api.composeStepsMessage(steps, [0], "顺手改字体");
  check("single pick + custom text has exec prefix and both", one.startsWith(api.t("nextsteps.exec.prefix")) && one.includes("横屏适配：改 CSS") && /Also: 顺手改字体/.test(one), one);
  check("no custom text single pick gets exec prefix", api.composeStepsMessage(steps, [0]) === api.t("nextsteps.exec.prefix") + " 横屏适配：改 CSS");
  const many = api.composeStepsMessage(steps, [0, 1], "顺手改字体");
  check("multi pick + custom text has the batch and the extra",
    /Please do the following in order/.test(many) && /2\. 性能压测/.test(many) && /Also: 顺手改字体/.test(many), many);

  // the send button tells the user the typed text will ride along
  // mirror production: the .next-steps box lives in the document (so syncStepsSendLabel's
  // document-wide querySelector finds it) and there is exactly one action row at a time.
  doc.querySelectorAll("[data-steps-send]").forEach((b) => b.remove());
  const chipHost = doc.createElement("div");
  chipHost.innerHTML = `<div class="next-steps" hidden></div>`;
  doc.body.appendChild(chipHost);
  const chipMsg = {role: "assistant", text: "a", steps, selSteps: [0]};
  api.setMessages([{role: "user", text: "q"}, chipMsg]);
  doc.getElementById("input").textContent = "顺手改字体";
  api.renderNextSteps(chipHost, chipMsg);
  const sendBtn = chipHost.querySelector("[data-steps-send]");
  check("the send button advertises the custom text", !!sendBtn && /Send selected \(1\) \+ custom/.test(sendBtn.textContent),
    sendBtn && sendBtn.textContent);

  // end-to-end: Enter with a selection + typed text sends one composed user message
  const bodies = [];
  win.fetch = async (url, opt) => {
    const u = String(url);
    if (u.endsWith("v1/chat/completions")) {
      bodies.push(JSON.parse(opt.body));
      return {ok: true, status: 200, json: async () => ({}),
              body: {getReader() { return {read: async () => ({value: undefined, done: true})}; }}};
    }
    return {ok: true, status: 200, json: async () => ({model: "test-model", max_context: 32768, servers: [], tools: 0})};
  };
  api.setSettings({recall: false, mcp: false});
  api.setBusy(null);
  api.setMessages([{role: "user", text: "做页面"}, {role: "assistant", text: "ok", steps, selSteps: [0]}]);
  doc.getElementById("input").textContent = "顺带把字体调大";
  await api.send();
  const sent = bodies.length ? bodies[0].messages : [];
  const lastUser = [...sent].reverse().find((x) => x.role === "user");
  check("chips + typed text are sent as one user message", !!lastUser &&
    /横屏适配/.test(lastUser.content) && /Also: 顺带把字体调大/.test(lastUser.content), lastUser && lastUser.content);
  check("the selection is cleared after sending", (api.getMessages()[1].selSteps || []).length === 0);
}

// === H5: image viewer — paste/drop thumbnail + double-click to enlarge ===
{
  // open/close the viewer modal directly
  api.openImageView("data:image/png;base64,ZZZ", "shot.png");
  check("openImageView reveals the modal", !doc.getElementById("img-modal").hidden);
  check("openImageView wires the src", doc.getElementById("img-modal-img").src === "data:image/png;base64,ZZZ");
  check("openImageView shows the name", doc.getElementById("img-modal-name").textContent === "shot.png");
  api.closeImageView();
  check("closeImageView hides the modal", !!doc.getElementById("img-modal").hidden);

  // composer renders a real thumbnail (not just an icon chip) for an image attachment
  api.setAttachments([{kind: "image", name: "pasted.png", url: "data:image/png;base64,AAA"}]);
  api.renderAttachments();
  const box = doc.getElementById("attachments");
  const thumb = box.querySelector(".chip--img");
  check("an image attachment renders a management chip (image rides inline, strip is the chip)", !!thumb && thumb.classList.contains("chip--img"));
  check("the image chip is the chip--img management chip (image is inline, not a separate img thumb)", !!box.querySelector(".chip--img"));
  check("the image chip has a remove button", !!box.querySelector(".chip--img .st-btn--icon"));
  // double-click the thumbnail opens the viewer
  thumb.dispatchEvent(new win.MouseEvent("dblclick", {bubbles: true}));
  check("double-clicking the composer image chip opens the viewer", !doc.getElementById("img-modal").hidden &&
        doc.getElementById("img-modal-img").src === "data:image/png;base64,AAA");
  api.closeImageView();
  // removing the thumbnail via the × button empties the box
  box.querySelector(".chip--img .st-btn--icon").dispatchEvent(new win.MouseEvent("click", {bubbles: true}));
  check("removing the image chip clears attachments", !box.querySelector(".chip--img"));

  // a text-file attachment still uses the icon chip
  api.setAttachments([{kind: "file", name: "note.txt", text: "hi"}]);
  api.renderAttachments();
  check("a file attachment still renders a chip", !!doc.getElementById("attachments").querySelector(".chip"));

  // a sent user message's image gets the msg-img class and is double-clickable from #chat
  const el = api.msgEl({role: "user", text: "x", time: Date.now(),
                        images: [{name: "m.png", url: "data:image/png;base64,BBB"}]}, 0);
  const mimg = el.querySelector("img.msg-img");
  check("a user message image carries msg-img", !!mimg && mimg.src === "data:image/png;base64,BBB");
  const chat = doc.getElementById("chat");
  chat.appendChild(el);
  mimg.dispatchEvent(new win.MouseEvent("dblclick", {bubbles: true}));
  check("double-clicking a message image opens the viewer", !doc.getElementById("img-modal").hidden &&
        doc.getElementById("img-modal-img").src === "data:image/png;base64,BBB");
  api.closeImageView();
  chat.innerHTML = "";
}

console.log("\n" + (FAILURES.length ? "STREAM INTEL: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "STREAM INTEL: ALL PASSED"));
// Exit non-zero on failure: this suite used to exit 0 unconditionally, so a fully red run still reported
// "PASS" in the regression summary and CI stayed green over a broken build.
process.exit(FAILURES.length ? 1 : 0);

