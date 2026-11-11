/* DYNAMIC GATE for the per-store rules auto-save switch (Plan-A).

Boots the REAL index.html + i18n.js + app.js in jsdom (same harness as test_auto_memory),
with an in-memory fake workspace filesystem, and locks the runtime BEHAVIOUR the static
gate (_autorules_gate.py) cannot reach:

  DEFAULT-ON        settings.autoRulesMemory defaults true; a propose-rules message at
                    DEFAULT settings merges straight into RULES.md, writes NO draft, audits it.
  MASTER-INDEPENDENT knowledge/experience at DEFAULT (master autoMemory OFF) still go to
                    draft -> proves rules decoupled from the master switch.
  SWITCH-OFF        turning the rules switch OFF routes the rules proposal to the draft banner
                    (manual review), RULES.md untouched -> proves the switch is live.
  DRAWER-WIRING     the s-autorules DOM switch reflects the saved value and its click toggles it.

Run: node tests/test_autorules_dynamic.mjs
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

const WS = "/tmp/ws";
const DISK = new Map();
let CALLS = [];
function resetDisk(seed = {}) { DISK.clear(); CALLS = []; for (const [k, v] of Object.entries(seed)) DISK.set(k, v); }
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
  DEFAULTS, loadDrawer,
  applyDrawer: () => { const h = $("s-apply").onclick; return h ? h() : undefined; },
  getSettings: () => settings, setSettings: (s) => { settings = Object.assign({}, settings, s); },
  autoWriteOn,
  setSessions: (s) => { sessions = s; }, setActiveId: (id) => { activeId = id; },
  setMcpTools: (n) => { mcpInfo.tools = n; },
  MEMORY_STORES, MEMORY_ORDER, GLOBAL_ROOT, storePath, auditPath,
  extractMemoryProposals, maybeProposeMemory, loadMemoryState,
  getPendingDraft: () => pendingDraft, setPendingDraft: (v) => { pendingDraft = v; },
  getWorkspaceRules: () => workspaceRules, setWorkspaceRules: (v) => { workspaceRules = v; },
  renderRulesBanner, getRulesSel: () => rulesSel,
};`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROPOSE = (fence, lines) =>
  ({ role: "assistant", text: "done\n\n```" + fence + "\n" + lines.map((l) => "- " + l).join("\n") + "\n```\n" });
const RULES = "propose-rules", KNOW = "propose-knowledge";
const fileOf = (store) => WS + "/" + api.MEMORY_STORES[store].file;
const auditOf = (store) => WS + "/" + api.MEMORY_STORES[store].audit;

function setup(storeFiles = {}, rules = "") {
  resetDisk(storeFiles);
  api.setSessions([{ id: "s1", workspace: WS }]); api.setActiveId("s1"); api.setMcpTools(2);
  api.setWorkspaceRules(rules); api.setPendingDraft([]);
  api.setSettings({ ...api.DEFAULTS });   // reset to factory default each section (kills cross-section leakage)
}

// ================================================= 1. default-ON rules write STRAIGHT, no draft
console.log("\n=== 1. DEFAULT settings: a rules proposal lands in RULES.md directly, NO draft ===");
{
  check("DEFAULTS.autoRulesMemory is TRUE (the whole point)", api.DEFAULTS.autoRulesMemory === true, String(api.DEFAULTS.autoRulesMemory));
  check("autoWriteOn(rules) is true at DEFAULT", api.autoWriteOn("rules") === true, String(api.autoWriteOn("rules")));
  check("autoWriteOn(knowledge) is false at DEFAULT (master gates it)", api.autoWriteOn("knowledge") === false, String(api.autoWriteOn("knowledge")));

  setup({ [fileOf("rules")]: "existing-rule" }, "existing-rule");
  await api.maybeProposeMemory(PROPOSE(RULES, ["dyn-direct-write"]));
  const f = disk(fileOf("rules"));
  check("default-ON: RULES.md gained the line directly", /dyn-direct-write/.test(f) && /existing-rule/.test(f), JSON.stringify(f));
  check("default-ON: NO RULES.draft.md written", writes(WS + "/RULES.draft.md").length === 0);
  check("default-ON: audit records the auto line", /dyn-direct-write/.test(disk(auditOf("rules"))), JSON.stringify(disk(auditOf("rules"))));
}

// ================================================= 2. master-ON gates knowledge straight; proves independence
console.log("\n=== 2. rules is DECOUPLED from master: master ON gates knowledge directly, rules stays via own switch ===");
{
  setup({ [fileOf("rules")]: "" }, "");
  api.setSettings({ autoMemory: true });   // master ON, rules switch keeps its default ON
  await api.maybeProposeMemory(PROPOSE(RULES, ["r-decoupled"]));
  check("master-ON: rules STILL direct-writes (its own switch)", /r-decoupled/.test(disk(fileOf("rules"))), JSON.stringify(disk(fileOf("rules"))));
  check("master-ON: rules audit written", /r-decoupled/.test(disk(auditOf("rules"))));
}

// ================================================= 3. switch OFF routes rules to draft banner (manual review)
console.log("\n=== 3. rules switch OFF: proposal goes to the draft banner, RULES.md untouched ===");
{
  setup({ [fileOf("rules")]: "existing-rule" }, "existing-rule");
  api.setSettings({ autoRulesMemory: false });   // only the rules switch off; master still default false
  check("autoWriteOn(rules) is FALSE when switch off", api.autoWriteOn("rules") === false, String(api.autoWriteOn("rules")));
  await api.maybeProposeMemory(PROPOSE(RULES, ["should-stay-in-draft"]));
  check("switch-OFF: RULES.md untouched", !/should-stay-in-draft/.test(disk(fileOf("rules"))), JSON.stringify(disk(fileOf("rules"))));
  check("switch-OFF: proposal staged as pending draft", api.getPendingDraft().includes("should-stay-in-draft"), JSON.stringify(api.getPendingDraft()));
  check("switch-OFF: banner visible", doc.getElementById("rules-draft-banner").hidden === false);
  check("switch-OFF: no direct audit for rules", !/should-stay-in-draft/.test(disk(auditOf("rules"))));
}

// ================================================= 4. drawer switch reflects + toggles
console.log("\n=== 4. the s-autorules DOM switch reflects the saved value and its click toggles it ===");
{
  const sw = doc.getElementById("s-autorules");
  check("s-autorules element exists", !!sw);
  api.loadDrawer({ ...api.DEFAULTS });            // default -> switch shows ON
  check("loadDrawer mirrors autoRulesMemory=true", sw.getAttribute("aria-checked") === "true", sw.getAttribute("aria-checked"));
  api.loadDrawer({ ...api.DEFAULTS, autoRulesMemory: false });
  check("loadDrawer mirrors autoRulesMemory=false", sw.getAttribute("aria-checked") === "false");
  sw.setAttribute("aria-checked", "true");
  await api.applyDrawer();
  check("applying the drawer persists autoRulesMemory=true", api.getSettings().autoRulesMemory === true, String(api.getSettings().autoRulesMemory));
  const saved = JSON.parse(win.localStorage.getItem("strata.sampling") || "{}");
  check("autoRulesMemory persisted to localStorage", saved.autoRulesMemory === true, JSON.stringify(saved).slice(0, 120));
  sw.onclick();
  check("clicking the switch turns it off", sw.getAttribute("aria-checked") === "false");
  sw.onclick();
  check("clicking again turns it back on", sw.getAttribute("aria-checked") === "true");
}

// ================================================= 5. the switch is LIVE on CLICK alone (no Apply)
console.log("\n=== 5. the s-autorules switch writes settings + persists on CLICK alone ===");
{
  setup({ [fileOf("rules")]: "" }, "");
  check("baseline DEFAULT settings.autoRulesMemory is true", api.getSettings().autoRulesMemory === true);
  const sw = doc.getElementById("s-autorules");
  api.loadDrawer({ ...api.DEFAULTS });            // reflect default (ON) into the DOM
  sw.onclick();                                  // click to OFF -- must write settings + persist WITHOUT Apply
  check("click alone (no Apply) flips settings.autoRulesMemory to false", api.getSettings().autoRulesMemory === false, String(api.getSettings().autoRulesMemory));
  check("click alone (no Apply) persisted false to localStorage", JSON.parse(win.localStorage.getItem("strata.sampling") || "{}").autoRulesMemory === false);
  sw.onclick();                                  // click back ON
  check("click back (no Apply) flips settings.autoRulesMemory to true", api.getSettings().autoRulesMemory === true, String(api.getSettings().autoRulesMemory));
  await api.maybeProposeMemory(PROPOSE(RULES, ["live-flip-writes"]));   // settings now ON (flipped by click) -> must direct-write, no draft
  check("LOAD-BEARING: after the live click the proposal lands in RULES.md directly (no draft)", /live-flip-writes/.test(disk(fileOf("rules"))), JSON.stringify(disk(fileOf("rules"))));
  check("LOAD-BEARING: the live-click path wrote NO RULES.draft.md", writes(WS + "/RULES.draft.md").length === 0);
}

console.log("\n" + (FAILURES.length ? "AUTORULES-DYNAMIC: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "AUTORULES-DYNAMIC: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
