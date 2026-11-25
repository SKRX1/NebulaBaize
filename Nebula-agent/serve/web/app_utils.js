// serve/web/app_utils.js - shared pure formatting helpers for app.js.
// Loaded BEFORE app.js (see index.html). Classic script: top-level function
// declarations land on the global scope, so app.js's call sites stay unchanged.
// Each function here touches only standard globals (Date/Number/String/RegExp)
// and no app.js state -- they are extracted as pure, dependency-free leaves.
"use strict";

// epoch ms / numeric time -> "HH:MM" (24h, zero-padded) for chat message meta lines.
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

// bytes -> "x.y KB" / "x.y MB" (binary units, 1 decimal).
function fmtBytesSel(n) { return n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }

// markdown plan text -> [{done, label}] (a "- [x] do"/"* [ ] todo" checklist parser).
function parsePlanItems(raw) {
  return String(raw || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => {
    const done = /^[-*]\s*\[[xX]\]/i.test(s);
    const label = s.replace(/^[-*]\s*\[[ xX]\]\s*/, "").trim();
    return {done, label};
  }).filter((it) => it.label);
}


// ---- next-steps / proposal fence extractors + language detect (pure text tools) ----

function extractNextSteps(text) {
  const m = (text || "").match(/```next-steps\s*\n([\s\S]*?)```/i);
  if (!m) return {text: text || "", steps: []};
  const steps = [];
  for (const raw of m[1].split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let recommended = false, avoid = false, hold = false;
    let body = trimmed.replace(/^\?\s*/, () => { hold = true; return ""; }).trim();   // "?" = 列给您看但 AI 等您答，不自动跑
    body = body.replace(/^[\*\u2022]+\s*/, () => { recommended = true; return ""; }).trim();
    body = body.replace(/^[!✗×x]+\s*/i, () => { avoid = true; return ""; }).trim();   // "!" = AI does NOT advise (risky / net-negative)
    body = body.replace(/^[\+\-–]+/, "").trim();     // remaining bullet chars (not the recommend marker)
    if (!body) continue;
    const i = body.indexOf("："), j = body.indexOf(":");
    const sep = i > 0 && (j < 0 || i < j) ? i : (j > 0 ? j : -1);
    steps.push(sep > 0
      ? {label: body.slice(0, sep).trim(), detail: body.slice(sep + 1).trim(), recommended, avoid, hold}
      : {label: body, detail: "", recommended, avoid, hold});
  }
  return {text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), steps};
}

function extractProposalsFromText(m) {
  if (!m || !m.text) return;
  // Only complete fences (with a closing ```) match; a fence still streaming in is left in m.text until done.
  const RE = /```proposal\s*\n([\s\S]*?)\n```/g;
  let mt, hits = [];
  while ((mt = RE.exec(m.text)) !== null) hits.push(mt[1]);
  if (!hits.length) return;
  if (!m.proposals) m.proposals = [];
  let changed = false;
  for (const body of hits) {
    let obj = null;
    try { obj = JSON.parse(body); } catch (e) { obj = null; }
    if (!obj || !obj.title) continue;              // malformed: keep the raw fence as text (safe fallback)
    const id = obj.id || ("prop_" + String(body).length.toString(36) + "_" + (m.proposals.length));
    if (m.proposals.some((p) => p.id === id)) continue;
    obj.id = id;
    if (obj.verified == null) obj.verified = false;
    obj.dismissed = false;
    m.proposals.push(obj);
    changed = true;
  }
  if (changed) {
    // Remove every proposal fence (plus one trailing newline) and collapse runs of blank lines.
    m.text = m.text.replace(/```proposal\s*\n[\s\S]*?\n```\s*\n?/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }
}

function detectLang(text) {
  const s = text || "";
  if (!s.trim()) return "en";
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > s.replace(/\s/g, "").length * 0.15 ? "zh" : "en";
}


// ---- path / scope / deep-clone pure helpers (extracted from app.js) ----

function firstPath(args) {
  if (!args || typeof args !== "object") return "";
  for (const k of ["path", "file_path", "target", "destination", "file", "source"])
    if (typeof args[k] === "string" && args[k]) return args[k];
  for (const v of Object.values(args)) if (typeof v === "string" && /[\\/]/.test(v)) return v;
  return "";
}

// The 3-tier promotion chain: workspace -> group (if a group is set) -> global. Demotion reverses it.
function nextScopeUp(scope, group) {
  if (scope === "workspace") return group ? "group" : "global";
  if (scope === "group") return "global";
  return "global";
}
function nextScopeDown(scope, group) {
  if (scope === "global") return group ? "group" : "workspace";
  if (scope === "group") return "workspace";
  return "workspace";
}

function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return Array.isArray(o) ? o.slice() : o; } }

// ---- tool-result classifier (extracted from app.js): pure, depends only on firstPath above ----
const TEST_RE = /\b(pytest|unittest|nose|jest|mocha|tox|go test|npm test|node --test|cargo test|mvn test|gradle test|test_[a-z0-9_]+\.|\.test\.|__tests?__)\b/i;
const FILE_TOOL_BASE = new Set(["write", "write_file", "create", "create_file", "write_text_file", "move",
  "rename", "edit", "edit_file", "append", "append_file", "save", "put_file", "create_directory", "mkdir"]);
