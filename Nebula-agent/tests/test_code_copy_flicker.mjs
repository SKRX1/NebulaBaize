/* Regression test for the "code-card copy button flickers while generating" bug.
 *
 * Bug this pins: the copy button at the top-right of a fenced code block (e.g. a
 * ```propose-experience``` fence) visibly flickered WHILE the answer was still generating.
 * Cause: paintMd wrote `node.innerHTML = markdown(src)` on every streaming paint, and that
 * tore down + rebuilt the whole DOM subtree including the .st-code card. The copy button itself
 * has NO animation (components.css: only `transition: opacity`) — the flicker was the rebuild:
 * the re-created <use href=sprite> re-resolves its icon asynchronously (empty frame -> pop), and
 * on hover the opacity transition restarted every frame. Same family as test_stats_flicker.mjs.
 *
 * The fix routes both paintMd rewrite paths through setMdHtml, which preserves each code card's
 * HEAD (language label + copy button) by DOM identity across the innerHTML rewrite (keyed by
 * position + unchanged language label); only the <pre> body stays fresh. The sharpest pin is
 * IDENTITY: the same `.st-code__copy` button node must survive many streaming repaints.
 * The OLD code failed this because it rebuilt.
 *
 * Boots the REAL app.js + i18n.js in jsdom; drives paintMd directly (no stream needed).
 * Run: node tests/test_code_copy_flicker.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

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
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `\n;window.__api = { markdown, setMdHtml, paintMd, MARKDOWN_LONG, STREAM_RENDER_MS };`;
win.eval(appCode);
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const api = win.__api;

// ── 1) streaming a growing code block: the copy button must keep its DOM identity ──
console.log("\n=== 1: streaming code-block copy button survives repaints (no rebuild) ===");
{
  const node = doc.createElement("div");
  node.className = "ans-md";
  doc.getElementById("chat").appendChild(node);

  // stream the fence in chunk by chunk (below MARKDOWN_LONG so every paint is a rewrite)
  const chunks = [
    "```propose-experience\n",
    "```propose-experience\n上下文：\n",
    "```propose-experience\n上下文：给绘图前后\n",
    "```propose-experience\n上下文：给绘图前后 sparkline\n",
    "```propose-experience\n上下文：给绘图前后 sparkline 加冻结历史柱\n",
    "```propose-experience\n上下文：给绘图前后 sparkline 加冻结历史柱+分隔线\n",
  ];
  for (const c of chunks) api.paintMd(node, c, true);

  const card = node.querySelector(".st-code");
  const head = card && card.querySelector(".st-code__head");
  const copy = card && card.querySelector(".st-code__copy");
  const lang = head && head.querySelector(".st-code__lang");
  check("code card rendered", !!card);
  check("head rendered", !!head);
  check("copy button rendered", !!copy);
  check("language label rendered", !!lang && /propose-experience/i.test(lang.textContent || ""), lang && lang.textContent);

  // keep streaming MORE text: each paint rebuilds innerHTML; the copy button must SURVIVE it
  const beforeCopy = copy, beforeLang = lang;
  for (let i = 0; i < 6; i++) api.paintMd(node, chunks[5] + " · 追加行" + i + "\n", true);

  const copyAfter = node.querySelector(".st-code__copy");
  const langAfter = node.querySelector(".st-code__lang");
  check("copy button is the SAME node across repaints (not rebuilt)", copyAfter === beforeCopy);
  check("language label is the SAME node (same DOM identity as copy)", langAfter === beforeLang);

  // the PRE body must reflect the newest text (so we did NOT freeze the whole card)
  const pre = node.querySelector(".st-code pre");
  check("pre body reflects the LATEST text", pre && /追加行5/.test(pre.textContent || ""), pre && pre.textContent && pre.textContent.slice(0, 60));

  el_clean(node);
}

// ── 2) language label changes -> head is allowed to be fresh (correct, not a bug) ──
console.log("\n=== 2: language label change rebuilds the head (expected) ===");
{
  const node = doc.createElement("div");
  node.className = "ans-md";
  doc.getElementById("chat").appendChild(node);

  api.paintMd(node, "```python\nx = 1\n```", true);
  let copy = node.querySelector(".st-code__copy");
  check("python code block has a copy button", !!copy);

  // same code text but the fence language label changes -> new head is legitimately correct
  api.paintMd(node, "```javascript\nx = 1\n```", true);
  const copy2 = node.querySelector(".st-code__copy");
  check("language label updated to javascript", /javascript/i.test(node.querySelector(".st-code__lang").textContent || ""));
  check("body still has exactly one code card", node.querySelectorAll(".st-code").length === 1);
  // identity MAY change here (label changed); assert only that we still have exactly one copy button
  check("exactly one copy button (no duplicate from a bad move-back)", node.querySelectorAll(".st-code__copy").length === 1);
  void copy2;

  el_clean(node);
}

// ── 3) two code cards: each head preserved by POSITION+label, no cross-contamination ──
console.log("\n=== 3: multiple code cards each keep their own head identity ===");
{
  const node = doc.createElement("div");
  node.className = "ans-md";
  doc.getElementById("chat").appendChild(node);

  const base = "```python\nfirst\n```\n\ntext\n\n```python\nsecond\n```";
  api.paintMd(node, base, true);
  const cards = node.querySelectorAll(".st-code");
  check("two code cards rendered", cards.length === 2, String(cards.length));
  const copy0 = cards[0].querySelector(".st-code__copy");
  const copy1 = cards[1].querySelector(".st-code__copy");
  check("both have copy buttons", !!copy0 && !!copy1 && copy0 !== copy1);

  // grow the LAST card's body; both heads must survive at their positions
  api.paintMd(node, base + " grown", true);
  const cards2 = node.querySelectorAll(".st-code");
  check("still two cards", cards2.length === 2);
  check("card#0 copy button SAME node", cards2[0].querySelector(".st-code__copy") === copy0);
  check("card#1 copy button SAME node", cards2[1].querySelector(".st-code__copy") === copy1);
  check("card#1 body grew", /grown/.test(cards2[1].querySelector("pre").textContent || ""));

  el_clean(node);
}

// ── 4) plain rewrite path (>MARKDOWN_LONG incremental) also preserves identity ──
console.log("\n=== 4: incremental (> MARKDOWN_LONG) path preserves copy-button identity ===");
{
  const node = doc.createElement("div");
  node.className = "ans-md";
  doc.getElementById("chat").appendChild(node);
  // build a long prefix so length crosses MARKDOWN_LONG and we exercise the _pb / tail path,
  // with a code card sitting in the frozen prefix region.
  const filler = "para ".repeat(api.MARKDOWN_LONG);   // comfortably over the threshold
  const base = "```python\nalpha\n```\n\n" + filler + "\n\ntail";
  api.paintMd(node, base, true);
  const copy = node.querySelector(".st-code__copy");
  check("long-content path rendered a code card + copy button", !!copy);
  api.paintMd(node, base + " tail more tail", true);
  check("copy button SAME node across incremental repaint", node.querySelector(".st-code__copy") === copy);
  el_clean(node);
}

function el_clean(n) { try { n.remove(); } catch (_) {} }

console.log("");
if (FAILURES.length) {
  console.log("CODE COPY FLICKER: " + FAILURES.length + " FAILED");
  FAILURES.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("CODE COPY FLICKER: ALL PASSED");
process.exit(0);   // jsdom keeps polling timers alive; end explicitly
