/* Contract gate: the cross-workspace (group) spec card.
 *
 * Why this exists
 * ---------------
 * renderGroupCard() is new production behaviour (commit 59ad05c): it shows a
 * ".mem-tabpanel[data-mem=group]" card ONLY when the workspace has a group, and
 * its Save writes to that group's RULES.md at the exact path
 * `${groupDir(currentGroup)}/RULES.md`. If the path template or the
 * "only when currentGroup" guard is ever broken, edits would silently land on the
 * wrong scope (or vanish) with no UI signal. This gate locks BOTH layers:
 *   1) static — the definition, its two call-sites in renderMemory()/the new-entry
 *      refresh, the [data-group-edit] delegation, the index.html card
 *      (data-mem=group + mem-group-body + data-group-edit) and the two i18n
 *      key families must all be present and paired. (i18n parity itself is
 *      enforced by tests/test_i18n.mjs; here we only lock the keys are referenced.)
 *   2) runtime differential (real boot + mocked fs) — through the REAL
 *      renderGroupCard + REAL fsWrite (which serialises into fetch("mcp/call",
 *      tool:"write")):
 *        - with NO group:  card stays hidden, nothing renders;
 *        - WITH a group:   card becomes visible and shows the rules; clicking the
 *          edit button then Save posts a filesystem/write whose `path` is exactly
 *          the group's RULES.md — this is the load-bearing proof the path template
 *          resolves to groupDir, not to the workspace/global file;
 *        - read-back:      after the write, a second render reads the SAME bytes
 *          back into #mem-group-body (the "cross-tab consistency" the user asked
 *          to confirm, modelled deterministically here).
 *
 * Run standalone: node tests/test_group_card_jsdom.mjs
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

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");

// ---------------- 1) static locks: definition + call-sites + wiring ----------------------
console.log("\n=== 1. static: renderGroupCard defined + wired + DOM card + i18n refs ===");
check("app.js defines renderGroupCard()", src.includes("async function renderGroupCard("));
check("renderMemory() calls renderGroupCard()", src.includes("renderGlobalCard(); renderGroupCard(); }"));
check("new-entry refresh path re-renders the group card", src.includes("renderAutoMemoryCard(); renderGlobalCard(); renderGroupCard();"));
check("the Save writes via setRulesVar(\"group\", …)", src.includes('setRulesVar("group", ta.value)'));
check("the write path is the group RULES.md template", src.includes("${groupDir(currentGroup)}/RULES.md"));
check("[data-group-edit] delegation is wired once", src.includes("__memGroupEditWired"));
// index.html: the card + its edit button must exist (these are the contract the user edits).
check("index.html has the data-mem=group card", html.includes('data-mem="group"'));
check("index.html has #mem-group-body", html.includes('id="mem-group-body"'));
check("index.html has [data-group-edit] button", html.includes("data-group-edit"));
check("index.html card is hidden by default until a group exists",
      html.includes('data-mem="group" hidden'));
// i18n keys referenced by the card must be defined (parity is enforced by test_i18n.mjs).
for (const k of ["mem.group.title", "mem.group.none", "mem.group.note"]) {
  check(`i18n.js defines ${k}`, i18nSrc.includes(`"${k}"`));
}
// A decoy guard: the card must NOT silently be a global card copy (path must be groupDir).
check("negative: group save is NOT wired to the global PROJECT_MEMORY path",
      !/mem-group-save[\s\S]{0,200}fsWrite\(PROJECT_MEMORY/.test(src));

// ---------------- 2) runtime: real boot + mocked filesystem (differential) ---------------
console.log("\n=== 2. runtime: renderGroupCard visibility + write-path + read-back ===");

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){return false;}});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "en");

// A suffix-matched in-memory filesystem: app.js derives groupDir() from GLOBAL_ROOT, whose
// absolute value we must not hard-code. A read whose path ENDS WITH a seeded suffix gets that
// content; everything else reads "" (file absent). Writes key by the exact resolved path so the
// read-back re-render genuinely re-reads what the real fsWrite posted.
const SEED = { "/.Nebula-memory/groups/frontend/RULES.md": "frontend rules v1\n" };
const FILES = {};   // exact-path store; populated by writes (read-back must reflect them first)
const reads = [];   // every filesystem/read path (for diagnostics)
const findBySuffix = (p) => { for (const suf of Object.keys(SEED)) if (p.endsWith(suf)) return SEED[suf]; return null; };
const writes = [];   // every filesystem/write {path, content}
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("models/config")) return {ok:true, status:200, json: async () => ({selected:"self", models:[]})};
  if (u.endsWith("health")) return {ok:true, status:200, json: async () => ({model:"m", max_context: 8192})};
  if (u.includes("metrics")) return {ok:true, status:200, json: async () => ({engine:{max_context: 8192}})};
  if (u.includes("mcp/call")) {
    let b = {}; try { b = JSON.parse(opts.body || "{}"); } catch (e) {}
    const args = b.args || {};
    if (b.tool === "read") {
      reads.push(args.path);
      let content = (args.path in FILES) ? FILES[args.path] : null;
      if (content == null) { const s = findBySuffix(String(args.path)); content = s == null ? "" : s; }
      return {ok:true, status:200, json: async () => ({ok:true, text: content})};
    }
    if (b.tool === "write") {
      writes.push({path: args.path, content: args.content});
      FILES[args.path] = args.content;
      return {ok:true, status:200, json: async () => ({ok:true})};
    }
  }
  return {ok:true, status:200, json: async () => ({})};
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let code = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
code += `
;window.__api = {
  renderGroupCard: () => renderGroupCard(),
  setCurrentGroup: (g) => { currentGroup = g; },
  groupDir: (g) => groupDir(g),
  editGroupCard: async () => { const pre = document.getElementById("mem-group-body"); if (pre){ pre.dataset.editing = "1"; await renderGroupCard(); } },
  groupRulesVar: () => groupRules,
};`;
win.eval(code);
const api = win.__api;
const $ = (id) => doc.getElementById(id);

// T-A: no group -> the card must stay hidden and never reveal rules.
api.setCurrentGroup("");
await api.renderGroupCard();
const card = doc.querySelector('.mem-tabpanel[data-mem="group"]');
check("with NO group the card is hidden", !!card && card.hidden === true);

// T-B: a group is set -> card visible and shows the rules text.
api.setCurrentGroup("frontend");
await api.renderGroupCard();
check("with a group the card becomes visible", card.hidden === false);
const body = $("mem-group-body");
check("the body shows the group's rules", body && body.textContent.includes("frontend rules v1"));

// T-C: edit + save -> the real fsWrite must post exactly the group's RULES.md path.
await api.editGroupCard();
const ta = body.querySelector("textarea");
check("the edit button swapped in an editable textarea", !!ta);
ta.value = "frontend rules v2 (edited)";
const saveBtn = $("mem-group-save");
check("a Save button is present", !!saveBtn);
const before = writes.length;
saveBtn.click();
await new Promise((r) => setTimeout(r, 0));   // let the async handler flush
const mine = writes.slice(before);
check("exactly one write happened on save", mine.length === 1, "got " + mine.length);
const expectedPath = api.groupDir("frontend") + "/RULES.md";
check("the write path is the group RULES.md (not workspace/global)  " + JSON.stringify(mine[0] && mine[0].path),
      mine.length === 1 && mine[0].path === expectedPath);
check("the write carried the edited text", mine.length === 1 && mine[0].content === "frontend rules v2 (edited)");
check("the in-memory groupRules model was kept in sync via setRulesVar",
      api.groupRulesVar() === "frontend rules v2 (edited)");

// T-D: read-back — a DIFFERENT tab would render this card with no editing flag set (a
// fresh page load), so it takes the read branch and shows the file body. We clear the
// editing flag to model that second tab, then re-render: it must read back the exact bytes
// the real fsWrite posted (the cross-tab consistency the user wants to eyeball).
delete $("mem-group-body").dataset.editing;
await api.renderGroupCard();
check("a fresh-tab render reads the saved bytes back into the body",
      $("mem-group-body").textContent.includes("frontend rules v2 (edited)"));

console.log("");
if (FAILURES.length) { console.log("GROUP-CARD: FAIL (" + FAILURES.length + ")"); process.exit(1); }
console.log("GROUP-CARD: ALL GREEN");
process.exit(0);
