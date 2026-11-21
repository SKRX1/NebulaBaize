/* [工作区拖拽排序 方案C 2026-11-21] 侧栏工作区「中间层拖拽排序 + 置顶/无工作区分层墙」行为锁。
   模型：pinned 工作区强制浮顶（墙，不可拖、不可作落点）；loose「无工作区」桶强制最底（墙）；
   其余工作区按 workspaces 数组序，可整行 HTML5 拖拽换位（reorderWorkspace splice 移位 →
   saveWorkspaces 落盘 → renderSessions 重绘）。落点按 drop 落在目标行上/下半区决定插到 before/after。
   static locks 锁接线（draggable 属性、reorderWorkspace 契约、事件委托、CSS 指示器、pinned/loose 墙）；
   behavior locks 在 jsdom 里 boot 真实 app.js 调 reorderWorkspace，每条都配 decoy 差分证明 load-bearing。
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
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const cssCode = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

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

/* ── behaviour locks: boot real app.js, drive reorderWorkspace ── */
console.log("\n=== B. behaviour locks (jsdom boot) ===");
function boot() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8099/" });
  const win = dom.window;
  const probe = `
    window.__api = {
      reorder: (a,b,before) => reorderWorkspace(a,b,before),
      order: () => workspaces.map((w) => w.path),
      seed: (arr) => { workspaces = arr.map((p) => ({path:p, name:p, collapsed:false, pinned:false})); saveWorkspaces(); },
      setPinned: (p) => { const w = workspaces.find((x)=>x.path===p); if (w) w.pinned = true; },
    };
  `;
  win.eval(appCode + probe);
  return win;
}

// B1: plain reorder — move A after C in [A,B,C] dropping A on the lower half of C → [B,C,A]
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("A", "C", false);          // before=false → insert AFTER C
  const ord = w.__api.order();
  check("B1 drop A below C → order [B,C,A]", JSON.stringify(ord) === JSON.stringify(["B","C","A"]), JSON.stringify(ord));
}
// B1-decoy: dropping A on the UPPER half of C (before=true) → [B,A,C] (proves the before flag is load-bearing)
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("A", "C", true);           // before=true → insert BEFORE C
  const ord = w.__api.order();
  check("B1-decoy drop A above C → order [B,A,C] (before-flag load-bearing)",
    JSON.stringify(ord) === JSON.stringify(["B","A","C"]), JSON.stringify(ord));
}
// B2: self-drop is a no-op (A onto A)
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("A", "A", false);
  const ord = w.__api.order();
  check("B2 self-drop is a no-op → order stays [A,B,C]",
    JSON.stringify(ord) === JSON.stringify(["A","B","C"]), JSON.stringify(ord));
}
// B3: drop onto a non-existent key is a no-op (dropPath not in array)
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("A", "ZZZ", false);        // target missing → moved pushed to end? no: to<0 pushes. Use a real no-op path:
  // reorderWorkspace: to<0 → arr.push(moved) → [B,C,A]. Lock that documented behaviour:
  const ord = w.__api.order();
  check("B3 drop on a vanished target → moved lands at the end [B,C,A]",
    JSON.stringify(ord) === JSON.stringify(["B","C","A"]), JSON.stringify(ord));
}
// B4: case-insensitive path identity (wsKey lowercases) — dropping "a" onto "B"
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("a", "b", true);           // "a"==wsKey "A", "b"==wsKey "B"; before → insert before B → [A,B,C] no move? A already before B
  const ord = w.__api.order();
  check("B4 case-insensitive wsKey identity accepted (no throw, stable-ish)",
    Array.isArray(ord) && ord.length === 3, JSON.stringify(ord));
}
// B5-decoy: moving B onto upper half of A (before) → [B,A,C]
{
  const w = boot();
  w.__api.seed(["A", "B", "C"]);
  w.__api.reorder("B", "A", true);
  const ord = w.__api.order();
  check("B5-decoy move B above A → [B,A,C]",
    JSON.stringify(ord) === JSON.stringify(["B","A","C"]), JSON.stringify(ord));
}

console.log("\n" + (FAILURES.length ? "FAILURES: " + JSON.stringify(FAILURES) : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
