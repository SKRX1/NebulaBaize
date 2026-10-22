/* Regression test for the proposal decision-card system (流式建议决策卡).

Boots the REAL index.html + i18n.js + app.js in jsdom with an in-memory fake
filesystem, and verifies the contract:

  Extraction        a ```proposal <json>``` fence is parsed, rendered as a card,
                   and STRIPPED from m.text (so it never reaches the engine -> zero bloat).
  Malformed         an unparsable / title-less fence is left in m.text (safe fallback).
  Out-of-context    the stripped m.text contains no proposal content (what apiMessages forwards).
  Markdown          proposalMarkdown renders a non-empty doc with title + options.
  Render            renderProposals paints a .proposal card into .proposals and hides when empty.
  Save             saveProposalToFile writes .strata-memory/proposal-<id>.md via the fs mcp.

Run: node tests/test_proposal_card.mjs
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

const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;window.__api = {
  extractProposalsFromText, renderProposals, proposalMarkdown, saveProposalToFile,
  setWorkspace: (w) => { if (activeSession()) activeSession().workspace = w; else { sessions = [{id:"x",workspace:w}]; activeId="x"; } },
  getActiveSession: () => activeSession(),
};`;
win.eval(injected);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

const api = win.__api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tests --------------------------------------------------------------
console.log("PROPOSAL CARD:");

// T1: a complete fence is parsed + stripped from m.text
{
  const obj = { id: "p1", title: "Factor 0.85→0.75", verified: true, summary: "peak 83%→73%",
    options: [{ label: "A. do", verdict: "推荐", pros: ["low risk"], cons: ["needs test"] }],
    evidence: "read app.js:2155", next: "run regression" };
  const fence = "```proposal\n" + JSON.stringify(obj) + "\n```";
  const m = { role: "assistant", text: "做完了。\n\n" + fence + "\n", proposals: [] };
  api.extractProposalsFromText(m);
  check("fence stripped from m.text", !m.text.includes("proposal") && !m.text.includes("Factor"));
  check("parsed into m.proposals", m.proposals && m.proposals.length === 1 && m.proposals[0].title === "Factor 0.85→0.75");
  check("verified flag preserved", m.proposals[0].verified === true);
  check("out-of-context: prose kept, fence gone", m.text.trim() === "做完了。");
}

// T2: malformed fence (bad JSON) stays in text
{
  const m = { role: "assistant", text: "```proposal\n{ not json \n```", proposals: [] };
  api.extractProposalsFromText(m);
  check("malformed fence kept in text", m.text.includes("proposal") && (!m.proposals || m.proposals.length === 0));
}

// T3: title-less object is ignored (safe fallback)
{
  const m = { role: "assistant", text: "```proposal\n" + JSON.stringify({ summary: "x" }) + "\n```", proposals: [] };
  api.extractProposalsFromText(m);
  check("title-less ignored", (!m.proposals || m.proposals.length === 0) && m.text.includes("proposal"));
}

// T4: proposalMarkdown renders a doc
{
  const obj = { id: "p2", title: "T", verified: false,
    options: [{ label: "A", verdict: "推荐", pros: ["p1"], cons: ["c1"] }], evidence: "e", next: "n" };
  const md = api.proposalMarkdown(obj);
  check("markdown non-empty", typeof md === "string" && md.length > 10);
  check("markdown has title", md.includes("T"));
  check("markdown has options table", md.includes("好处") && md.includes("坏处"));
}

// T5: renderProposals paints a card into .proposals, hides when empty
{
  const host = doc.createElement("div");
  host.innerHTML = `<div class="proposals" hidden></div>`;
  const mEmpty = { proposals: [] };
  api.renderProposals(host, mEmpty);
  check("empty -> hidden", host.querySelector(".proposals").hidden === true);
  const m = { proposals: [{ id: "p3", title: "Card", verified: false, options: [] }] };
  api.renderProposals(host, m);
  check("card rendered", !!host.querySelector(".proposal"));
  check("unverified badge", /unverified/.test(host.querySelector(".proposal").innerHTML));
  check("not hidden when has cards", host.querySelector(".proposals").hidden === false);
}

// T6: saveProposalToFile writes .strata-memory/proposal-<id>.md
{
  resetDisk();
  api.setWorkspace(WS);
  const m = { proposals: [{ id: "p4", title: "Save me", verified: true,
    options: [{ label: "A", verdict: "推荐", pros: ["p"], cons: ["c"] }] }] };
  const p = m.proposals[0];
  await api.saveProposalToFile(m, p);
  const target = `${WS}/.strata-memory/proposal-p4.md`;
  const written = writes(target);
  check("file written to .strata-memory", written.length === 1);
  check("file content has title", written[0] && written[0].includes("Save me"));
  check("p.savedFile recorded", p.savedFile === target);
}

// ---------- summary ------------------------------------------------------------
console.log("");
if (FAILURES.length) {
  console.log("PROPOSAL CARD: " + FAILURES.length + " FAILED");
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
} else {
  console.log("PROPOSAL CARD: ALL PASSED");
  process.exit(0);   // jsdom keeps the app's polling timers alive; end the run explicitly
}
