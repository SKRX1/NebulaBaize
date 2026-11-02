/* 星云 working mark（顶部状态胶囊里的「她在干活」指示灯）。
 *
 * 要锁的三件事：
 *  1) 结构：一个核心 + 五颗星尘（两颗偏亮）+ 一圈环，落在 #pill-neb 里；
 *  2) 语义：引擎状态 → 星云状态。关键一条是「回合还活着但引擎在等工具时不能假装空闲」，
 *     也就是 working && idle 必须映射成 tool（慢速仍转），否则长工具看起来像智能体死了；
 *  3) 转速跟真实吞吐联动（setNebSpin），且非 generating 状态要撤掉内联转速、回到各状态自己的节奏。
 *
 * 另外用 CSS 契约锁住「静止 = 完全不动」：idle 状态绝不能有 animation 规则，
 * 否则「在工作 / 静止」这个区分就没了。
 *
 * Run: node tests/test_nebula.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `\n;window.__api = { setPill, setNebSpin, setNebTask, bumpNebDone, nebTaskFromTool };`;
win.eval(appCode);
const api = win.__api;

// ── 1) structure ─────────────────────────────────────────────────────────────
console.log("\n=== 1: pill carries one core, five specks and a ring ===");
{
  const neb = doc.getElementById("pill-neb");
  check("nebula exists inside the status pill", !!neb);
  check("sits in #pill", !!doc.getElementById("pill") && !!doc.getElementById("pill").querySelector("#pill-neb"));
  check("viewBox is 24x24", neb.getAttribute("viewBox") === "0 0 24 24");
  check("five specks", neb.querySelectorAll(".neb-p").length === 5, `got ${neb.querySelectorAll(".neb-p").length}`);
  check("two of them read brighter", neb.querySelectorAll(".neb-p--hi").length === 2);
  check("exactly one core", neb.querySelectorAll(".neb-core").length === 1);
  check("exactly one ring", neb.querySelectorAll(".neb-ring").length === 1);
  check("core sits behind the specks (specks in .neb-orbit)", neb.querySelector(".neb-orbit") === neb.querySelectorAll(".neb-p")[0].parentNode);
  check("no leftover dot element", !doc.querySelector(".st-pill__dot"));
}

// ── 2) state mapping ─────────────────────────────────────────────────────────
console.log("\n=== 2: engine state -> nebula state ===");
{
  const neb = doc.getElementById("pill-neb");
  const pill = doc.getElementById("pill");
  api.setPill("generating", "生成中 · 20.0 tok/s", true);
  check("generating", neb.dataset.state === "generating" && pill.dataset.state === "generating");
  api.setPill("reading", "读取中", true);
  check("reading", neb.dataset.state === "reading");
  api.setPill("idle", "空闲", false);
  check("idle with no turn = 静止 (idle)", neb.dataset.state === "idle");
  api.setPill("idle", "空闲", true);
  check("idle while a turn is alive = tool (keeps orbiting)", neb.dataset.state === "tool");
  api.setPill("queued", "2 排队", false);
  check("queued", neb.dataset.state === "queued");
  api.setPill("error", "Server not reachable", false);
  check("error maps to queued (and does not throw)", neb.dataset.state === "queued" && pill.dataset.state === "queued");
  check("pill text is still written", doc.getElementById("pill-text").textContent === "Server not reachable");
}

// ── 3) tempo follows real throughput ─────────────────────────────────────────
console.log("\n=== 3: orbit tempo follows tok/s ===");
{
  const neb = doc.getElementById("pill-neb");
  api.setPill("generating", "生成中", true);
  api.setNebSpin(40);
  check("40 tok/s -> 2.60s", neb.style.getPropertyValue("--neb-spin") === "2.60s", neb.style.getPropertyValue("--neb-spin"));
  api.setNebSpin(0);
  check("0 tok/s -> 5.20s", neb.style.getPropertyValue("--neb-spin") === "5.20s", neb.style.getPropertyValue("--neb-spin"));
  api.setNebSpin(999);
  check("clamped at 40 tok/s", neb.style.getPropertyValue("--neb-spin") === "2.60s");
  api.setNebSpin(undefined);
  check("undefined tok_s does not throw, falls back to slow", neb.style.getPropertyValue("--neb-spin") === "5.20s");
  api.setPill("reading", "读取中", true);
  check("leaving generating drops the inline tempo", neb.style.getPropertyValue("--neb-spin") === "");
}

// ── 4) CSS contract: 静止 must be truly frozen ───────────────────────────────
console.log("\n=== 4: CSS contract (working animates, idle is frozen) ===");
{
  check("orbit spins via neb-spin", /\.nebula\[data-state="generating"\] \.neb-orbit\s*\{[^}]*neb-spin/.test(css)
        || /\.nebula\[data-state="generating"\] \.neb-orbit,/.test(css));
  check("core breathes", /@keyframes neb-breathe/.test(css) && /\.nebula\[data-state="generating"\] \.neb-core/.test(css));
  check("idle has NO animation rule", !/\.nebula\[data-state="idle"\][^{]*\{[^}]*animation:/.test(css));
  check("transform-origin is view-box (SVG rotates around its centre)",
        /\.nebula \.neb-orbit\s*\{[^}]*transform-box:\s*view-box/.test(css));
  check("reduced motion freezes the mark", /prefers-reduced-motion: reduce\)\s*\{[^}]*\.nebula \.neb-orbit/.test(css));
  check("the four working states all orbit", ["generating", "reading", "queued", "tool"]
        .every((s) => css.includes(`.nebula[data-state="${s}"] .neb-orbit`)));
}

// ── 5) CSS contract: streaming caret == the same nebula ─────────────────────
console.log("\n=== 5: the streaming caret is the same nebula ===");
{
  check("bubble caret exists", /\.cursor::after/.test(css));
  check("caret hangs off the last paragraph", /\.cursor > \.ans > \.ans-md:last-child p:last-child::after/.test(css));
  check("no duplicate caret below the paragraph", /\.cursor:has\(> \.ans > \.ans-md:last-child p:last-child\)::after\s*\{\s*content:\s*none/.test(css));
  check("caret is painted with gradients, not a solid bar", /\.cursor::after,[\s\S]{0,400}radial-gradient/.test(css));
  check("caret orbit keyframes exist", /@keyframes neb-caret/.test(css));
  check("old bouncing bar is gone", !/\.cursor::after\s*\{[^}]*height:\s*1\.1em/.test(css));
  check("caret stays dynamic - never frozen under reduced motion (product decision: always dynamic)", /@keyframes neb-caret/.test(css) && !/prefers-reduced-motion:[\s\S]{0,160}\.cursor[\s\S]{0,80}animation:\s*none/.test(css));
}

// ── 6) 无脸金黄星云：动态承载在核心/轨道/道具上（表情已删除，与左上角同源） ──
console.log("\n=== 6: faceless golden nebula — state lives in motion, not a face ===");
{
  const neb = doc.getElementById("pill-neb");
  // 无脸校验：脸盘 / 眼 / 嘴 / 腮红全部不存在（状态改由动态表达）
  check("faceless: no face disc", !neb.querySelector(".neb-body"));
  check("faceless: no eyes", neb.querySelectorAll(".neb-eye").length === 0);
  check("faceless: no mouths", neb.querySelectorAll(".m").length === 0);
  check("faceless: no cheeks", !neb.querySelector(".neb-cheek"));
  // 骨架仍是金黄星云：核心承载动态，任务道具组仍在
  check("core is the dynamic carrier", !!neb.querySelector(".neb-core") &&
        /\.nebula \.neb-core\s*\{[^}]*transform-box:\s*fill-box/.test(css));
  check("task props group present", !!neb.querySelector(".neb-prop"));

  // idle = 完全静止（无 animation），状态由「核心呼吸发光 / 转速 / 道具」区分
  check("idle has no animation (still = 静止)", !/\.nebula\[data-state="idle"\][^{]*\{[^}]*animation:/.test(css));
  check("generating core breathes + glows", /neb-breathe/.test(css) &&
        /\.nebula\[data-state="generating"\] \.neb-core\s*\{[^}]*filter:/.test(css));
  check("reading scans left/right (core)", /neb-look/.test(css) &&
        /\.nebula\[data-state="reading"\] \.neb-core\s*\{[^}]*animation:\s*neb-look/.test(css));
  check("queued gently pulses (core)", /neb-pulse/.test(css) &&
        /\.nebula\[data-state="queued"\] \.neb-core\s*\{[^}]*animation:\s*neb-pulse/.test(css));
  check("error startles: core shakes", /neb-shake/.test(css) &&
        /\.nebula\[data-state="error"\] \.neb-core\s*\{[^}]*animation:\s*neb-shake/.test(css));
  check("error shows a sweat drop", /\.nebula\[data-state="error"\] \.p-sweat\s*\{\s*display:\s*block/.test(css));
  // done：核心弹一下 + 星光炸开 + 金光
  check("done celebrates: core bounce + sparkle",
        /neb-bounce/.test(css) &&
        /\.nebula\[data-state="done"\] \.neb-core\s*\{[^}]*animation:\s*neb-bounce/.test(css) &&
        /\.nebula\[data-state="done"\] \.p-spark/.test(css));

  // 任务形态：不同工具 → 不同道具
  check("search shows a magnifier", /\.nebula\[data-task="search"\] \.p-search\s*\{\s*display:\s*block/.test(css));
  check("code shows a pencil", /\.nebula\[data-task="code"\] \.p-code\s*\{\s*display:\s*block/.test(css));
  check("shell shows a cog", /\.nebula\[data-task="shell"\] \.p-shell\s*\{\s*display:\s*block/.test(css));
  check("image shows a star", /\.nebula\[data-task="image"\] \.p-image\s*\{\s*display:\s*block/.test(css));
}

// ── 7) 运行时：data-task / done 由 app 代码正确驱动 ───────────────────────────
console.log("\n=== 7: runtime drives task expression + done flash ===");
{
  const neb = doc.getElementById("pill-neb");
  // 工具运行时（busy + 引擎 idle ⇒ mark=tool）叠加任务形态
  api.setNebTask("search");
  api.setPill("idle", "执行中", true);
  check("tool + active task -> data-task=search", neb.dataset.task === "search" && neb.dataset.state === "tool");
  api.setNebTask("code");
  api.setPill("idle", "执行中", true);
  check("switching tool updates data-task", neb.dataset.task === "code");
  api.setPill("idle", "空闲", false);
  check("no task when idle & quiet -> data-task cleared", neb.dataset.task === "");
  // 完成态是瞬时覆盖
  api.bumpNebDone();
  api.setPill("idle", "空闲", false);
  check("done flash overrides to 'done'", neb.dataset.state === "done");
  // 工具名 → 形态 的归类
  check("tool 'web_search' -> search", api.nebTaskFromTool("web_search") === "search");
  check("tool 'fs_write' -> code", api.nebTaskFromTool("fs_write") === "code");
  check("tool 'shell_exec' -> shell", api.nebTaskFromTool("shell_exec") === "shell");
  check("tool 'image_generate' -> image", api.nebTaskFromTool("image_generate") === "image");
}

console.log("");
if (FAILURES.length) {
  console.log(`NEBULA: ${FAILURES.length} FAILED -> ${FAILURES.join(" | ")}`);
  process.exit(1);
} else {
  console.log("NEBULA: ALL PASSED");
  process.exit(0);
}
