/* Contract test: the Schedule TAB + edit modal must really work (tab-browse architecture).
 *
 * Why this exists
 * ---------------
 * Architecture decision (2026-11): the Schedule list lives on a top TAB (permanent browse view,
 * like memory/monitor/tools), and the modal is used ONLY for the create/edit form. This matches
 * the app's own design language (big permanent-browse modules = top tab/role=tabpanel; one-shot
 * transactions = st-modal/role=dialog). The list-render path must not regress into "declared but
 * never runs" — the original sidebar-empty bug was exactly a render that silently bailed.
 *
 * Locks:
 *   1) the top tab is wired: tab button data-tab=schedule + a view-schedule panel + showTab's
 *      hardcoded view list contains schedule + a per-tab renderSchedule() call;
 *   2) the tab main list (#sched-view-list) is filled by renderSchedule (named so the language-
 *      switch hook typeof renderSchedule repaints it), with edit + delete buttons;
 *   3) the modal is FORM-ONLY (no embedded list inside it now);
 *   4) openSchedModal loads an entry into the form (edit) or blanks it (create);
 *   5) the loadSchedule startup-race fix (retry, not bare silent return) survives.
 *
 * jsdom note: top-level `let`/`const` in the boot eval are NOT on window and NOT reachable from a
 * later separate win.eval(). So every realm-state touch goes through closures captured in the SAME
 * boot eval (window.__api). This is the exact "defined-but-unreachable" trap this file polices.
 *
 * Run standalone: node tests/test_schedule_contract.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label);
  if (!cond) FAILURES.push(label);
};

const src = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

// --- 1) top-tab wiring ------------------------------------------------------------
check("index.html has a schedule top-tab button (data-tab=schedule)",
  /data-tab="schedule"/.test(html));
check("index.html has a view-schedule tabpanel",
  /id="view-schedule"[^>]*role="tabpanel"/.test(html) || /role="tabpanel"[^>]*id="view-schedule"/.test(html));
check("showTab's hardcoded view list contains schedule",
  /\[\s*"chat"[\s\S]*"schedule"\s*\]/.test(src));
check("showTab calls renderSchedule on the schedule tab",
  /tab === "schedule"[\s\S]*?renderSchedule\(\)/.test(src));

// --- 2) tab main list filled by renderSchedule, with edit + delete ------------------
check("app.js DEFINES function renderSchedule", /function\s+renderSchedule\s*\(/.test(src));
check("app.js CALLS renderSchedule(", /[^\w]renderSchedule\(/.test(src));
check("renderSchedule targets #sched-view-list", /\$\(\s*"sched-view-list"\s*\)/.test(src));
check("renderSchedule emits a data-sched-edit hook", /data-sched-edit=/.test(src));
check("renderSchedule emits a data-sched-del hook", /data-sched-del=/.test(src));

// --- 3) the modal is FORM-ONLY: no embedded list inside #sched-modal ---------------
const modalBlock = html.slice(html.indexOf('id="sched-modal"'), html.indexOf("Approval modal"));
check("modal #sched-modal no longer embeds a list (form-only)", !/id="sched-list"/.test(modalBlock));
check("index.html has the #sched-view-list container (on the tab, not the modal)",
  /id="sched-view-list"/.test(html));

// --- 8a) static locks: 7 triggers + 3 new selects + helpers + i18n both packs ---------
for (const k of ["weekly_at", "monthly_at", "yearly_at"]) {
  check("index.html trigger select has a " + k + " option",
    html.includes('value="' + k + '" data-i18n="sched.' + k + '"'));
}
for (const id of ["sched-workspace", "sched-perm", "sched-model"]) {
  check("index.html form has select #" + id, new RegExp('id="' + id + '"').test(html));
}
check("perm select carries the three tiers (auto/full/manual)",
  /value="auto"/.test(html) && /value="full"/.test(html) && /value="manual"/.test(html));
check("app.js SCHED_PH covers all 7 modes",
  /const SCHED_PH = \{[\s\S]*?every_minutes[\s\S]*?weekly_at[\s\S]*?monthly_at[\s\S]*?yearly_at[\s\S]*?\};/.test(src));
check("app.js defines schedFillSelectors wired into openSchedModal",
  /function schedFillSelectors\(/.test(src) && /schedFillSelectors\(\{workspace:/.test(src));
check("app.js update branch sends the full override state (dash sentinel clears)",
  /upd\.roots = wsVal \? \[wsVal\] : "-"/.test(src) && /upd\.model = mdVal \|\| "-"/.test(src));
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
check("i18n carries the new keys in BOTH packs",
  ["sched.weekly_at", "sched.monthly_at", "sched.yearly_at", "sched.workspace",
   "sched.perm", "sched.perm.auto", "sched.perm.full", "sched.perm.manual",
   "sched.model", "sched.model.follow"].every((k) => i18nSrc.split('"' + k + '":').length === 3));
check("renderSchedule builds an override badge (roots/approval/model)",
  /const badges = \[\]/.test(src) && /e\.approval !== "auto"/.test(src) && /esc\(e\.model\)/.test(src));


// --- 4) openSchedModal still defined and called; update tool called ----------------
for (const name of ["openSchedModal", "schedResetForm", "schedApplyLabel"]) {
  check(`app.js DEFINES function ${name}`, new RegExp(`function\\s+${name}\\s*\\(`).test(src));
  check(`app.js CALLS ${name}(`, new RegExp(`[^\\w]${name}\\(`).test(src));
}
check("app.js calls the schedule update tool", /mcpText\(\s*"schedule"\s*,\s*"update"/.test(src));

// --- 5) the loadSchedule startup-race fix (retry, not bare silent return) ----------
const lsStart = src.indexOf("async function loadSchedule");
const lsBody = src.slice(lsStart, src.indexOf("\n}", lsStart) + 2);
check("loadSchedule no longer has a bare 'if (!mcpInfo.tools) return;' silent bail",
  !/if\s*\(\s*!mcpInfo\.tools\s*\)\s*return\s*;/.test(lsBody));
check("loadSchedule retries via setTimeout when tools are not ready",
  /mcpInfo\.tools/.test(lsBody) && /setTimeout/.test(lsBody));

// --- runtime lock: boot the page, mock the MCP channel, exercise the helpers --------
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
// All realm-internal state is captured by CLOSURE in this single eval (not via a later eval).
appCode += `
;window.__api = {
  openSchedModal, renderSchedule, schedResetForm, schedApplyLabel,
  getT: (k, p) => t(k, p),
  setTools: (n) => { mcpInfo.tools = n; },
  getEditing: () => schedEditing,
  setEditing: (v) => { schedEditing = v; },
  nameField: () => document.getElementById("sched-name"),
  modeField: () => document.getElementById("sched-mode"),
  valueField: () => document.getElementById("sched-value"),
  applyBtn: () => document.getElementById("sched-apply"),
  modal: () => document.getElementById("sched-modal"),
  list: () => document.getElementById("sched-view-list"),
  getTab: () => tab,
};`;

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);
const api = win.__api;

for (const name of ["openSchedModal", "renderSchedule", "schedResetForm", "schedApplyLabel"]) {
  check(`boots as a real function: ${name}`, typeof api[name] === "function");
}

// bounded positive-poll settle: flaky-killer for the two deep-link boots below.
// A fixed short setTimeout was too short under full-suite CPU contention -- the
// modal-open path is async (boot -> loadMcp/loadSchedule), so the FIRST boot was
// occasionally asserted before it had opened. Poll every ~8ms up to `limitMs`
// until the predicate holds, then return; the caller's check still asserts the
// real outcome (a genuine miss still FAILs, the differential still bites).
const until = (pred, limitMs = 2000) => new Promise((res) => {
  const t0 = Date.now();
  (function tick() {
    let ok = false;
    try { ok = !!pred(); } catch (e) { ok = false; }
    if (ok || Date.now() - t0 >= limitMs) return res();
    setTimeout(tick, 8);
  })();
});
(async () => {
  const STUB = JSON.stringify({name: "probe-job", trigger: "daily_at 09:00", next: "today/tmr 09:00",
    task: "do the thing", last_run: {ts: 1, ok: true}, consumed: false});
  win.fetch = async (url, opts) => {
    console.log('SECS5:', String(url));
    if (url === "mcp/call") {
      console.log("S8-DBG stub resolves:", String(win.__stub8 || STUB).slice(0, 60));
      return { ok: true, status: 200, json: async () => ({ ok: true, text: win.__stub8 || STUB }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  api.setTools(1);   // mirror "loadMcp already ran"

  // renderSchedule fills the tab main list (#sched-view-list) with edit + delete buttons.
  await api.renderSchedule();
  check("renderSchedule fills #sched-view-list", api.list() !== null);
  check("renderSchedule renders the stub entry name", /probe-job/.test(api.list().innerHTML));
  check("renderSchedule emits a data-sched-edit button (edit)", /data-sched-edit="probe-job"/.test(api.list().innerHTML));
  check("renderSchedule emits a data-sched-del button (delete)", /data-sched-del="probe-job"/.test(api.list().innerHTML));

  // schedResetForm clears edit mode and blanks fields.
  api.setEditing("probe-job"); api.nameField().value = "x";
  api.schedResetForm();
  check("schedResetForm clears schedEditing to null", api.getEditing() === null);
  check("schedResetForm blanks the name field", api.nameField().value === "");

  // openSchedModal loads the entry into the FORM (edit mode), reading from the list.
  await api.openSchedModal("probe-job");
  check("openSchedModal un-hides the modal", api.modal().hidden === false);
  check("openSchedModal sets edit mode to the located entry", api.getEditing() === "probe-job");
  check("openSchedModal prefills the name field", api.nameField().value === "probe-job");
  check("openSchedModal prefills trigger mode", api.modeField().value === "daily_at");
  check("openSchedModal prefills trigger value", api.valueField().value === "09:00");
  check("apply button switches to the update label in edit mode",
    api.applyBtn().textContent && api.applyBtn().textContent === api.getT("sched.apply.update"));

  // A create-mode open (null) must clear edit state and blank the form.
  await api.openSchedModal(null);
  check("openSchedModal(null) is create mode (schedEditing null)", api.getEditing() === null);
  check("openSchedModal(null) blanks the name field", api.nameField().value === "");

  // --- 6) sidebar routing (2026-11): title click -> schedule TAB; + click -> MODAL ------
  // The + button lives INSIDE .kb-panel__head, so its click bubbles into the delegated
  // handler; the empty #schedule-add branch must swallow it (no double-fire) and only the
  // button's own onclick may open the modal. Real jsdom click dispatch proves the routing.
  const idle = () => new Promise((r) => setTimeout(r, 10));   // let the async handler finish
  const panel = doc.getElementById("schedule-panel");
  const headEl = panel.querySelector(".kb-panel__head");
  const addBtn = doc.getElementById("schedule-add");
  check("the + branch is EMPTY (no openSchedModal/showTab inside, anti double-fire)",
    (() => { const i = src.indexOf('closest("#schedule-add")'); const body = src.slice(i, src.indexOf("}", i)); return body && !/openSchedModal|showTab/.test(body); })());
  api.modal().hidden = true;   // baseline: modal closed
  addBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await idle();
  check("click on + opens the modal (its own onclick fires)", api.modal().hidden === false);
  check("click on + does NOT switch the tab (stays chat)", api.getTab() === "chat");
  headEl.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await idle();
  check("click on the title jumps to the schedule tab", api.getTab() === "schedule");

  // --- 7) ?modal=sched deep-link hook (2026-11): the create modal must be reachable by URL ---
  // Why: the headless screenshot tool renders a page by URL only (no click), so the modal
  // state was pixel-unreachable. A boot whose URL carries ?modal=sched must open the modal
  // on load; a boot without it must NOT. Two clean full boots (query is fixed at construct).
  function bootWithQuery(query) {
    const d = new JSDOM(html, { url: "http://127.0.0.1/" + (query || ""), runScripts: "outside-only" });
    const w = d.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    if (typeof w.requestAnimationFrame !== "function") w.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
    w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    if (!w.document.getElementById("toasts")) { const td = w.document.createElement("div"); td.id = "toasts"; w.document.body.appendChild(td); }   // mirror the main boot (startup seg needs it)
    w.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
    w.eval(src + "\n;window.__boot = { modal: () => document.getElementById(\"sched-modal\") };");
    return w;
  }
  const wHook = bootWithQuery("?modal=sched");
  // poll until the async boot opens it (2s timeout still lets a real miss FAIL)
  await until(() => wHook.__boot.modal().hidden === false);
  check("?modal=sched opens the create modal on load", wHook.__boot.modal().hidden === false);
  const wPlain = bootWithQuery("");
  // give a spurious async open a generous window (poll 600ms); if it never
  // opens the poll runs to the limit and the closed-state check passes -- this
  // is stricter than the old 30ms (it observes ~20x longer, so a slow false-open
  // cannot slip past).
  await until(() => wPlain.__boot.modal().hidden === false, 600);
  check("no query keeps the modal closed (the hook is the only opener)", wPlain.__boot.modal().hidden === true);

  // --- 8b) behaviour lock: an entry WITH overrides renders badge chips, and the edit
  // form round-trips trigger + the three override selects. Uses the MAIN realm's boot
  // stub, which honours win.__stub8 (see the boot stub above).
  const STUB8 = JSON.stringify({name: "probe-badge", trigger: "weekly_at 5:09:30",
    next: "weekly 5:09:30", task: "badge probe", last_run: null, consumed: false,
    roots: ["C:/test-root"], approval: "full", model: "swift-iq3_s"});
  win.__stub8 = STUB8;
  api.setTools(1);   // boot's async loadMcp may have reset it to 0 -- renderSchedule would silently bail
  console.log("S8 SET, read back:", String(win.__stub8).slice(0, 60));
  await api.renderSchedule();
  await new Promise((r) => setTimeout(r, 10)); // let the async stub round-trip settle before asserting
  check("badge row renders name + workspace leaf + tier + model",
    /probe-badge/.test(api.list().innerHTML) && /test-root/.test(api.list().innerHTML)
    && /full/.test(api.list().innerHTML) && /swift-iq3_s/.test(api.list().innerHTML));
  await api.openSchedModal("probe-badge");
  check("edit form round-trips the new trigger (mode=weekly_at, value=5:09:30)",
    api.modeField().value === "weekly_at" && api.valueField().value === "5:09:30");
  check("edit form round-trips the overrides (perm=full, model pinned)",
    win.document.getElementById("sched-perm").value === "full"
    && win.document.getElementById("sched-model").value === "swift-iq3_s");
  check("edit form workspace select carries the entry root",
    win.document.getElementById("sched-workspace").value === "C:/test-root");
  win.__stub8 = null;

  // --- backdrop-close removed: a FORM modal keeps its in-progress form (2026-11-22) -----------
  // root cause was `if (e.target.id === "sched-modal") hidden=true` -- an accidental click outside
  // the card dropped a half-filled schedule. Lock #1: that backdrop-close must not come back.
  check("static: sched-modal has NO backdrop-click-to-close in source",
    !src.includes('if (e.target.id === "sched-modal") $("sched-modal").hidden = true;'));
  // runtime differential: open create-form, type a name, click the backdrop -> must stay open with
  // the typed value intact (the explicit close button is the only outside-card way out).
  await api.openSchedModal(null);
  check("create form is open before the backdrop click", api.modal().hidden === false);
  api.nameField().value = "half-typed-schedule";
  api.modal().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  check("a backdrop click does NOT close the form (no silent drop, load-bearing)",
    api.modal().hidden === false);
  check("the in-progress value survives the backdrop click", api.nameField().value === "half-typed-schedule");
  // Esc still closes (the explicit path we kept must survive) - prove it bites.
  api.modal().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape still closes it (explicit keyboard exit intact)", api.modal().hidden === true);

  console.log("\nREGRESSION: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
  process.exit(FAILURES.length ? 1 : 0);
})();