function classifyTool(t) {
  if (!t) return null;
  const srv = String(t.server || "").toLowerCase(), tool = String(t.tool || t.name || "").toLowerCase();
  const base = tool.split("__").pop();
  if (srv.includes("file") && FILE_TOOL_BASE.has(base)) {
    const p = firstPath(t.arguments);
    return p ? {kind: "file", path: p, ok: t.ok !== false} : null;
  }
  if (srv.includes("shell") || base.includes("shell") || srv.includes("terminal")) {
    const cmd = typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments || "");
    if (TEST_RE.test(cmd)) {
      const res = String(t.result || "");
      const fp = res.match(/(\d+)\s*passed/i);
      const fr = res.match(/(\d+)\s*failed/i) || res.match(/failures=(\d+)/i) || res.match(/errors=(\d+)/i);
      const tot = res.match(/Ran\s+(\d+)\s*tests?/i);
      const passed = fp ? +fp[1] : (tot ? +tot[1] : null);
      const failed = fr ? +fr[1] : 0;
      const ok = t.ok !== false && failed === 0 && !/FAILED|Traceback|Error:/i.test(res.slice(0, 500));
      return {kind: "test", cmd: cmd.replace(/\s+/g, " ").slice(0, 48), passed, failed, ok};
    }
  }
  return null;
}


// ---- bug-box pure aggregation trio (extracted from app.js): signature key, status counts, fold-by-signature groups. Pure over the passed array, no app.js state. ----
function bugBoxSigKey(e) {          // signature = same key the capture uses for merge
  return (e && e.sig != null) ? e.sig : (e && e.msg != null ? e.msg : '');
}
function bugBoxStats(all) {         // counts over the FULL box (status field already on every record)
  const s = { total: all.length, open: 0, fixing: 0, verified: 0 };
  for (const e of all) {
    const st = (!e.status || e.status === 'open') ? 'open' : e.status;   // pre-status legacy rows count as open
    if (st in s) s[st] += 1;
  }
  return s;
}
function bugBoxGroups(entriesDesc) { // fold same-signature rows into one representative + count
  const order = []; const bySig = new Map();
  for (const e of entriesDesc) {
    const sig = bugBoxSigKey(e);
    let g = bySig.get(sig);
    if (!g) { g = { rep: e, count: 1, tsList: [e.ts] }; bySig.set(sig, g); order.push(g); }
    else {
      g.count += 1; g.tsList.push(e.ts);
      if (e.ts > g.rep.ts) g.rep = e;            // representative = newest occurrence
    }
  }
  return order;
}


// ---- think-text pure transforms (extracted from app.js): thinkPeek = collapsed one-liner summary (skips fenced code); dedupeThink = fold >=3 identical consecutive lines to one. Pure string -> string, no DOM / no app.js state. ----
function thinkPeek(src) {                                // collapsed one-liner: the first sentence, at most ~90 chars
  // Skip fenced code when picking the one-liner: a thought that opens with a ```js dump would otherwise
  // summarise itself as "const opt = (oi != null …", which tells the reader nothing.
  let inFence = false, first = "";
  for (const line of String(src || "").split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.trim()) { first = line; break; }
  }
  const s = (first || String(src || "")).replace(/\s+/g, " ").trim();
  const head = s.slice(0, 90);
  const m = head.match(/^[\s\S]*?[。！？!?；;\n]/);
  return ((m ? m[0] : head).trim() || head).trim();
}
function dedupeThink(src) {
  const MIN_RUN = 3;
  const lines = String(src || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i];
    if (t.trim() === "") { out.push(t); i++; continue; }          // blank lines pass through untouched
    let j = i;
    while (j < lines.length && lines[j] === t) j++;                // exact-identical run only
    if (j - i >= MIN_RUN) out.push(t);                             // fold the whole run to one line
    else { for (let k = i; k < j; k++) out.push(lines[k]); }        // <3 identical: keep verbatim
    i = j;
  }
  return out.join("\n");
}


// ---- stateless micro-utils (extracted from app.js): configValue = coerce a config <input> value by kind; safeCut = back up a streaming cut point to a line/blank-line/unclosed-fence edge; taskOrder = pinned-first then updatedAt-desc comparator; pickSeed = crypto-backed 1..2^31 seed. All pure/leaf: args-only or stdlib (crypto/Math), no app.js module globals, no DOM side effects. ----
function taskOrder(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;   // pinned tasks float to the top of their group
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
function safeCut(text, minStart) {
  let cut = minStart;
  while (cut > 0 && text[cut - 1] !== "\n") cut--;                 // back to a line start
  if (cut > 0) {                                                  // back to a blank-line edge if mid-block
    const prev = text.lastIndexOf("\n\n", cut - 1);
    if (prev >= 0) cut = prev + 2; else cut = 0;
  }
  const pref = text.slice(0, cut);
  if ((pref.match(/```/g) || []).length % 2 === 1) {              // odd -> an open fence; cut before its opener
    const open = pref.lastIndexOf("```");
    cut = open >= 0 ? open : 0;
  }
  return Math.max(0, cut);
}
function pickSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return 1 + (a[0] % 2147483646);
  } catch (e) {
    return 1 + Math.floor(Math.random() * 2147483646);
  }
}
