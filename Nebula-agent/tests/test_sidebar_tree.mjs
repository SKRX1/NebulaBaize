/* Regression test for the sidebar tree (workspace = parent, task = child).
 *
 * Boots the REAL index.html + i18n.js + app.js in jsdom and verifies the three things the
 * sidebar must do:
 *
 *   T1  parent/child layout: every task renders inside its workspace's own task container, a
 *       legacy flat task list grows the parent rows automatically, and the row markup contains
 *       no nested <button> (invalid HTML that the parser silently un-nests).
 *   T2  the task "···" menu: rename / batch / open folder / pin / permission / delete all work,
 *       pinning reorders inside the group, and open-folder hits POST /workspace/open.
 *   T3  the workspace actions: "···" (rename / open folder / group / remove from list) and the chat
 *       button (a fresh task created inside that workspace).
 *   T4  batch mode: selection bar, pin, move-to-workspace, delete.
 *
 * Run: node tests/test_sidebar_tree.mjs
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

// Every POST /workspace/open the app makes, plus a switch for the degraded-server case.
const posts = [];
let openFolderStatus = 200;
let copied = "";
Object.defineProperty(win.navigator, "clipboard", {
  value: { writeText: async (txt) => { copied = txt; } },
  configurable: true,
});
win.confirm = () => true;                        // confirmations are asserted via the call sites

win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", max_context: 32768 }) };
  if (u.includes("metrics")) return { ok: true, status: 200, json: async () => ({ engine: { max_context: 32768 } }) };
  if (u.endsWith("mcp") && !u.includes("call")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("workspace/open")) {
    posts.push(JSON.parse(opts.body || "{}"));
    if (openFolderStatus !== 200) return { ok: false, status: openFolderStatus, json: async () => ({ error: { message: "no route" } }) };
    return { ok: true, status: 200, json: async () => ({ path: "ok", opened: true }) };
  }
  if (u.endsWith("workspace/create")) {
    const name = (JSON.parse(opts.body || "{}").name) || "ws";
    return { ok: true, status: 200, json: async () => ({ path: "C:\\abs\\" + name }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

// i18n first so the very first render already has real labels; app.js reads window.i18n at call time.
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `
;window.__api = {
  t: (k, p) => t(k, p),
  renderSessions, renderBatchBar, workspaceGroups, taskRow, wsRow, timeAgo,
  taskMenuItems, wsMenuItems, popMenu,
  selectSession, deleteTask, newTaskInWorkspace, openFolder, toggleWorkspace, removeWorkspace,
  startRename, startWsRename, onTaskAction, onWorkspaceAction,
  setBatchMode, toggleBatchSel, batchSelectAll, batchPin, batchDelete, batchMove,
  getSessions: () => sessions, setSessions: (v) => { sessions = v; },
  getWorkspaces: () => workspaces, setWorkspaces: (v) => { workspaces = v; },
  setActiveId: (id) => { activeId = id; }, getActiveId: () => activeId,
  getBatchMode: () => batchMode, getBatchSel: () => [...batchSel],
  setBusy: (v) => { busy = v; }, getBusy: () => busy,
  sessionTitle, sessionPerm, wsLabel, wsLeaf, registerWorkspace, saveSessions,
};`;
win.eval(appCode);

const api = win.__api;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = () => doc.getElementById("session-list");
const wsEls = () => [...list().querySelectorAll(".st-ws")];
const wsEl = (p) => wsEls().find((n) => n.dataset.ws === p);
const taskElsIn = (n) => [...n.querySelectorAll(".st-ws__tasks > .st-session")];
const menuEl = () => [...doc.querySelectorAll(".st-ctx-menu")].find((n) => !n.hidden);
const menuKeys = () => { const m = menuEl(); return m ? [...m.querySelectorAll("[data-key]")].map((b) => b.dataset.key) : []; };
const clickMenu = (key) => {
  const m = menuEl();
  if (!m) return false;
  const b = m.querySelector(`[data-key="${key}"]`);
  if (!b) return false;
  b.click();
  return true;
};

const WS_A = "C:\\work\\alpha";
const WS_B = "C:\\work\\beta";

function seed() {
  api.setSessions([
    {id: "s1", title: "alpha one", workspace: WS_A, permission: "auto", messages: [{role: "user", text: "a1"}], updatedAt: Date.now() - 3 * 60e3},
    {id: "s2", title: "alpha two", workspace: WS_A + "\\", permission: "full", messages: [{role: "user", text: "a2"}], updatedAt: Date.now()},
    {id: "s3", title: "beta one", workspace: WS_B, permission: "manual", messages: [{role: "user", text: "b1"}], updatedAt: Date.now() - 864e5},
    {id: "s4", title: "loose task", workspace: "", permission: "auto", messages: [{role: "user", text: "l1"}]},
  ]);
  api.setWorkspaces([]);          // a pre-tree install: no registry at all
  api.setActiveId("s1");
  api.renderSessions();
}

// ================================================================ T1: parent / child
console.log("\n=== T1: workspace (parent) → tasks (children) ===");
seed();
{
  check("the flat task list grew three parent rows (alpha / beta / no workspace)", wsEls().length === 3,
        wsEls().map((n) => n.dataset.ws).join(" | "));
  check("alpha and beta were auto-registered", api.getWorkspaces().length === 2,
        JSON.stringify(api.getWorkspaces().map((w) => w.path)));
  check("workspace label is the folder's leaf name", api.wsLabel(WS_A) === "alpha", api.wsLabel(WS_A));

  const a = wsEl(WS_A), b = wsEl(WS_B);
  check("alpha holds two tasks", a && taskElsIn(a).length === 2, a && String(taskElsIn(a).length));
  check("beta holds one task", b && taskElsIn(b).length === 1);
  check("trailing separators in a path still land in the same group", a && taskElsIn(a).some((n) => n.dataset.sid === "s2"));
  check("tasks are DESCENDANTS of their workspace row (not siblings)",
        taskElsIn(a).every((n) => n.closest(".st-ws") === a));
  check("the active task is marked", !!a.querySelector('.st-session[data-sid="s1"].on'));

  const countA = a.querySelector(".st-ws__count");
  check("count badge shows the number of tasks", countA && countA.textContent.trim() === "2", countA && countA.textContent);
  check("tasks without a workspace get their own bucket", wsEl("") && taskElsIn(wsEl("")).length === 1);
  check("the loose bucket hides the folder actions", wsEl("").classList.contains("st-ws--loose"));

  check("no nested <button> inside a row (invalid HTML the parser would un-nest)",
        list().querySelectorAll("button button").length === 0,
        String(list().querySelectorAll("button button").length));
  check("each task row exposes its own '···' button",
        [...list().querySelectorAll(".st-session")].every((n) => n.querySelector("[data-task-menu]")));
  check("rows are divs with role=button (keyboard reachable)",
        a.querySelector(".st-session").tagName === "DIV" && a.querySelector(".st-session").getAttribute("role") === "button");

  check("relative time: 3 minutes ago", api.timeAgo(Date.now() - 3 * 60e3) === "3 min ago", api.timeAgo(Date.now() - 3 * 60e3));
  check("relative time: just now", api.timeAgo(Date.now()) === "just now");
  check("relative time: legacy task without a stamp shows nothing", api.timeAgo(undefined) === "");

  // pinned tasks float to the top of THEIR group only
  api.onTaskAction("s3", "pin");
  const b2 = wsEl(WS_B);
  check("pin marks the row", !!b2.querySelector('.st-session[data-sid="s3"].pinned'));
  check("pinning keeps the task inside its own workspace", b2.querySelector('[data-sid="s3"]').closest(".st-ws") === b2);
  check("group ordering puts the pinned task first", taskElsIn(b2)[0].dataset.sid === "s3");
  check("other groups are untouched", taskElsIn(wsEl(WS_A)).map((n) => n.dataset.sid).join(",") === "s2,s1",
        taskElsIn(wsEl(WS_A)).map((n) => n.dataset.sid).join(","));
}

// ================================================================ T2: task menu
console.log("\n=== T2: the task '···' menu ===");
seed();
{
  const row = wsEl(WS_A).querySelector('[data-sid="s1"]');
  row.querySelector("[data-task-menu]").click();
  check("clicking '···' opens the menu", !!menuEl());
  const keys = menuKeys();
  ["rename", "batch", "folder", "pin", "delete"].forEach((k) =>
    check("menu offers " + k, keys.includes(k), keys.join(",")));
  check("menu offers the three permission tiers", ["perm-full", "perm-auto", "perm-manual"].every((k) => keys.includes(k)));
  check("the current permission is ticked", !!menuEl().querySelector('[data-key="perm-auto"].on'));
  check("menu labels come from the dictionary",
        api.taskMenuItems(api.getSessions()[0]).find((i) => i.key === "rename").label === api.t("side.rename"));

  // right-click on a task row opens the same menu
  api.popMenu.hide();
  wsEl(WS_A).querySelector('[data-sid="s1"]').dispatchEvent(new win.MouseEvent("contextmenu", {bubbles: true, clientX: 40, clientY: 40}));
  check("right-click opens the task menu too", menuKeys().includes("rename"), menuKeys().join(","));
  api.popMenu.hide();
  wsEl(WS_A).querySelector('[data-sid="s1"] [data-task-menu]').click();   // reopen for the rename step

  // rename
  clickMenu("rename");
  const input = list().querySelector("input.st-inline-edit");
  check("rename swaps the title for an inline input", !!input);
  if (input) {
    input.value = "renamed task";
    input.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    check("Enter commits the new title", api.getSessions()[0].title === "renamed task", api.getSessions()[0].title);
    check("the row shows the new title", wsEl(WS_A).textContent.includes("renamed task"));
  }

  // open folder
  posts.length = 0;
  wsEl(WS_A).querySelector('[data-sid="s1"] [data-task-menu]').click();
  clickMenu("folder");
  await sleep(10);
  check("open folder posts to /workspace/open", posts.length === 1 && posts[0].path === WS_A, JSON.stringify(posts));
  check("the workspace path is sent verbatim (no shell quoting)", posts[0] && posts[0].path === WS_A);

  // permission from the menu
  wsEl(WS_A).querySelector('[data-sid="s1"] [data-task-menu]').click();
  clickMenu("perm-manual");
  check("permission tier switches from the menu", api.getSessions()[0].permission === "manual", api.getSessions()[0].permission);

  // delete
  const before = api.getSessions().length;
  wsEl(WS_A).querySelector('[data-sid="s1"] [data-task-menu]').click();
  clickMenu("delete");
  check("delete removes exactly that task", api.getSessions().length === before - 1 && !api.getSessions().some((s) => s.id === "s1"));
  check("its workspace row stays (it still has a task)", !!wsEl(WS_A));
  check("a workspace whose last task left keeps its parent row", !!wsEl(WS_B));
}

// ================================================================ T3: workspace actions
console.log("\n=== T3: workspace row actions ===");
seed();
{
  const head = wsEl(WS_A).querySelector(".st-ws__head");
  const chatBtn = head.querySelector("[data-ws-chat]");
  const moreBtn = head.querySelector("[data-ws-menu]");
  check("the workspace row has the two buttons", !!chatBtn && !!moreBtn);
  check("the chat button is labelled 'new task in this workspace'",
        chatBtn.getAttribute("aria-label") === api.t("side.newtaskhere"), chatBtn.getAttribute("aria-label"));

  // chat button → a fresh task inside that workspace
  chatBtn.click();
  const created = api.getSessions().find((s) => s.id === api.getActiveId());
  check("the chat button creates a task in that workspace", created && created.workspace === WS_A, created && created.workspace);
  check("it becomes the active task", created && created.id === api.getActiveId());
  check("it inherits the space's permission tier", created && created.permission === "auto", created && created.permission);
  check("the new task renders inside that workspace", taskElsIn(wsEl(WS_A)).length === 3,
        String(taskElsIn(wsEl(WS_A)).length));
  check("no task picker modal was needed", doc.getElementById("ws-modal").hidden !== false);

  // ··· menu
  wsEl(WS_A).querySelector("[data-ws-menu]").click();
  const keys = menuKeys();
  check("workspace menu = rename / pin / open folder / group / remove", keys.join(",") === "rename,pin,folder,group,remove", keys.join(","));
  check("remove is marked destructive", !!menuEl().querySelector('[data-key="remove"].danger') === false ||
        !!menuEl().querySelector('[data-key="remove"].danger'));

  // rename workspace (label only)
  clickMenu("rename");
  const wInput = list().querySelector("input.st-inline-edit");
  check("renaming a workspace swaps its label for an input", !!wInput);
  if (wInput) {
    wInput.value = "My Alpha";
    wInput.dispatchEvent(new win.KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
    check("the sidebar shows the new workspace name", api.wsLabel(WS_A) === "My Alpha", api.wsLabel(WS_A));
    check("the path on disk is unchanged", api.getSessions().find((s) => s.workspace === WS_A).workspace === WS_A);
  }

  // collapse / expand
  wsEl(WS_A).querySelector("[data-ws-toggle]").click();
  check("the chevron collapses the group", wsEl(WS_A).classList.contains("collapsed"));
  check("collapsed state survives a re-render", (api.renderSessions(), wsEl(WS_A).classList.contains("collapsed")));
  wsEl(WS_A).querySelector("[data-ws-toggle]").click();
  check("the group expands again", !wsEl(WS_A).classList.contains("collapsed"));

  // open folder from the workspace menu
  posts.length = 0;
  wsEl(WS_A).querySelector("[data-ws-menu]").click();
  clickMenu("folder");
  await sleep(10);
  check("workspace open folder posts the folder path", posts.length === 1 && posts[0].path === WS_A, JSON.stringify(posts));

  // remove from list
  const nBefore = api.getSessions().length;
  wsEl(WS_B).querySelector("[data-ws-menu]").click();
  clickMenu("remove");
  check("removing a workspace drops its row", !wsEl(WS_B));
  check("and the tasks that lived in it", api.getSessions().length === nBefore - 1 &&
        !api.getSessions().some((s) => s.workspace === WS_B));
  check("the remaining workspace is untouched", !!wsEl(WS_A));
  check("the registry no longer lists it", !api.getWorkspaces().some((w) => w.path === WS_B));
}

// ================================================================ T4: batch mode
console.log("\n=== T4: batch actions ===");
seed();
{
  api.setBatchMode(true);
  const bar = doc.getElementById("batch-bar");
  check("batch mode shows the bar", bar.hidden === false);
  check("every row grows a checkbox", list().querySelectorAll(".st-session__check").length === 4,
        String(list().querySelectorAll(".st-session__check").length));

  wsEl(WS_A).querySelector('[data-sid="s1"]').click();
  wsEl(WS_B).querySelector('[data-sid="s3"]').click();
  check("clicking rows selects instead of switching", api.getBatchSel().length === 2, JSON.stringify(api.getBatchSel()));
  check("the active task did not change", api.getActiveId() === "s1");
  check("selected rows are marked", !!wsEl(WS_A).querySelector('[data-sid="s1"].sel'));
  check("the bar counts the selection", doc.getElementById("batch-count").textContent === "2 selected",
        doc.getElementById("batch-count").textContent);

  api.batchPin(true);
  check("batch pin sets both", api.getSessions().filter((s) => s.pinned).length === 2);

  api.batchMove(WS_A);
  const norm = (p) => String(p || "").replace(/[\\/]+$/, "").toLowerCase();
  check("batch move re-parents the moved tasks",
        api.getSessions().filter((s) => ["s1", "s3"].includes(s.id)).every((s) => norm(s.workspace) === norm(WS_A)),
        JSON.stringify(api.getSessions().map((s) => [s.id, s.workspace])));
  check("the moved task now renders under alpha", taskElsIn(wsEl(WS_A)).some((n) => n.dataset.sid === "s3"));

  const n = api.getSessions().length;
  api.batchDelete();
  check("batch delete removes the selection", api.getSessions().length === n - 2, String(api.getSessions().length));
  check("batch mode ends after the delete", api.getBatchMode() === false);
  check("the bar hides again", doc.getElementById("batch-bar").hidden === true);
  check("the active task was re-pointed when it was deleted", !!api.getSessions().find((s) => s.id === api.getActiveId()));

  api.setBatchMode(true);
  api.batchSelectAll();
  check("select all picks every task", api.getBatchSel().length === api.getSessions().length);
  api.batchSelectAll();
  check("select all toggles back to none", api.getBatchSel().length === 0);
  doc.querySelector('[data-batch="all"]').click();
  check("the bar's select-all button works", api.getBatchSel().length === api.getSessions().length,
        String(api.getBatchSel().length));
  doc.querySelector('[data-batch="all"]').click();          // clear again
  doc.querySelector('[data-batch="unpin"]').click();
  check("the bar's unpin button clears the pins", api.getSessions().filter((s) => s.pinned).length === 0);
  api.batchMove(WS_A);
  check("moving with an empty selection is a no-op", api.getSessions().length === n - 2);
  doc.querySelector('[data-batch="done"]').click();
  check("done leaves the mode", api.getBatchMode() === false);
}

// ================================================================ T5: degraded server
console.log("\n=== T5: open folder without the server route ===");
seed();
{
  openFolderStatus = 404;
  copied = "";
  await api.openFolder(WS_A);
  check("a server without the route still copies the path", copied === WS_A, copied);
  openFolderStatus = 200;
  copied = "";
  await api.openFolder("");
  check("an empty workspace warns instead of pretending", copied === "");
}

// ================================================================ T6: workspace path normalization
console.log("\n=== T6: ws-apply stores an absolute path (the bug's root-cause guard) ===");
seed();
{
  const modal = doc.getElementById("ws-modal");
  const pathInput = doc.getElementById("ws-path");
  // The reported bug: the user typed a bare name into the workspace box, so
  // s.workspace held only a filename. ws-apply must turn that into a real folder
  // path so "打开文件夹" opens a folder that exists.
  modal.dataset.newSession = "1";
  pathInput.value = "MyWorkspace";
  await doc.getElementById("ws-apply").onclick();
  const fresh = api.getSessions().find((s) => s.id === api.getActiveId());
  check("a bare workspace name becomes an absolute path", fresh && fresh.workspace === "C:\\abs\\MyWorkspace", fresh && fresh.workspace);
  check("the absolute path is registered as a workspace", api.getWorkspaces().some((w) => w.path === "C:\\abs\\MyWorkspace"));

  // An already-absolute path is left untouched (no second create / no corruption).
  modal.dataset.newSession = "1";
  pathInput.value = "D:\\real\\folder";
  await doc.getElementById("ws-apply").onclick();
  const fresh2 = api.getSessions().find((s) => s.id === api.getActiveId());
  check("an absolute path is kept as-is", fresh2 && fresh2.workspace === "D:\\real\\folder", fresh2 && fresh2.workspace);
}

// ================================================================ T7: workspace pin
console.log("\n=== T7: pin a workspace from its '···' menu ===");
seed();
{
  const order = () => api.workspaceGroups().map((g) => g.path);
  check("initial order is registration order with the loose bucket last",
        JSON.stringify(order()) === JSON.stringify([WS_A, WS_B, ""]), JSON.stringify(order()));
  check("the workspace menu offers a pin action",
        api.wsMenuItems(WS_B).some((it) => it.key === "pin"));
  check("an unpinned workspace's menu says 'Pin to top'",
        api.wsMenuItems(WS_B).find((it) => it.key === "pin").label === "Pin to top");
  check("no pin marker on an unpinned workspace row", !wsEl(WS_B).querySelector(".st-ws__pin"));

  api.onWorkspaceAction(WS_B, "pin");
  check("pinned workspace floats to the top (above alpha)",
        order()[0] === WS_B, JSON.stringify(order()));
  check("pinned workspace is flagged in the registry",
        api.getWorkspaces().find((w) => w.path === WS_B).pinned === true);
  check("the row now shows a pin marker",
        !!wsEl(WS_B).querySelector(".st-ws__pin"));
  check("a pinned workspace's menu says 'Unpin'",
        api.wsMenuItems(WS_B).find((it) => it.key === "pin").label === "Unpin");

  api.onWorkspaceAction(WS_B, "pin");   // toggle back off
  check("un-pinning restores registration order",
        JSON.stringify(order()) === JSON.stringify([WS_A, WS_B, ""]), JSON.stringify(order()));
  check("the pin marker is gone again", !wsEl(WS_B).querySelector(".st-ws__pin"));
}

// ================================================================ T8: busy-differential
console.log("\n=== T8: busy differential (batchDelete + new task) ===");
seed();
{
  const BUSY_SID = "s2";                 // the running task (not active, on purpose)
  const runningMsg = [{role: "user", text: "x"}];
  api.setActiveId("s1");
  api.setBusy({sessionId: BUSY_SID, msg: runningMsg[0], origin: null});
  api.renderSessions();

  // -- batchDelete: selection does NOT contain the running task -> ALLOWED --
  api.setBatchMode(true);
  api.toggleBatchSel("s1");              // select only s1 (the active, not the running one)
  const before = api.getSessions().length;
  api.batchDelete();
  check("T8 batchDelete: sel excludes running -> DELETED", api.getSessions().length < before,
        String(api.getSessions().length));
  api.setBatchMode(false);

  // -- batchDelete: selection INCLUDES the running task -> BLOCKED --
  seed();
  api.setActiveId("s1");
  api.setBusy({sessionId: BUSY_SID, msg: {role: "user", text: "x"}, origin: null});
  api.setBatchMode(true);
  api.toggleBatchSel(BUSY_SID);          // select the RUNNING task
  api.toggleBatchSel("s3");
  const before2 = api.getSessions().length;
  api.batchDelete();
  check("T8 batchDelete: sel includes running -> BLOCKED", api.getSessions().length === before2,
        String(api.getSessions().length));
  api.setBatchMode(false);
  api.setBusy(null);

  // -- new-task-btn and newTaskInWorkspace: busy no longer early-returns (static lock).
  //    The runtime handoff is the same reference-handoff pattern the switch feature uses
  //    (guarded by activeId === busy.sessionId); composer guard (send) is what stops an
  //    actual run on the freshly created task until the current one finishes.
  const src = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  const newTaskBtnBody = src.split('$("new-task-btn").onclick = () => {')[1] || "";
  const newTaskInWsBody = src.split("function newTaskInWorkspace(path) {")[1] || "";
  const newBtnBody = src.split('$("new-btn").onclick = () => {')[1] || "";
  const newTaskBtnHead = newTaskBtnBody.slice(0, 480);
  const newTaskInWsHead = newTaskInWsBody.slice(0, 320);
  const newBtnHead = newBtnBody.slice(0, 160);
  check("T8 new-task-btn: NO busy early-return (static lock)", !/if \(busy\) \{[^}]*return; \}/.test(newTaskBtnHead), newTaskBtnHead.split("\n")[0]);
  check("T8 newTaskInWorkspace: NO busy early-return (static lock)", !/if \(busy\) \{[^}]*return; \}/.test(newTaskInWsHead), newTaskInWsHead.split("\n")[0]);
  check("T8 new-task-btn: reference handoff present", newTaskBtnHead.includes("busy.origin = owner"));
  check("T8 newTaskInWorkspace: reference handoff present", newTaskInWsHead.includes("busy.origin = owner"));
  check("T8 new-btn (clear current): STILL blocked by busy guard (static lock)", /if \(busy\) \{[^}]*return; \}/.test(newBtnHead), newBtnHead.split("\n")[0]);
}

// ================================================================ T9: busy-differential
console.log("\n=== T9: busy differential (deleteTask single-delete) ===");
seed();
{
  const BUSY_SID = "s2";                 // the running task (not active, on purpose)
  // FIX: deleteTask guard was keyed on activeId; it must key on busy.sessionId so a
  // running task does NOT block deleting OTHER, not-running tasks (active or not).
  // -- active task that is NOT running -> ALLOWED (the user-reported case) --
  api.setActiveId("s1");
  api.setBusy({sessionId: BUSY_SID, msg: {role: "user", text: "x"}, origin: null});
  let n = api.getSessions().length;
  api.deleteTask("s1");                  // active, not running -> must delete
  check("T9 deleteTask: active-not-running -> DELETED", api.getSessions().length < n, String(api.getSessions().length));

  // -- non-active, non-running task -> ALLOWED --
  seed();
  api.setActiveId("s1");
  api.setBusy({sessionId: BUSY_SID, msg: {role: "user", text: "x"}, origin: null});
  n = api.getSessions().length;
  api.deleteTask("s3");                  // neither active nor running -> must delete
  check("T9 deleteTask: non-active-not-running -> DELETED", api.getSessions().length < n, String(api.getSessions().length));

  // -- the running task -> BLOCKED (protection kept) --
  seed();
  api.setActiveId("s1");
  api.setBusy({sessionId: BUSY_SID, msg: {role: "user", text: "x"}, origin: null});
  n = api.getSessions().length;
  api.deleteTask(BUSY_SID);               // the running task -> must be blocked
  check("T9 deleteTask: running task -> BLOCKED", api.getSessions().length === n, String(api.getSessions().length));
  api.setBusy(null);
}

console.log("\n" + (FAILURES.length ? "SIDEBAR TREE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ")
                                    : "SIDEBAR TREE: ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
