/* Regression test for Tier 1 memory-store auto-compaction (compactMemoryStore).

Boots the REAL index.html + i18n.js + app.js in jsdom, with an in-memory fake workspace
filesystem, and verifies the proactive compaction contract:

  Lossless core   exact-duplicate removal (order-preserving, no info loss), under-budget = no-op.
  RULES safe      rules are NEVER sent to the LLM path (conservative; only lossless dedup).
  LLM opt-in      knowledge/experience use an injected LLM fn only when supplied; fail-safe (throw -> lossless).
  Snapshot undo   restoreCompaction() reverts the whole previous file.
  Trigger wiring  maybeProposeMemory auto-compacts a store once it crosses its soft budget.

Run: node tests/test_memory_compact.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
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
function resetDisk(seed = {}) { DISK.clear(); CALLS = []; for (const [k, v] of Object.entries(seed)) DISK.set(k, v); }
function disk(p) { return DISK.has(p) ? DISK.get(p) : ""; }

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
  DEFAULTS, MEMORY_STORES, MEMORY_ORDER, GLOBAL_ROOT,
  storePath, setSettings: (s) => { settings = Object.assign({}, settings, s); },
  getSettings: () => settings, setSessions: (s) => { sessions = s; }, setActiveId: (id) => { activeId = id; },
  setMcpTools: (n) => { mcpInfo.tools = n; },
  maybeProposeMemory, mergeMemoryInto, compactMemoryStore, restoreCompaction,
  setMemCompactIdleMs,
  setLlmCompactFn, SOFT_BUDGET, getPendingCompactionUndo: () => pendingCompactionUndo,
  setMemCompactMaxWaitMs, setBusy: (v) => { busy = !!v; },
  userIsEngaged, markUserActivity, memCompactIdleMs,
  resetUserActivity: () => { lastUserActivityMs = 0; },
  getWorkspaceKnowledge: () => workspaceKnowledge, getWorkspaceRules: () => workspaceRules,
};`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
api.setMemCompactIdleMs(0);   // shrink the idle window so compaction tests run instantly
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROPOSE = (fence, lines) =>
  ({ role: "assistant", text: "done\n\n```" + fence + "\n" + lines.map((l) => "- " + l).join("\n") + "\n```\n" });
const KNOW = "propose-knowledge", RULES = "propose-rules";
const fileOf = (store) => WS + "/" + api.MEMORY_STORES[store].file;
function setup(storeFiles = {}) {
  resetDisk(storeFiles);
  api.setSessions([{ id: "s1", workspace: WS }]); api.setActiveId("s1"); api.setMcpTools(2);
  api.setSettings({ autoMemory: true, memCompactLLM: false });
}

// ================================================================ 1. lossless dedup + no-op
console.log("\n=== 1. lossless exact-dedup; under-budget is a no-op ===");
{
  setup({ [fileOf("knowledge")]: "a\nb\na\nc\na" });
  const r = await api.compactMemoryStore("knowledge", "workspace", WS, "");
  const f = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("dedup removed exact duplicates", f.length === 3 && f.join("|") === "a|b|c", JSON.stringify(f));
  check("compaction reports changed", r.changed === true);

  setup({ [fileOf("knowledge")]: "a\nb\nc\nd\ne" });   // 5 unique, well under SOFT_BUDGET(150)
  const r2 = await api.compactMemoryStore("knowledge", "workspace", WS, "");
  check("unique + under budget => no-op (changed false)", r2.changed === false);
}

// ================================================================ 2. RULES never uses the LLM path
console.log("\n=== 2. RULES are conservative: LLM fn never called ===");
{
  setup({ [fileOf("rules")]: "r1\nr1\nr2" });
  let called = 0;
  api.setLlmCompactFn(() => { called++; return "should-never-be-used"; });   // spy
  const r = await api.compactMemoryStore("rules", "workspace", WS, "", { llm: () => { called++; return "x"; } });
  check("LLM fn NOT invoked for rules", called === 0, "calls=" + called);
  const f = disk(fileOf("rules")).split("\n").filter(Boolean);
  check("rules still lossless-deduped", f.length === 2 && f.join("|") === "r1|r2", JSON.stringify(f));
  check("rules compaction not flagged as LLM", r.usedLLM === false);
}

// ================================================================ 3. LLM merge (opt-in) + fail-safe
console.log("\n=== 3. knowledge/experience use LLM when supplied; fail-safe on throw ===");
{
  // success path: stub returns a denser, shorter list
  setup({ [fileOf("knowledge")]: Array.from({ length: 160 }, (_, i) => "k" + i).join("\n") });
  api.setLlmCompactFn(null);
  const stub = (text) => "merged-1\nmerged-2\nmerged-3";
  const r = await api.compactMemoryStore("knowledge", "workspace", WS, "", { llm: stub });
  const f = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("LLM merge used (usedLLM true)", r.usedLLM === true);
  check("LLM result written (3 lines)", f.length === 3 && f[0] === "merged-1", JSON.stringify(f));

  // fail-safe: stub throws -> falls back to lossless (no crash, dedup only)
  setup({ [fileOf("knowledge")]: "x\nx\ny\nx" });
  const thrower = () => { throw new Error("boom"); };
  const r2 = await api.compactMemoryStore("knowledge", "workspace", WS, "", { llm: thrower });
  const f2 = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("throw falls back to lossless dedup", f2.length === 2 && f2.join("|") === "x|y", JSON.stringify(f2));
  check("fail-safe not flagged as LLM", r2.usedLLM === false);
}

// ================================================================ 4. snapshot undo restores whole file
console.log("\n=== 4. restoreCompaction reverts the pre-compaction file ===");
{
  const orig = "x\nx\ny\nz";
  setup({ [fileOf("knowledge")]: orig });
  // (a prior test may have left a snapshot queued; the feature is validated by the capture/restore cycle)
  await api.compactMemoryStore("knowledge", "workspace", WS, "");
  check("pending undo captured after compaction", !!api.getPendingCompactionUndo());
  await api.restoreCompaction();
  check("file restored to original content", disk(fileOf("knowledge")).trim() === orig, JSON.stringify(disk(fileOf("knowledge"))));
  check("pending undo cleared after restore", api.getPendingCompactionUndo() === null);
}

// ================================================================ 5. trigger wiring in maybeProposeMemory
console.log("\n=== 5. auto-compact fires once a store crosses its soft budget ===");
{
  // 100 unique + 50 copies of "dup" = 150 lines (101 unique). Add 1 new unique -> 151 lines,
  // crosses SOFT_BUDGET.knowledge(150). Lossless dedup collapses the 50 "dup" copies -> 102 lines.
  const seed = Array.from({ length: 100 }, (_, i) => "u" + i).concat(Array.from({ length: 50 }, () => "dup")).join("\n");
  setup({ [fileOf("knowledge")]: seed });
  api.setSettings({ autoMemory: true, memCompactLLM: false });
  await api.maybeProposeMemory(PROPOSE(KNOW, ["brand-new"]));
  const f = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("post-trigger store slimmed by dedup (102 lines)", f.length === 102, "lines=" + f.length);
  check("new entry present", f.includes("brand-new"));
  check("duplicated entry collapsed to one", f.filter((l) => l === "dup").length === 1);
}

// ================================================================ 6. soft-budget constant sanity
console.log("\n=== 6. SOFT_BUDGET sits strictly below the hard wall ===");
{
  const wall = api.MEMORY_STORES;
  check("rules soft < hard", api.SOFT_BUDGET.rules < wall.rules.maxLines, `${api.SOFT_BUDGET.rules} < ${wall.rules.maxLines}`);
  check("knowledge soft < hard", api.SOFT_BUDGET.knowledge < wall.knowledge.maxLines, `${api.SOFT_BUDGET.knowledge} < ${wall.knowledge.maxLines}`);
  check("experience soft < hard", api.SOFT_BUDGET.experience < wall.experience.maxLines, `${api.SOFT_BUDGET.experience} < ${wall.experience.maxLines}`);
}

// ================================================================ 7. IDLE-GATE: busy defers the LLM merge (load-bearing)
console.log("\n=== 7. idle-gate: a busy session skips the LLM merge but still dedups losslessly ===");
{
  // seed > SOFT_BUDGET.knowledge(150) unique + 30 dup -> crosses the budget so the LLM branch is reached.
  const seed = Array.from({ length: 200 }, (_, i) => "u" + i).concat(Array.from({ length: 30 }, () => "dup")).join("\n");

  // busy path: hold the session busy and cap the wait short, so waitIdleForLlmCompact() times out -> idle=false.
  setup({ [fileOf("knowledge")]: seed });
  let llmCalls = 0;
  api.setMemCompactMaxWaitMs(1000); api.setBusy(true);
  const rb = await api.compactMemoryStore("knowledge", "workspace", WS, "", { llm: () => { llmCalls++; return "merged"; } });
  api.setBusy(false); api.setMemCompactMaxWaitMs(60000);
  const fb = disk(fileOf("knowledge")).split("\n").filter(Boolean);
  check("busy => LLM merge NOT invoked", llmCalls === 0, "calls=" + llmCalls);
  check("busy => still lossless-deduped (201 unique: 200 + dup)", fb.length === 201, "lines=" + fb.length);
  check("busy => not flagged as LLM", rb.usedLLM === false);

  // idle path (control): same seed, session idle -> the LLM merge DOES fire and collapses to the stub result.
  setup({ [fileOf("knowledge")]: seed });
  let llmCalls2 = 0;
  const rc = await api.compactMemoryStore("knowledge", "workspace", WS, "", { llm: () => { llmCalls2++; return "m1\nm2"; } });
  check("idle => LLM merge invoked (control)", llmCalls2 === 1, "calls=" + llmCalls2);
  check("idle => flagged as LLM (control)", rc.usedLLM === true);
}

// ================================================================ 8. USER-ENGAGED gate + settings-driven idle window
console.log("\n=== 8. the merge is held while the user is engaged; idle window reads settings.memCompactIdleSec ===");
{
  const input = win.document.getElementById("input");
  check("#input composer exists in the page", !!input);

  // (1) engaged: composer focused WITH a draft -> must be treated as busy.
  input.textContent = "正在打字的新任务";
  try { input.focus(); } catch (e) {}
  check("focused composer with a draft => engaged", api.userIsEngaged() === true);

  // (2) NOT engaged: focused but the draft is cleared (and no recent keystroke).
  input.textContent = "";
  check("focused composer, empty draft => NOT engaged", api.userIsEngaged() === false);

  // (3) engaged via recency: a fresh markUserActivity() makes the last-3s branch fire.
  api.markUserActivity();
  check("markUserActivity() just now => engaged", api.userIsEngaged() === true);

  // (4) settings path: with no test override, the idle window tracks settings.memCompactIdleSec.
  api.setMemCompactIdleMs(-1);                 // clears the override (setter nulls it for <0)
  api.setSettings({ memCompactIdleSec: 30 });
  check("settings.memCompactIdleSec=30 => 30000ms window", api.memCompactIdleMs() === 30000, "got " + api.memCompactIdleMs());
  api.setSettings({ memCompactIdleSec: 0 });
  check("settings.memCompactIdleSec=0 => 0ms window (no wait)", api.memCompactIdleMs() === 0, "got " + api.memCompactIdleMs());
  api.setMemCompactIdleMs(0);                  // restore the fast override for any later section
}

// ================================================================ 8.5 GLOBAL mouse/keyboard/scroll listeners
console.log("\n=== 8.5 moving the mouse / clicking / scrolling / typing ANYWHERE re-arms the idle gate ===");
{
  // Baseline: expire the activity stamp and make sure the composer is not focused with a draft,
  // so "not engaged" here genuinely means "idle", and a later flip to engaged can ONLY come from
  // the global listeners -- deleting the window.addEventListener forEach would keep it false.
  api.resetUserActivity();
  try { win.document.activeElement && win.document.activeElement.blur(); } catch (e) {}
  const inp = win.document.getElementById("input"); if (inp) inp.textContent = "";
  check("baseline: stamped-out + unfocused + empty => NOT engaged", api.userIsEngaged() === false);

  // Each global input class must, on its own, re-arm engagement via the capture-phase wiring.
  const fires = ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "scroll"];
  for (const name of fires) {
    api.resetUserActivity();
    win.dispatchEvent(new win.Event(name, { bubbles: true, cancelable: true }));
    check("global '" + name + "' event => engaged (wiring is live)", api.userIsEngaged() === true);
  }
  api.resetUserActivity();   // leave a clean slate for anything below
}

// ------------------------------------------------------------------ result
console.log("\n" + (FAILURES.length ? "MEM-COMPACT: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "MEM-COMPACT: ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
