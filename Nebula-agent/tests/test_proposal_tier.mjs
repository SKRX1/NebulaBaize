/* 决策卡 proposal 的「推荐选项」双色分档（2026-10-20）。

诉求：把 next-steps 的「推荐 / 次级」双色调思路也用到决策卡（proposal）。

设计（真 index.html + 真 i18n.js + 真 app.js，jsdom 渲染）：
  proposal 的选项表里，模型用 verdict="推荐" 标注它最推荐的那一项（handleProposalAction 自动采纳也认这个）。
  现在把它做成和 next-steps 一致的两档：
    · verdict="推荐" 的选项 → 整行绿底 + 左侧绿条 + 实心「推荐」徽标 + 主按钮（绿，强调「该选这个」）；
    · 其余选项 → 中性灰、幽灵按钮（次级）。
  没有「推荐」选项时，所有行都保持中性。

锁住的契约：
  1. 推荐选项所在 <tr> 带 proposal__opt--rec，且标签正确；
  2. 推荐选项的 verdict 单元格带 proposal__verdict--rec 徽标，文案=「推荐」(zh)/"Recommended"(en)；
  3. 推荐行的「采纳」按钮是 st-btn--primary（绿），其余行是 st-btn--ghost（次级）；
  4. 没有任何「推荐」选项时，不存在 proposal__opt--rec；
  5. i18n 徽标文案 zh/en 存在。

Run: node tests/test_proposal_tier.mjs
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
const win = dom.window, doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "zh");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } },
  });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { renderProposals, proposalCardHtml, msgEl, dict: () => i18n._dict };`);
const api = win.__api;

function renderProposal(proposals) {
  const m = { role: "assistant", text: "done", time: Date.now(), proposals };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderProposals(el, m);
  return { m, el, box: el.querySelector(".proposals") };
}
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));

/* ═══════════ 1. 有推荐项 → 推荐行双色分档 ═══════════ */
console.log("\n=== 1: 含「推荐」选项 → 绿档分色 ===");
{
  const proposals = [{
    id: "p1", title: "如何部署", verified: false,
    options: [
      { label: "方案A", verdict: "推荐", pros: ["快"], cons: ["贵"] },
      { label: "方案B", verdict: "备选", pros: ["省"], cons: ["慢"] },
    ],
  }];
  const { box } = renderProposal(proposals);
  check("面板可见", box && box.hidden === false);
  const rows = qsa(box, ".proposal__opts tbody tr");
  check("两张选项卡都在", rows.length === 2, `n=${rows.length}`);
  const recRow = box.querySelector("tr.proposal__opt--rec");
  check("推荐行带 proposal__opt--rec", !!recRow);
  check("推荐行正是「方案A」", recRow && recRow.children[0].textContent.trim() === "方案A", recRow && recRow.children[0].textContent);
  const recBadge = recRow && recRow.querySelector(".proposal__verdict--rec");
  check("推荐行 verdict 为实心「推荐」徽标", !!recBadge && recBadge.textContent.trim() === "推荐", recBadge && recBadge.textContent);
  check("推荐行「采纳」按钮是主按钮（绿）", recRow && recRow.querySelector("[data-prop-act=adopt]").classList.contains("st-btn--primary"));
  const other = rows.find((r) => !r.classList.contains("proposal__opt--rec"));
  check("另一行不是推荐行（保持次级）", !!other && other.children[0].textContent.trim() === "方案B");
  check("另一行的「采纳」按钮是幽灵按钮", other && other.querySelector("[data-prop-act=adopt]").classList.contains("st-btn--ghost"));
  check("另一行 verdict 显示原始文案「备选」", other && other.querySelector(".proposal__verdict").textContent.trim() === "备选", other && other.querySelector(".proposal__verdict").textContent);
}

/* ═══════════ 2. 无推荐项 → 全部中性 ═══════════ */
console.log("\n=== 2: 无「推荐」选项 → 全中性 ===");
{
  const proposals = [{
    id: "p2", title: "选型", verified: true,
    options: [
      { label: "X", verdict: "可选", pros: ["a"], cons: ["b"] },
      { label: "Y", verdict: "可选", pros: ["c"], cons: ["d"] },
    ],
  }];
  const { box } = renderProposal(proposals);
  check("没有任何 proposal__opt--rec 行", box.querySelectorAll("tr.proposal__opt--rec").length === 0);
  const rows = qsa(box, ".proposal__opts tbody tr");
  check("两行都是幽灵按钮（次级）", rows.every((r) => r.querySelector("[data-prop-act=adopt]").classList.contains("st-btn--ghost")));
  check("两行 verdict 显示原始文案", rows.every((r) => r.querySelector(".proposal__verdict").textContent.trim() === "可选"));
}

/* ═══════════ 3. 英文文案：推荐徽标 = Recommended ═══════════ */
console.log("\n=== 3: 英文徽标文案 ===");
{
  const dict = api.dict();
  check("en 徽标=Recommended", dict.en["nextsteps.badge"] === "Recommended");
  // 切到英文渲染，确认推荐行徽标变 Recommended
  win.localStorage.setItem("strata.lang", "en");
  win.eval("i18n.setLang('en');");
  const proposals = [{ id: "p3", title: "Deploy", verified: false,
    options: [{ label: "A", verdict: "推荐", pros: ["fast"], cons: ["cost"] }] }];
  const { box } = renderProposal(proposals);
  const recBadge = box.querySelector(".proposal__verdict--rec");
  check("英文下推荐徽标显示 Recommended", recBadge && recBadge.textContent.trim() === "Recommended", recBadge && recBadge.textContent);
  win.localStorage.setItem("strata.lang", "zh");
  win.eval("i18n.setLang('zh');");
}

/* ═══════════ 4. i18n 徽标键存在 ═══════════ */
console.log("\n=== 4: i18n 文案 ===");
{
  const dict = api.dict();
  check("zh+en 都有 nextsteps.badge（proposal 复用该键）", !!dict.zh["nextsteps.badge"] && !!dict.en["nextsteps.badge"]);
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("PROPOSAL-TIER: ALL GREEN");
process.exit(0);
