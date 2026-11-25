/* Contract test: chunk-aware semantic merge in realLlmCompact.
 *
 * A memory store far larger than the context window (experience was ~250% of
 * 16384) can never be merged in one LLM call -- it overflows and fails. The fix
 * splits the store into token-budgeted chunks and merges each with its own call,
 * keeping a chunk verbatim when its call fails (lossless degrade).
 *
 * Boots the REAL app.js in jsdom, exposes realLlmCompact, and mocks chat/completions
 * to count calls + return a deterministic merge. Pure ASCII assertions.
 *
 * Run: node tests/test_mem_chunk_compact.mjs
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
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

// LLM chat mock: record each call's user content; return a deterministic merge.
let LLM = [];
let failOnCall = () => false;   // predicate (index) -> throw
win.fetch = async (url, o) => {
  const u = String(url);
  if (u === "mcp/call") {
    const b = o && o.body ? JSON.parse(o.body) : {};
    if (b.server === "filesystem" && b.tool === "read") return { ok: true, status: 200, json: async () => ({ ok: true, text: "" }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, text: "ok" }) };
  }
  if (u.includes("chat/completions")) {
    const idx = LLM.length;
    const body = o && o.body ? JSON.parse(o.body) : {};
    const userMsg = (body.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("");
    LLM.push(userMsg);
    if (failOnCall(idx)) throw new Error("simulated LLM overflow");
    // Return one "merged" line per input line, prefixed MERGED- so we can trace.
    const lines = userMsg.split("\n").map((l) => l.trim()).filter(Boolean);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: lines.map((l) => "MERGED[" + l + "]").join("\n") } }] }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

let appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { realLlmCompact, memCompactChunkTokens, setSessions: (s)=>{sessions=s;}, setActiveId:(id)=>{activeId=id;}, setModel:(m)=>{activeSession=()=>({model:m});}, setSettings:(s)=>{settings=Object.assign({},settings,s);}, getSettings:()=>settings };";
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const api = win.__api;
api.setSessions([{ id: "s1", workspace: "/tmp/ws", model: "test-model" }]);
api.setActiveId("s1");
api.setModel("test-model");
api.setSettings({ memCompactChunkTokens: 7000 });   // pin: manual override == the old hardcoded budget (deterministic)

// A "big" line ~2000 CJK tokens (one CJK char ~= 1 token in _memEstTokens).
const big = (tag) => tag + "\u8bb0".repeat(2000);

console.log("\n=== 0. chunk budget is configurable (manual override wins, 0 = auto) ===");
{
  api.setSettings({ memCompactChunkTokens: 5000 });
  check("manual override returns the configured value", api.memCompactChunkTokens() === 5000, String(api.memCompactChunkTokens()));
  api.setSettings({ memCompactChunkTokens: 0 });
  check("auto (0) uses the shared budget formula", api.memCompactChunkTokens() >= 2000 && api.memCompactChunkTokens() <= 12000, String(api.memCompactChunkTokens()));
  api.setSettings({ memCompactChunkTokens: 7000 });   // restore for the split tests
}

console.log("\n=== 1. small store (fits one chunk) -> exactly ONE LLM call ===");
{
  LLM = [];
  const out = await api.realLlmCompact(big("a"), "experience");
  check("one call for a single-chunk store", LLM.length === 1, String(LLM.length));
  check("merge result returned", /MERGED\[a/.test(out || ""), String(out).slice(0, 20));
}

console.log("\n=== 2. oversized store -> split into multiple chunks, one call EACH ===");
{
  LLM = [];
  // 4 lines x ~2000 tokens = ~8000 tokens > 7000 budget -> must split (>=2 calls).
  const inp = [big("a"), big("b"), big("c"), big("d")].join("\n");
  const out = await api.realLlmCompact(inp, "experience");
  check("multiple calls for an oversized store", LLM.length >= 2, String(LLM.length));
  check("all four lines merged across chunks",
        /MERGED\[a/.test(out) && /MERGED\[b/.test(out) && /MERGED\[c/.test(out) && /MERGED\[d/.test(out),
        "calls=" + LLM.length);
  check("no chunk carried the whole file (split happened)",
        LLM.every((c) => c.length < inp.length), "max-chunk=" + Math.max(...LLM.map((c) => c.length)));
}

console.log("\n=== 3. lossless degrade: a failing chunk is kept verbatim, others merge ===");
{
  LLM = [];
  failOnCall = (idx) => idx >= 1;   // 2nd chunk throws on every fetchWithRetry attempt
  const inp = [big("a"), big("b"), big("c"), big("d")].join("\n");
  const out = await api.realLlmCompact(inp, "experience");
  failOnCall = () => false;
  const lines = (out || "").split("\n").filter(Boolean);
  // Merged chunks carry MERGED[]; the failed chunk carries raw lines (no MERGED[]).
  const rawKept = lines.filter((l) => !/MERGED\[/.test(l));
  check("failing chunk kept verbatim (raw lines present)", rawKept.length >= 1, "raw=" + rawKept.length);
  check("surviving chunks still merged", /MERGED\[/.test(out), "calls=" + LLM.length);
  check("no lines lost (every tag present)",
        /a/.test(out) && /b/.test(out) && /c/.test(out) && /d/.test(out));
}

console.log("\n" + (FAILURES.length ? "MEM-CHUNK-COMPACT: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "MEM-CHUNK-COMPACT: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
