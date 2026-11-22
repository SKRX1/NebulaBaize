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
const LIST = {};     // exact-path -> a newline-joined listing, served for filesystem/list
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
    if (b.tool === "list") {
      const text = (args.path in LIST) ? LIST[args.path] : "";   // absent dir -> empty listing
      return {ok:true, status:200, json: async () => ({ok:true, text})};
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
  deriveGroup: (base) => deriveGroup(base),
  isFrontendWorkspace: (base) => isFrontendWorkspace(base),
  listGroups: () => listGroups(),
  fillGroupSelect: (sel, cur) => fillGroupSelect(sel, cur),
  openGroupPicker: (path) => openGroupPicker(path),
  closeGroupPicker: () => closeGroupPicker(),
  applyGroupLabel: (label) => applyGroupLabel(label),
  groupPickerBase: () => groupPickerBase,
  get groupPickerTrigger() { return groupPickerTrigger; },
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

// ---------------- 3) Plan C: read-only auto-detection (explicit wins, else frontend by feature) --
console.log("\n=== 3. plan-C deriveGroup: explicit > frontend-feature > none, never writes ===");
const CWS = "ws-c";
// (a) plain workspace, nothing: -> no group, and NO write happened (read-only).
const wBefore = writes.length;
check("a non-frontend workspace derives NO group  ", (await api.deriveGroup(CWS)) === "");
check("detection writes nothing (read-only)", writes.length === wBefore, "wrote " + (writes.length - wBefore));
// (b) a NEW frontend workspace (has serve/web/app.js, no group.txt): -> auto-maps to "frontend".
FILES[CWS + "/serve/web/app.js"] = "// app entry";
check("a brand-new workspace with serve/web/app.js is detected as frontend",
      (await api.isFrontendWorkspace(CWS)) === true);
const wB = writes.length;
check("such a workspace auto-derives the frontend group  " + JSON.stringify(await api.deriveGroup(CWS)),
      (await api.deriveGroup(CWS)) === "frontend");
check("auto-detection still writes nothing to disk", writes.length === wB);
// (c) explicit group.txt OVERRIDES detection: a frontend workspace that explicitly cleared its
//     group (group.txt set to blank) must NOT get the frontend group — the explicit state wins.
FILES[CWS + "/.Nebula-memory/group.txt"] = "__none__\n";   // explicitly cleared via the sentinel
check("an explicitly-cleared group is respected over detection  " + JSON.stringify(await api.deriveGroup(CWS)),
      (await api.deriveGroup(CWS)) === "");
// (d) an explicit group name always wins, even without any feature.
FILES[CWS + "/.Nebula-memory/group.txt"] = "myteam\n";
check("an explicit group name wins  " + JSON.stringify(await api.deriveGroup(CWS)),
      (await api.deriveGroup(CWS)) === "myteam");
// (e) detection is feature-strict: a bare app.js at the root is NOT treated as a front-end layout.
const DWS = "ws-d";
FILES[DWS + "/app.js"] = "// root app, not serve/web";
check("a root-level app.js is NOT enough to be treated as a front-end workspace",
      (await api.isFrontendWorkspace(DWS)) === false);

// ---------------- 4) group picker: listGroups parse + fillGroupSelect render (plan A) ----------
console.log("\n=== 4. group picker: listGroups / fillGroupSelect (existing-groups + current) ===");
const GRPDIR = "E:/Nebula/NebulaBaize/.Nebula-memory/groups";
LIST[GRPDIR] = "frontend\nbeta\n\n";                 // two groups + a trailing blank line
check("listGroups returns the group directories in order",
      JSON.stringify(await api.listGroups()) === JSON.stringify(["frontend","beta"]),
      JSON.stringify(await api.listGroups()));
LIST[GRPDIR] = "real\n__none__\n  \n";              // sentinel + blank must be filtered out
check("listGroups drops the __none__ sentinel and blanks",
      JSON.stringify(await api.listGroups()) === JSON.stringify(["real"]));
delete LIST[GRPDIR];
check("listGroups returns [] when the groups dir is missing", (await api.listGroups()).length === 0);
// fillGroupSelect must render a leading empty "(no group)" option + every group, select current.
LIST[GRPDIR] = "frontend\nbeta\n";
const sel = doc.createElement("select"); sel.id = "mem-auto-groupsel"; doc.body.appendChild(sel);
await api.fillGroupSelect(sel, "beta");
const vals = [...sel.options].map((o) => o.value);
check("fillGroupSelect lists an empty (no-group) option first", vals[0] === "");
check("fillGroupSelect lists every existing group  " + JSON.stringify(vals),
      vals.includes("frontend") && vals.includes("beta"));
check("fillGroupSelect pre-selects the workspace current group", sel.value === "beta", "v=" + sel.value);
// a current group that is NOT on disk (e.g. just-typed) is still shown so it stays selectable.
await api.fillGroupSelect(sel, "zeta");
const vals2 = [...sel.options].map((o) => o.value);
check("fillGroupSelect surfaces a current group absent from disk",
      vals2.includes("zeta") && sel.value === "zeta", JSON.stringify(vals2));

// ---------------- 5) shared group-modal: openGroupPicker / applyGroupLabel / close (plan A) ----
console.log("\n=== 5. shared group-modal: open -> list real groups -> write/exit -> close ===");
const GW = "E:/Nebula/NebulaBaize/ws-menu-target";   // an arbitrary (not-active) workspace base
const GDIR = "E:/Nebula/NebulaBaize/.Nebula-memory/groups";
LIST[GDIR] = "frontend\nbeta\n";                     // real existing groups for the dropdown
FILES[GW + "/serve/web/app.js"] = "// front-end entry";   // GW is a front-end workspace, NO group.txt
// (a) openGroupPicker opens the shared modal, lists the real groups, records the base, and pre-
//     selects the EFFECTIVE group = frontend via Plan-C auto-detect (no group.txt yet).
await api.openGroupPicker(GW);
const modal = doc.getElementById("group-modal");
check("openGroupPicker shows the shared group-modal", !!modal && modal.hidden === false);
check("openGroupPicker records the workspace base it acts on", api.groupPickerBase() === GW, "base=" + api.groupPickerBase());
const gsel = doc.getElementById("group-groupsel");
const gvals = [...gsel.options].map((o) => o.value);
check("the modal dropdown lists the real groups (empty first)  " + JSON.stringify(gvals),
      gvals[0] === "" && gvals.includes("frontend") && gvals.includes("beta"));
check("the modal pre-selects the auto-detected effective group (frontend)  v=" + gsel.value,
      gsel.value === "frontend");
await api.closeGroupPicker();
check("closeGroupPicker hides the modal", doc.getElementById("group-modal").hidden === true);
check("closeGroupPicker clears the base", api.groupPickerBase() === "");
// (b) choose an existing group -> setGroupLabel writes group.txt = that name (single source).
await api.openGroupPicker(GW);
const wB5 = writes.length;
await api.applyGroupLabel("beta");
const gtxt = FILES[GW + "/.Nebula-memory/group.txt"];
check("choosing a group writes group.txt = the name  " + JSON.stringify(gtxt), (gtxt || "").trim() === "beta");
check("exactly one write happened", writes.length - wB5 === 1, "wrote " + (writes.length - wB5));
check("after applying, the modal closes", doc.getElementById("group-modal").hidden === true);
// (c) re-opening now shows the explicit "beta" (explicit wins over auto-detect).
await api.openGroupPicker(GW);
check("re-open pre-selects the explicit group over auto-detect  v=" + gsel.value, gsel.value === "beta",
      "v=" + gsel.value);
// (d) clear -> explicit opt-out writes the __none__ sentinel, not a blank file.
await api.applyGroupLabel("");
check("clearing writes the __none__ sentinel", (FILES[GW + "/.Nebula-memory/group.txt"] || "").trim() === "__none__",
      "got=" + JSON.stringify(FILES[GW + "/.Nebula-memory/group.txt"]));

// ---------------- 6) accessibility: visible close icon, Tab focus trap, return focus on close ----
console.log("\n=== 6. a11y: close-icon resolves, Tab stays inside, focus returns to trigger ===");
const gclose = doc.getElementById("group-close");
check("the modal HAS a close button", !!gclose);
const closeUse = gclose ? gclose.querySelector("use") : null;
const closeHref = closeUse ? (closeUse.getAttribute("href") || closeUse.getAttribute("xlink:href") || "") : "";
check("close button references a real sprite symbol (#i-chevron, not a missing id)  href=" + closeHref,
      closeHref.endsWith("#i-chevron"));
// trigger element (simulates the "..." / memory-page button that opened the modal).
const trigger = doc.createElement("button"); trigger.id = "fake-trigger"; doc.body.appendChild(trigger);
trigger.focus();   // openGroupPicker reads document.activeElement, so focus THIS first as the opener
await api.openGroupPicker(GW);
// focus trap: Tab from the LAST focusable element must wrap to the FIRST (stay inside).
const focusables = [...doc.getElementById("group-modal").querySelectorAll("button, select, input, textarea, [tabindex]")]
  .filter((el) => !el.disabled && !el.closest("[hidden]"));
check("the modal exposes several focusable controls", focusables.length >= 3, "n=" + focusables.length);
focusables[focusables.length - 1].focus();
doc.getElementById("group-groupsel").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
check("Tab at the last control wraps to the first (focus trapped)", doc.activeElement === focusables[0],
      "active=" + (doc.activeElement && doc.activeElement.id));
// reverse: Shift+Tab from the FIRST must wrap to the LAST.
focusables[0].focus();
doc.getElementById("group-close").dispatchEvent(new win.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
check("Shift+Tab at the first control wraps to the last", doc.activeElement === focusables[focusables.length - 1],
      "active=" + (doc.activeElement && doc.activeElement.id));
// opening the modal records the trigger, and closing returns focus to it.
check("opening records the trigger element", api.groupPickerTrigger === trigger);
await api.closeGroupPicker();
check("closing returns focus to the trigger", doc.activeElement === trigger,
      "active=" + (doc.activeElement && doc.activeElement.id));
check("closing clears the trigger reference", api.groupPickerTrigger === null);

// ---------------- 7) display localization of the built-in "frontend" group (the user report) ----
// In Chinese the dropdown must show 前端, but the OPTION VALUE stays "frontend" — the directory
// name, group.txt and Plan-C auto-detect all keep "frontend". A user's own group name is shown
// verbatim. In English the built-in label stays "frontend" (that is the English i18n value).
console.log("\n=== 7. frontend group shows 前端 in zh, value stays frontend ===");
const LG = "E:/Nebula/NebulaBaize/.Nebula-memory/groups";
LIST[LG] = "frontend\nbeta\n";
const gsel7 = doc.createElement("select"); doc.body.appendChild(gsel7);
win.i18n.setLang("zh");
check("we are in Chinese for this check", win.i18n.lang === "zh", "lang=" + win.i18n.lang);
await api.fillGroupSelect(gsel7, "");
const optText7 = [...gsel7.options].map((o) => o.textContent);
const optVal7 = [...gsel7.options].map((o) => o.value);
check("zh: option VALUES still carry the real names (data layer untouched)  " + JSON.stringify(optVal7),
      optVal7.includes("frontend") && optVal7.includes("beta"));
const feIdx = optVal7.indexOf("frontend");
check("zh: the frontend option DISPLAYS 前端 while its value stays frontend  text=" + optText7[feIdx],
      feIdx >= 0 && optText7[feIdx] === "前端" && optVal7[feIdx] === "frontend");
check("zh: a user-created group name is shown verbatim (never translated)  text=" + optText7[optVal7.indexOf("beta")],
      optText7[optVal7.indexOf("beta")] === "beta" && optVal7.includes("beta"));
// English mode: built-in stays "frontend" (that is the English i18n value), value unchanged.
win.i18n.setLang("en");
await api.fillGroupSelect(gsel7, "");
const optText7e = [...gsel7.options].map((o) => o.textContent);
const optVal7e = [...gsel7.options].map((o) => o.value);
check("en: the built-in group stays frontend in both display and value",
      optText7e[optVal7e.indexOf("frontend")] === "frontend" && optVal7e.includes("frontend"));

console.log("");
if (FAILURES.length) { console.log("GROUP-CARD: FAIL (" + FAILURES.length + ")"); process.exit(1); }
console.log("GROUP-CARD: ALL GREEN");
process.exit(0);
