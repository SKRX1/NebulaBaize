/* [工作区拖拽排序 方案C 2026-11-21] 侧栏工作区「中间层拖拽排序 + 置顶/无工作区分层墙 + 尾部落点 + 恢复默认顺序」行为锁。
   模型：pinned 工作区强制浮顶（墙，不可拖、不可作落点）；loose「无工作区」桶强制最底（墙）；
   其余工作区按 workspaces 数组序，可整行 HTML5 拖拽换位（reorderWorkspace splice 移位 →
   saveWorkspaces 落盘 → renderSessions 重绘）。落点按 drop 落在目标行上/下半区决定插到 before/after；
   拖过末行底部 = 尾部落点 → reorderWorkspaceToEnd 移到数组末尾。
   恢复默认顺序：默认 = 注册顺序快照（ws.order.default，首跑播种、新注册追加），resetWorkspaceOrder
   按快照重排，不在快照里的新路径保持当前尾部相对序。每条行为锁都配 decoy 差分证明 load-bearing。
   Run: node tests/test_ws_dragorder_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
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
const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
const cssCode = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");

/* ── static locks ── */
console.log("\n=== A. static locks ===");
check("S1 wsRow emits draggable=true only for non-pinned non-loose rows",
  /\$\{loose \|\| g\.pinned \? "" : " draggable=\\"true\\""\}/.test(appCode));
check("S2 reorderWorkspace(dragPath, dropPath, before) exists",
  /function reorderWorkspace\(dragPath, dropPath, before\)/.test(appCode));
