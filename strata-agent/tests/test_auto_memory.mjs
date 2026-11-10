/* Regression test for the autonomous-memory system (思维设置 -> 自主维护记忆).

Boots the REAL index.html + i18n.js + app.js in jsdom, with an in-memory fake workspace
filesystem, and verifies the full contract for the three stores (rules / knowledge / experience):

  DEFAULTS / toggle  autoMemory defaults OFF, persists via the drawer.
  Prompt             OFF -> "待审批" for every store; ON -> "直接写入" + rules keep "实际验证过".
  OFF path           proposal -> draft (RULES -> banner; knowledge/experience -> <file>.draft.md).
  ON path            proposal -> store file directly, audited, with one-click undo; dedup against the file.
  Guardrails         per-turn cap (rules 5 / knowledge 8) and an oversized store falls back to review.
  Combined           one message with all three fences writes all three files.
  Panel              renderAutoMemoryCard lists audit entries + drafts with undo/archive + weekly count.
  Tidy               tidyMemory() dedupes exact + contained duplicates.
  Archive            archiveAutoEntry moves a live line to the cold file and out of the audit.

Run: node tests/test_auto_memory.mjs
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
win.localStorage.setItem("strata.lang", "en");

// ---- in-memory workspace disk -------------------------------------------------
const WS = "/tmp/ws";
const DISK = new Map();
let CALLS = [];
function resetDisk(seed = {}) {
  DISK.clear(); CALLS = [];
  for (const [k, v] of Object.entries(seed)) DISK.set(k, v);
}
function disk(p) { return DISK.has(p) ? DISK.get(p) : ""; }
function writes(p) { return CALLS.filter((c) => c.tool === "write" && c.args.path === p).map((c) => c.args.content); }

win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") {
    const b = o && o.body ? JSON.parse(o.body) : {};
    CALLS.push(b);
    if (b.server === "filesystem" && b.tool === "read")
      return { ok: true, status: 200, json: async () => ({ ok: true, text: disk(b.args.path) }) };
    if (b.server === "filesystem" && b.tool === "write") {
      DISK.set(b.args.path, b.args.content);
      return { ok: true, status: 200, json: async () => ({ ok: true, text: "ok" }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
  }
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "m", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 2 }) };
  return { ok: true, status: 200, json: async () => ({}) };
};

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__api = {
  DEFAULTS, workspaceSystem, loadDrawer,
  applyDrawer: () => { const h = $("s-apply").onclick; return h ? h() : undefined; },
  getSettings: () => settings, setSettings: (s) => { settings = Object.assign({}, settings, s); },
  setSessions: (s) => { sessions = s; }, setActiveId: (id) => { activeId = id; },
  setMcpTools: (n) => { mcpInfo.tools = n; }, getMcpTools: () => mcpInfo.tools,
  MEMORY_STORES, MEMORY_ORDER, GLOBAL_ROOT, safeGroup, groupDir, storePath, auditPath,
  extractMemoryProposals,
  maybeProposeMemory, loadMemoryState, mergeMemoryInto, appendMemoryAudit,
  undoAutoMemory, loadPendingDrafts, approveMemoryDraft, discardMemoryDraft,
  tidyMemory, parseAudit, archiveAutoEntry, renderAutoMemoryCard,
  promoteEntry, demoteEntry, nextScopeUp, nextScopeDown, scopeLabel, getGroupLabel, setGroupLabel,
  createMemoryEntry, openWeeklyModal, closeWeeklyModal, scopeName, getWeeklyEntries: () => weeklyEntries,
  getPendingDraft: () => pendingDraft, setPendingDraft: (v) => { pendingDraft = v; },
  getPendingDrafts: () => pendingDrafts,
  getWorkspaceRules: () => workspaceRules, setWorkspaceRules: (v) => { workspaceRules = v; },
  getGlobalRules: () => globalRules, setGlobalRules: (v) => { globalRules = v; },
  getGroupRules: () => groupRules, setGroupRules: (v) => { groupRules = v; },
  getCurrentGroup: () => currentGroup, setCurrentGroup: (v) => { currentGroup = v; },
  getWorkspaceKnowledge: () => workspaceKnowledge, getGlobalKnowledge: () => globalKnowledge, getGroupKnowledge: () => groupKnowledge,
  renderRulesBanner, getRulesSel: () => rulesSel,
};`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROPOSE = (fence, lines) =>
  ({ role: "assistant", text: "做完了。\n\n```" + fence + "\n" + lines.map((l) => "- " + l).join("\n") + "\n```\n" });
const RULES = "propose-rules", KNOW = "propose-knowledge", EXP = "propose-experience";
const fileOf = (store) => WS + "/" + api.MEMORY_STORES[store].file;
const auditOf = (store) => WS + "/" + api.MEMORY_STORES[store].audit;

function setup(storeFiles = {}, rules = "") {
  resetDisk(storeFiles);
  api.setSessions([{ id: "s1", workspace: WS }]); api.setActiveId("s1"); api.setMcpTools(2);
  api.setWorkspaceRules(rules); api.setPendingDraft([]);
  api.setSettings({ ...api.DEFAULTS });   // reset settings to factory default each section (kills cross-section leakage)
}

// ================================================================ 1. default OFF + prompt truth
console.log("\n=== 1. default OFF and truthful prompts for all three stores ===");
{
  check("DEFAULTS.autoMemory is false", api.DEFAULTS.autoMemory === false, String(api.DEFAULTS.autoMemory));
  check("settings.autoMemory starts false", !api.getSettings().autoMemory, String(api.getSettings().autoMemory));

  const off = api.workspaceSystem(WS);
  check("OFF prompt: every store staged for review", /待审批/.test(off) && !/直接写入/.test(off));
  api.setSettings({ autoMemory: true });
  const on = api.workspaceSystem(WS);
  check("ON prompt: says it is written directly", /直接写入/.test(on));
  check("ON prompt: names the autonomous feature", /自主维护记忆/.test(on));
  check("ON prompt: rules demand verified facts", /实际验证过/.test(on));
  check("ON prompt: mentions all three fences", /propose-rules/.test(on) && /propose-knowledge/.test(on) && /propose-experience/.test(on));
  api.setSettings({ autoMemory: false });
}

// ================================================================ 2. OFF -> drafts (all three)
console.log("\n=== 2. OFF: proposals stage as drafts, store files untouched ===");
for (const [fence, store] of [[RULES, "rules"], [KNOW, "knowledge"], [EXP, "experience"]]) {
  setup({ [fileOf(store)]: "existing-line" }, store === "rules" ? "existing-line" : "");
  api.setSettings({ autoMemory: false, autoRulesMemory: false });
  await api.maybeProposeMemory(PROPOSE(fence, ["item-one", "item-two"]));

  if (store === "rules") {
    check(`[${store}] OFF: RULES.draft.md written`, writes(WS + "/RULES.draft.md").length === 1);
    check(`[${store}] OFF: banner visible`, doc.getElementById("rules-draft-banner").hidden === false);
  } else {
    const df = disk(fileOf(store) + ".draft.md");
    check(`[${store}] OFF: <file>.draft.md written`, df.includes("item-one") && df.includes("item-two"), JSON.stringify(df));
  }
  check(`[${store}] OFF: store file untouched`, writes(fileOf(store)).length === 0, JSON.stringify(writes(fileOf(store))));
  check(`[${store}] OFF: no audit file`, !DISK.has(auditOf(store)));
}

// ================================================================ 3. ON -> merge + audit + undo
console.log("\n=== 3. ON: merge into store file, audited, undoable ===");
for (const [fence, store] of [[RULES, "rules"], [KNOW, "knowledge"], [EXP, "experience"]]) {
  setup({ [fileOf(store)]: "existing-line" }, store === "rules" ? "existing-line" : "");
  api.setSettings({ autoMemory: true });
  CALLS = [];
  await api.maybeProposeMemory(PROPOSE(fence, ["auto-a", "auto-b"]));

  const f = disk(fileOf(store));
  check(`[${store}] ON: gained both lines`, /auto-a/.test(f) && /auto-b/.test(f), JSON.stringify(f));
  check(`[${store}] ON: kept existing line`, /existing-line/.test(f));
  check(`[${store}] ON: no draft written`, writes(fileOf(store) + ".draft.md").length === 0);
  const audit = disk(auditOf(store));
  check(`[${store}] ON: audit records lines with timestamp`, /\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(audit) && /auto-a/.test(audit), JSON.stringify(audit));

  // dedup: re-proposing an existing line writes nothing
  CALLS = [];
  await api.maybeProposeMemory(PROPOSE(fence, ["auto-a"]));
  check(`[${store}] ON: duplicate writes nothing`, writes(fileOf(store)).length === 0);

  // undo (rules via toast click; others via direct API)
  if (store === "rules") {
    doc.getElementById("toasts").innerHTML = "";
    await api.maybeProposeMemory(PROPOSE(fence, ["rules-x"]));
    const btn = doc.querySelector("#toasts .st-toast button");
    check("[rules] ON: undo button offered", !!btn && /Undo/.test(btn.textContent), btn ? btn.textContent : "none");
    if (btn) btn.click();
    await sleep(20);
    check("[rules] ON: undo removed the auto line", !/rules-x/.test(disk(fileOf("rules"))));
  } else {
    await api.undoAutoMemory(store, "workspace", ["auto-a"], WS);
    check(`[${store}] ON: undo removed the auto line`, !/auto-a/.test(disk(fileOf(store))), JSON.stringify(disk(fileOf(store))));
    check(`[${store}] ON: undo cleared it from audit`, !/auto-a/.test(disk(auditOf(store))));
  }
}

// ================================================================ 4. guardrails: caps + oversize
console.log("\n=== 4. guardrails: per-turn cap and oversized store falls back to review ===");
{
  setup({ [fileOf("rules")]: "" }, "");
  api.setSettings({ autoMemory: true });
  await api.maybeProposeMemory(PROPOSE(RULES, ["r1","r2","r3","r4","r5","r6","r7","r8"]));
  const n = disk(fileOf("rules")).split("\n").filter(Boolean).length;
  check("rules: at most 5 merged from one turn", n === 5, String(n));

  const big = Array.from({ length: 81 }, (_, i) => "old-rule-" + i).join("\n");
  setup({ [fileOf("rules")]: big }, big);
  api.setSettings({ autoMemory: true });
  await api.maybeProposeMemory(PROPOSE(RULES, ["new-z"]));
  check("rules oversized: file untouched", !/new-z/.test(disk(fileOf("rules"))));
  check("rules oversized: proposal waits in draft", api.getPendingDraft().includes("new-z"), JSON.stringify(api.getPendingDraft()));
  check("rules oversized: banner reappears", doc.getElementById("rules-draft-banner").hidden === false);

  // knowledge per-turn cap (8)
  setup({ [fileOf("knowledge")]: "" }, "");
  api.setSettings({ autoMemory: true });
  await api.maybeProposeMemory(PROPOSE(KNOW, ["k1","k2","k3","k4","k5","k6","k7","k8","k9","k10"]));
  const k = disk(fileOf("knowledge")).split("\n").filter(Boolean).length;
  check("knowledge: at most 8 merged from one turn", k === 8, String(k));
}

// ================================================================ 5. combined message -> 3 files
console.log("\n=== 5. one message with all three fences writes all three files ===");
{
  setup({}, "");
  api.setSettings({ autoMemory: true });
  const text = "done\n\n```propose-rules\n- r-main\n```\n\n```propose-knowledge\n- k-main\n```\n\n```propose-experience\n- e-main\n```\n";
  await api.maybeProposeMemory({ role: "assistant", text });
  check("rules file has r-main", /r-main/.test(disk(fileOf("rules"))));
  check("knowledge file has k-main", /k-main/.test(disk(fileOf("knowledge"))));
  check("experience file has e-main", /e-main/.test(disk(fileOf("experience"))));
}

// ================================================================ 6. panel render + weekly + archive
console.log("\n=== 6. memory panel lists audit + drafts, undo/archive, weekly count ===");
{
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  setup({}, "");
  api.setSettings({ autoMemory: true });
  // seed an auto-applied rules entry (audit) + a pending knowledge draft
  DISK.set(auditOf("rules"), `- [${now}] panel-rule`);
  DISK.set(fileOf("rules"), "panel-rule\n");
  DISK.set(fileOf("knowledge") + ".draft.md", "panel-k-draft");
  await api.renderAutoMemoryCard();
  const list = doc.getElementById("mem-auto-list").innerHTML;
  check("panel: shows the auto-applied rule", /panel-rule/.test(list));
  check("panel: offers undo for the audit entry", /data-auto-undo=/.test(list));
  check("panel: offers archive for the audit entry", /data-auto-archive=/.test(list));
  check("panel: shows the pending knowledge draft", /panel-k-draft/.test(list));
  check("panel: weekly summary counts the recent entry", /this week/i.test(doc.getElementById("mem-auto-sum").textContent || ""));

  // archive the rules entry via the panel button
  const arch = doc.querySelector("#mem-auto-list [data-auto-archive]");
  check("panel: archive button exists", !!arch);
  if (arch) arch.click();
  await sleep(20);
  check("archive: rule removed from live file", !/panel-rule/.test(disk(fileOf("rules"))), JSON.stringify(disk(fileOf("rules"))));
  check("archive: rule moved to cold file", /panel-rule/.test(disk(auditOf("rules") + ".cold.md")));
}

// ================================================================ 7. tidy dedup
console.log("\n=== 7. tidyMemory dedupes exact + contained duplicates ===");
{
  setup({}, "");
  api.setSettings({ autoMemory: true });
  DISK.set(fileOf("knowledge"), "alpha\nbeta\nalpha\nalpha is a subset of alphabet\ngamma");
  await api.tidyMemory();
  const f = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("tidy: dropped the exact duplicate", f.filter((l) => l === "alpha").length === 1, JSON.stringify(f));
  check("tidy: dropped the contained duplicate", !f.includes("alpha is a subset of alphabet"), JSON.stringify(f));
  check("tidy: kept distinct lines", f.includes("beta") && f.includes("gamma"));
}

// ================================================================ 8. drawer switch persistence
console.log("\n=== 8. drawer switch reflects + persists autoMemory ===");
{
  api.setSettings({ autoMemory: false });
  api.loadDrawer({ ...api.DEFAULTS, autoMemory: true });
  const sw = doc.getElementById("s-automemory");
  check("loadDrawer mirrors autoMemory=true", sw.getAttribute("aria-checked") === "true", sw.getAttribute("aria-checked"));
  api.loadDrawer({ ...api.DEFAULTS, autoMemory: false });
  check("loadDrawer mirrors autoMemory=false", sw.getAttribute("aria-checked") === "false");

  sw.setAttribute("aria-checked", "true");
  await api.applyDrawer();
  check("applying the drawer persists autoMemory", api.getSettings().autoMemory === true, String(api.getSettings().autoMemory));
  const saved = JSON.parse(win.localStorage.getItem("strata.sampling") || "{}");
  check("autoMemory persisted to localStorage", saved.autoMemory === true, JSON.stringify(saved).slice(0, 120));

  sw.onclick();
  check("clicking the switch turns it off", sw.getAttribute("aria-checked") === "false");
  sw.onclick();
  check("clicking again turns it back on", sw.getAttribute("aria-checked") === "true");
  api.setSettings({ autoMemory: false });
}

// ================================================================ 9. scope-aware paths
console.log("\n=== 9. scope-aware paths resolve to workspace / group / global ===");
{
  check("workspace store path", api.storePath("rules", "workspace", WS) === WS + "/RULES.md", api.storePath("rules", "workspace", WS));
  check("global store path", api.storePath("rules", "global", WS) === api.GLOBAL_ROOT + "/RULES.md", api.storePath("rules", "global", WS));
  check("group store path", api.storePath("rules", "group", WS, "nebula") === api.GLOBAL_ROOT + "/groups/nebula/RULES.md", api.storePath("rules", "group", WS, "nebula"));
  check("group dir strips illegal chars", api.groupDir("neb/ula: x") === api.GLOBAL_ROOT + "/groups/nebula x", api.groupDir("neb/ula: x"));
  check("workspace audit path", api.auditPath("knowledge", "workspace", WS) === WS + "/.strata-memory/auto-knowledge.md", api.auditPath("knowledge", "workspace", WS));
  check("global audit path", api.auditPath("experience", "global", WS) === api.GLOBAL_ROOT + "/auto-experience.md", api.auditPath("experience", "global", WS));
  check("group audit path", api.auditPath("experience", "group", WS, "nebula") === api.GLOBAL_ROOT + "/groups/nebula/auto-experience.md", api.auditPath("experience", "group", WS, "nebula"));
}

// ================================================================ 10. promote / demote across three scopes
console.log("\n=== 10. promote/demote move an entry up/down the workspace->group->global chain ===");
{
  // (a) No group set -> workspace promotes straight to global.
  DISK.set(api.storePath("rules", "workspace", WS), "universal-rule\n");
  DISK.set(api.auditPath("rules", "workspace", WS), "- [2026-01-01 00:00] universal-rule\n");
  api.setCurrentGroup("");
  const t1 = await api.promoteEntry("rules", "workspace", "universal-rule", WS, "");
  check("no-group promote lands on global", t1 === "global", String(t1));
  await api.loadMemoryState(WS);
  check("promote: global file has the entry", /universal-rule/.test(disk(api.storePath("rules", "global", WS))), JSON.stringify(disk(api.storePath("rules", "global", WS))));
  check("promote: globalRules var updated", /universal-rule/.test(api.getGlobalRules() || ""), String(api.getGlobalRules()));
  check("promote: workspaceRules var cleared", !/universal-rule/.test(api.getWorkspaceRules() || ""));

  await api.demoteEntry("rules", "global", "universal-rule", WS, "");
  await api.loadMemoryState(WS);
  check("demote: workspace file has it again", /universal-rule/.test(disk(api.storePath("rules", "workspace", WS))));
  check("demote: global file no longer has it", !/universal-rule/.test(disk(api.storePath("rules", "global", WS))));

  // (b) Group set -> workspace promotes to group first, then group promotes to global.
  // The group must be persisted to disk (group.txt) so loadMemoryState picks it up, just like the real app.
  await api.setGroupLabel(WS, "nebula");
  await api.loadMemoryState(WS);
  DISK.set(api.storePath("rules", "workspace", WS), "group-rule\n");
  DISK.set(api.auditPath("rules", "workspace", WS), "- [2026-01-01 00:00] group-rule\n");
  const t2 = await api.promoteEntry("rules", "workspace", "group-rule", WS, "nebula");
  check("group-set promote lands on group", t2 === "group", String(t2));
  await api.loadMemoryState(WS);
  check("promote: group file has the entry", /group-rule/.test(disk(api.storePath("rules", "group", WS, "nebula"))), JSON.stringify(disk(api.storePath("rules", "group", WS, "nebula"))));
  check("promote: groupRules var updated", /group-rule/.test(api.getGroupRules() || ""), String(api.getGroupRules()));
  check("promote: global file still empty", !/group-rule/.test(disk(api.storePath("rules", "global", WS))));

  const t3 = await api.promoteEntry("rules", "group", "group-rule", WS, "nebula");
  check("group promotes to global", t3 === "global", String(t3));
  await api.loadMemoryState(WS);
  check("promote: now in global file", /group-rule/.test(disk(api.storePath("rules", "global", WS))));
  check("promote: gone from group file", !/group-rule/.test(disk(api.storePath("rules", "group", WS, "nebula"))));

  // demote back down the chain
  await api.demoteEntry("rules", "global", "group-rule", WS, "nebula");
  await api.loadMemoryState(WS);
  check("demote: global -> group (group set)", /group-rule/.test(disk(api.storePath("rules", "group", WS, "nebula"))));
  await api.demoteEntry("rules", "group", "group-rule", WS, "nebula");
  await api.loadMemoryState(WS);
  check("demote: group -> workspace", /group-rule/.test(disk(api.storePath("rules", "workspace", WS))));
  check("demote: gone from group file", !/group-rule/.test(disk(api.storePath("rules", "group", WS, "nebula"))));
  api.setCurrentGroup("");
}

// ================================================================ 11. group + global memory injected into the prompt (precedence)
console.log("\n=== 11. global + group memory injected; more specific tiers win ===");
{
  // Global tier (read from the globalRules variable, set here directly).
  api.setGlobalRules("GLOBAL-ONLY-CONVENTION");
  const gOnly = api.workspaceSystem(WS);
  check("prompt: global rules section present", /全局操作约定/.test(gOnly));
  check("prompt: global rule content present", /GLOBAL-ONLY-CONVENTION/.test(gOnly));
  api.setGlobalRules("");

  // Group tier: persist the group on disk, seed the group files, and load so the vars are populated.
  DISK.set(WS + "/.strata-memory/group.txt", "nebula\n");
  DISK.set(api.storePath("rules", "group", WS, "nebula"), "GROUP-ONLY-CONVENTION\n");
  DISK.set(api.storePath("knowledge", "group", WS, "nebula"), "GROUP-FACT\n");
  await api.loadMemoryState(WS);
  check("loadMemoryState: group rules var populated", /GROUP-ONLY-CONVENTION/.test(api.getGroupRules() || ""), String(api.getGroupRules()));
  const g = api.workspaceSystem(WS);
  check("prompt: group rules section present", /工作区间操作约定/.test(g));
  check("prompt: group rule content present", /GROUP-ONLY-CONVENTION/.test(g));
  check("prompt: group knowledge section present", /工作区间知识库/.test(g));
  check("prompt: group knowledge content present", /GROUP-FACT/.test(g));
  check("prompt: group section ordered after global", g.indexOf("工作区间操作约定") > g.indexOf("全局操作约定"));
  api.setGroupRules("");
  api.setCurrentGroup("");
}

// ================================================================ 12. group membership persisted + loaded
console.log("\n=== 12. workspace group label persists to disk and is loaded ===");
{
  await api.setGroupLabel(WS, "nebula");
  check("getGroupLabel reads back", (await api.getGroupLabel(WS)) === "nebula", await api.getGroupLabel(WS));
  await api.loadMemoryState(WS);
  check("loadMemoryState sets currentGroup", api.getCurrentGroup() === "nebula", api.getCurrentGroup());
  await api.setGroupLabel(WS, "");
  await api.loadMemoryState(WS);
  check("clearing group resets currentGroup", api.getCurrentGroup() === "", api.getCurrentGroup());
}

// ================================================================ 13. direct create entry (global / group)
console.log("\n=== 13. direct create entry writes to global/group scope without promotion ===");
{
  // (a) global: a human-authored rule goes straight to the global store + audit.
  setup({}, "");
  api.setCurrentGroup("");
  const okG = await api.createMemoryEntry("rules", "global", "GLOBAL-MANUAL-RULE", WS, "");
  check("global create returns true", okG === true, String(okG));
  check("global create: rule in global file", /GLOBAL-MANUAL-RULE/.test(disk(api.storePath("rules", "global", WS))), JSON.stringify(disk(api.storePath("rules", "global", WS))));
  check("global create: audit records it", /GLOBAL-MANUAL-RULE/.test(disk(api.auditPath("rules", "global", WS))));
  check("global create: globalRules var updated", /GLOBAL-MANUAL-RULE/.test(api.getGlobalRules() || ""), String(api.getGlobalRules()));

  // (b) group: requires currentGroup; writes to the group store + audit.
  await api.setGroupLabel(WS, "nebula");
  await api.loadMemoryState(WS);
  const okK = await api.createMemoryEntry("knowledge", "group", "GROUP-MANUAL-FACT", WS, "nebula");
  check("group create returns true", okK === true, String(okK));
  check("group create: knowledge in group file", /GROUP-MANUAL-FACT/.test(disk(api.storePath("knowledge", "group", WS, "nebula"))), JSON.stringify(disk(api.storePath("knowledge", "group", WS, "nebula"))));
  check("group create: audit records it", /GROUP-MANUAL-FACT/.test(disk(api.auditPath("knowledge", "group", WS, "nebula"))));
  check("group create: groupKnowledge var updated", /GROUP-MANUAL-FACT/.test(api.getGroupKnowledge() || ""), String(api.getGroupKnowledge()));

  // (c) dedupe: re-creating the same line is a no-op (no duplicate).
  DISK.clear();
  setup({}, "");
  api.setCurrentGroup("");
  await api.createMemoryEntry("rules", "global", "DUP-RULE", WS, "");
  CALLS = [];
  const dup = await api.createMemoryEntry("rules", "global", "DUP-RULE", WS, "");
  check("create: duplicate returns false", dup === false, String(dup));
  check("create: no second write on duplicate", writes(api.storePath("rules", "global", WS)).length === 0);
  api.setCurrentGroup("");
}

// ================================================================ 14. weekly summary collects only the last 7 days
console.log("\n=== 14. weekly summary modal gathers entries within the last 7 days ===");
{
  setup({}, "");
  api.setCurrentGroup("");
  const now = new Date();
  const stamp = (d) => { const x = new Date(now.getTime() + d * 86400000); return x.toISOString().slice(0, 16).replace("T", " "); };
  // one recent (today) workspace rule + one 8-day-old global knowledge + one 3-day-old group-less global experience
  DISK.set(api.auditPath("rules", "workspace", WS), `- [${stamp(0)}] recent-rule\n`);
  DISK.set(api.auditPath("knowledge", "global", WS), `- [${stamp(-8)}] old-knowledge\n`);
  DISK.set(api.auditPath("experience", "global", WS), `- [${stamp(-3)}] mid-experience\n`);
  await api.openWeeklyModal();
  const wk = api.getWeeklyEntries();
  check("weekly: recent rule included", wk.some((e) => e.text === "recent-rule"), JSON.stringify(wk));
  check("weekly: mid experience included", wk.some((e) => e.text === "mid-experience"));
  check("weekly: 8-day-old excluded", !wk.some((e) => e.text === "old-knowledge"), JSON.stringify(wk));
  check("weekly: count is exactly 2", wk.length === 2, String(wk.length));
  check("weekly: list rendered in modal", /recent-rule/.test(doc.getElementById("weekly-list").innerHTML));
  api.closeWeeklyModal();
}


// ================================================================ 15. fix A: over-budget store that CAN be losslessly compacted merges straight in
{
  // Knowledge hard cap is 200. Seed 205 content lines: 195 unique + 10 exact duplicates -> lossless
  // dedup drops the 10 dupes, landing at 195 (< maxLines), leaving room to merge the fresh line.
  // Before fix A an over-budget store fell straight to the draft path, so the fresh line would NOT be
  // in the store file. With A it compacts then merges, so the fresh line lands in the store file.
  const uniq = Array.from({ length: 195 }, (_, i) => "kn-unique-" + i);
  const dupes = uniq.slice(0, 10);
  const seedLines = uniq.concat(dupes);          // 205 content lines, 195 unique after dedup
  setup({ [fileOf("knowledge")]: seedLines.join("\n") }, "");
  api.setSettings({ autoMemory: true, memCompactLLM: false });
  await api.maybeProposeMemory(PROPOSE(KNOW, ["A-FIX-NEW-ENTRY"]));
  const kf = disk(fileOf("knowledge")).split("\n").map((l) => l.trim()).filter(Boolean);
  check("fix A: lossless compaction dropped the 10 duplicate lines", kf.filter((l) => /^kn-unique-/.test(l)).length === 195, String(kf.filter((l) => /^kn-unique-/.test(l)).length));
  check("fix A: the fresh line merged straight into the store file", kf.includes("A-FIX-NEW-ENTRY"), JSON.stringify(kf.slice(-3)));
  check("fix A: store stayed within hard cap after merge", kf.length <= 200, String(kf.length));
  check("fix A: fresh line is NOT stuck in a draft", !(disk(fileOf("knowledge") + ".draft.md") || "").includes("A-FIX-NEW-ENTRY"));
  api.setSettings({ autoMemory: false, memCompactLLM: false });
}
// ------------------------------------------------------------------ result
console.log("\n" + (FAILURES.length ? "AUTO-MEMORY: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "AUTO-MEMORY: ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