check("S3 reorderWorkspace splices the workspaces array (not a copy)",
  /function reorderWorkspace\([\s\S]*?const arr = workspaces;[\s\S]*?arr\.splice\(from, 1\)[\s\S]*?arr\.splice\(before \? to : to \+ 1, 0, moved\)/.test(appCode));
check("S4 reorderWorkspace persists (saveWorkspaces) then repaints (renderSessions)",
  /function reorderWorkspace\([\s\S]*?saveWorkspaces\(\); renderSessions\(\);/.test(appCode));
check("S5 a self-drop / empty-key drop is a no-op (bails before splice)",
  /function reorderWorkspace\([\s\S]*?if \(!dk \|\| !tk \|\| dk === tk\) return;/.test(appCode));
check("S6 the four drag events are delegated on #session-list",
  appCode.includes('$("session-list").addEventListener("dragstart"') &&
  appCode.includes('$("session-list").addEventListener("dragover"') &&
  appCode.includes('$("session-list").addEventListener("drop"') &&
  appCode.includes('$("session-list").addEventListener("dragend"'));
check("S7 the drag delegation targets only draggable .st-ws rows (walls excluded)",
  /addEventListener\("dragstart", \(e\) => \{[\s\S]*?closest\("\.st-ws\[draggable\]"\)/.test(appCode));
check("S8 drop clears every indicator BEFORE the null check (no crash on a wall drop)",
  /addEventListener\("drop", \(e\) => \{[\s\S]*?querySelectorAll\("\.st-ws--drop-above, \.st-ws--drop-below"\)[\s\S]*?if \(!ws \|\| !wsDragId\) return;/.test(appCode));
check("S9 pinned + loose get marker classes (the walls)",
  /\$\{g\.pinned \? " st-ws--pinned" : ""\}/.test(appCode));
check("S10 CSS draws the drop indicator with token colors (no hard-coded color)",
  /\.st-ws--drop-above::before[\s\S]*?var\(--st-accent/.test(cssCode) &&
  /\.st-ws--dragging \{ opacity:/.test(cssCode));
check("S11 no hard-coded hex color in the new drop CSS block (scoped, not the whole file)",
  (() => { const m = cssCode.match(/\/\* workspace drag-reorder[\s\S]*?\.st-ws--pinned \.st-ws__head \{ cursor: default; \}/); return m && !/#[0-9a-fA-F]{3,6}/.test(m[0]); })());

/* ── C. tail drop-zone + reset static locks ── */
console.log("\n=== C. tail drop-zone + reset static locks ===");
check("C1 reorderWorkspaceToEnd(dragPath) exists and pushes to the array end",
  /function reorderWorkspaceToEnd\(dragPath\)/.test(appCode) &&
  /function reorderWorkspaceToEnd\([\s\S]*?arr\.splice\(from, 1\)[\s\S]*?arr\.push\(moved\)/.test(appCode));
check("C2 reorderWorkspaceToEnd: moving the already-last item is a no-op (from===len-1 bail)",
  /function reorderWorkspaceToEnd\([\s\S]*?if \(from < 0 \|\| from === arr\.length - 1\) return;/.test(appCode));
check("C3 drop routes a tail drop (no target row) to reorderWorkspaceToEnd",
  /addEventListener\("drop", \(e\) => \{[\s\S]*?if \(!ws && wsDragId && tailing\) \{ reorderWorkspaceToEnd\(wsDragId\)/.test(appCode));
check("C4 dragover flags the tail drop-zone (#session-list.st-ws-list--droptail) past the last row",
  /addEventListener\("dragover", \(e\) => \{[\s\S]*?classList\.toggle\("st-ws-list--droptail", inTail\)/.test(appCode) &&
  /\.st-ws-list--droptail[\s\S]*?var\(--st-accent/.test(cssCode));
check("C5 drop + dragend both clear the droptail indicator (no stuck line)",
  appCode.includes('list.classList.remove("st-ws-list--droptail")') &&
  appCode.includes('$("session-list").classList.remove("st-ws-list--droptail")'));
check("C6 ws.order.default snapshot is seeded once on first run (seedWsDefaultOrder IIFE)",
  /function seedWsDefaultOrder[\s\S]*?store\.get\("ws\.order\.default", null\)[\s\S]*?store\.set\("ws\.order\.default", workspaces\.map/.test(appCode));
check("C7 registerWorkspace appends a brand-new path to the default snapshot (no dup)",
  /const def = store\.get\("ws\.order\.default", \[\]\); if \(!def\.some\(\(p\) => wsKey\(p\) === wsKey\(path\)\)\) \{ def\.push\(path\)/.test(appCode));
check("C8 resetWorkspaceOrder lays default first, then appends not-in-snapshot paths (keeps them)",
  /function resetWorkspaceOrder\(\)[\s\S]*?def\.forEach\(\(p\) =>[\s\S]*?next\.push\(w\)[\s\S]*?workspaces\.forEach\(\(w\) => \{ if \(byKey\[wsKey\(w\.path\)\]\) next\.push\(w\)/.test(appCode));
check("C9 the ws-order-reset button is wired to resetWorkspaceOrder (in bindSidebarSettings)",
  /const wsReset = \$\("ws-order-reset"\); if \(wsReset\) wsReset\.onclick = \(\) => \{[\s\S]*?resetWorkspaceOrder\(\); toast/.test(appCode) &&
  /id="ws-order-reset"/.test(html));
check("C10 i18n has wsreset + toast keys in BOTH languages",
  /"sidebar\.settings\.wsreset": "恢复工作区顺序"/.test(i18nCode) &&
  /"toast\.wsorder\.msg": "已按注册顺序重排工作区/.test(i18nCode) &&
  /"sidebar\.settings\.wsreset": "Reset order"/.test(i18nCode) &&
  /"toast\.wsorder\.msg": "Workspaces re-sorted by registration order/.test(i18nCode));

/* ── behaviour locks: boot real app.js, drive the real functions ── */
console.log("\n=== B. behaviour locks (jsdom boot) ===");
function boot() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8099/" });
  const win = dom.window;
  const probe = `
    window.__api = {
      reorder: (a,b,before) => reorderWorkspace(a,b,before),
      reorderEnd: (a) => reorderWorkspaceToEnd(a),
      reset: () => resetWorkspaceOrder(),
      order: () => workspaces.map((w) => w.path),
      seed: (arr) => { workspaces = arr.map((p) => ({path:p, name:p, collapsed:false, pinned:false})); saveWorkspaces(); },
      setDefault: (arr) => store.set("ws.order.default", arr),
      setPinned: (p) => { const w = workspaces.find((x)=>x.path===p); if (w) w.pinned = true; },
    };
  `;
  win.eval(appCode + probe);
  return win;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// B1: plain reorder — move A after C in [A,B,C] dropping A on the lower half of C → [B,C,A]
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorder("A", "C", false);
  check("B1 drop A below C → order [B,C,A]", eq(w.__api.order(), ["B","C","A"]), JSON.stringify(w.__api.order()));
}
// B1-decoy: dropping A on the UPPER half of C (before=true) → [B,A,C]
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorder("A", "C", true);
  check("B1-decoy drop A above C → order [B,A,C] (before-flag load-bearing)", eq(w.__api.order(), ["B","A","C"]), JSON.stringify(w.__api.order()));
}
// B2: self-drop is a no-op (A onto A)
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorder("A", "A", false);
  check("B2 self-drop is a no-op → order stays [A,B,C]", eq(w.__api.order(), ["A","B","C"]), JSON.stringify(w.__api.order()));
}
// B3: drop onto a vanished target → moved lands at the end
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorder("A", "ZZZ", false);
  check("B3 drop on a vanished target → moved lands at the end [B,C,A]", eq(w.__api.order(), ["B","C","A"]), JSON.stringify(w.__api.order()));
}
// B5-decoy: moving B onto upper half of A (before) → [B,A,C]
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorder("B", "A", true);
  check("B5-decoy move B above A → [B,A,C]", eq(w.__api.order(), ["B","A","C"]), JSON.stringify(w.__api.order()));
}

console.log("\n=== D. tail drop-zone + reset behaviour locks (jsdom boot) ===");
// D1: tail drop moves A to the very end → [B,C,A]
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorderEnd("A");
  check("D1 tail-drop A → order [B,C,A] (moved to array end)", eq(w.__api.order(), ["B","C","A"]), JSON.stringify(w.__api.order()));
}
// D1-decoy: tail-dropping the ALREADY-LAST item (C) is a no-op (the from===len-1 bail is load-bearing)
{
  const w = boot(); w.__api.seed(["A", "B", "C"]); w.__api.reorderEnd("C");
  check("D1-decoy tail-drop last item C → NO-OP [A,B,C] (last-item bail load-bearing)", eq(w.__api.order(), ["A","B","C"]), JSON.stringify(w.__api.order()));
}
// D2: reset snaps a shuffled order back to the default snapshot
{
  const w = boot(); w.__api.setDefault(["A", "B", "C"]); w.__api.seed(["C", "A", "B"]); w.__api.reset();
  check("D2 reset [C,A,B] with default [A,B,C] → [A,B,C]", eq(w.__api.order(), ["A","B","C"]), JSON.stringify(w.__api.order()));
}
// D2-decoy: reset with NO default snapshot is a no-op (Array.isArray guard) — order untouched
{
  const w = boot(); w.__api.seed(["C", "A", "B"]);   // no setDefault
  w.__api.reset();
  const ord = w.__api.order();
  check("D2-decoy reset with no default → order unchanged (guard load-bearing)", eq(ord, ["C","A","B"]), JSON.stringify(ord));
}
// D3: reset keeps a new path that is NOT in the snapshot (appended at the tail, relative order kept)
{
  const w = boot(); w.__api.setDefault(["A", "B"]); w.__api.seed(["B", "C", "A"]); w.__api.reset();
  check("D3 reset default [A,B] + current [B,C,A] → [A,B,C] (new C appended, kept)", eq(w.__api.order(), ["A","B","C"]), JSON.stringify(w.__api.order()));
}
// D3-decoy: the appended new path is NOT dropped (length preserved = non-destructive)
{
  const w = boot(); w.__api.setDefault(["A", "B"]); w.__api.seed(["B", "C", "A"]); w.__api.reset();
  check("D3-decoy reset keeps length 3 (never drops an unknown workspace)", w.__api.order().length === 3, JSON.stringify(w.__api.order()));
}

console.log("\n" + (FAILURES.length ? "FAILURES: " + JSON.stringify(FAILURES) : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
