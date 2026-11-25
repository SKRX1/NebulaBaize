/* 流式「建议 / 下一步建议 / 决策卡」三档好坏筛选（2026-10-20）。

诉求：AI 给出的建议要按好坏分三档 —— 推荐（值得做）置顶、可选（中性）居中、不推荐（坏处多/风险高）
排最后并标「不推荐」、但仍可点（由用户决定）。决策卡 proposal 同步：verdict="不推荐" 的行标琥珀排最后。

设计（真 index.html + 真 i18n.js + 真 app.js，jsdom 渲染）：
  · extractNextSteps：行首 * / • = 推荐，无符号 - / + = 可选，行首 ! = 不推荐（avoid）；
  · renderNextSteps：三组 推荐建议(绿,前) / 下一步建议(灰,中) / 不推荐建议(琥珀,后)，各自带徽标；
  · proposalCardHtml：verdict "推荐" → 绿行 + 绿徽标；"不推荐" → 琥珀行 + 琥珀徽标；中性 → 无特殊；
  · maybeAutoDrive：avoid 项永不被自动续跑（在 renderNextSteps 分组层已隔离，自动续跑也显式排除）。

锁住的契约：
  1. extractNextSteps 解析三档（* - !）且 ! 标 avoid、块从正文剥离；
  2. 混合列表 → 推荐组在可选组之前、可选组在不推荐组之前，徽标与 data-step 正确；
  3. 组合：仅不推荐 / 推荐+不推荐 / 可选+不推荐 各只有对应组、顺序正确；
  4. 选中 → chip 标 on 且出现发送/清除操作行；
  5. 空 steps → 面板隐藏；
  6. proposal：三档行样式与徽标正确，且"不推荐"行仍可点（保留采纳按钮）；
  7. i18n 新键 zh+en 齐全，徽标 zh=不推荐 / en=Not recommended。

Run: node tests/test_suggestion_tiers.mjs
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

win.eval(fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + ";Object.assign(window,{timeStr,fmtBytesSel,parsePlanItems,extractNextSteps,extractProposalsFromText,detectLang,firstPath,nextScopeUp,nextScopeDown,clone});");
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { extractNextSteps, renderNextSteps, proposalCardHtml, msgEl, setLang: i18n.setLang, dict: () => i18n._dict };
  // test hygiene: pin the render precondition (these test the tier LOGIC, which needs display ON)
settings.hideavoid = false;
`);;
const api = win.__api;
const dict = () => api.dict();

function renderSteps(steps, selSteps = []) {
  const m = { role: "assistant", text: "done", time: Date.now(), steps, selSteps: [...selSteps] };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return { m, el, box: el.querySelector(".next-steps") };
}
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));

/* ═══════════ 1. 解析三档（* - !）═══════════ */
console.log("\n=== 1: extractNextSteps 三档解析 ===");
{
  const src = "结论。\n```next-steps\n* 推荐项：说明\n- 可选项\n! 不推荐项\n• 另一推荐\n```\n附言";
  const r = api.extractNextSteps(src);
  check("推荐项（* 与 •）共 2 个", r.steps.filter((s) => s.recommended && !s.avoid).length === 2,
        JSON.stringify(r.steps.map((s) => s.recommended)));
  check("可选项（-）1 个", r.steps.filter((s) => !s.recommended && !s.avoid).length === 1);
  check("不推荐项（!）1 个且 avoid=true", r.steps.filter((s) => s.avoid && !s.recommended).length === 1,
        JSON.stringify(r.steps.map((s) => s.avoid)));
  const rec = r.steps.find((s) => s.label === "推荐项");
  check("带冒号拆成 label/detail", rec && rec.detail === "说明", rec && JSON.stringify(rec));
  const av = r.steps.find((s) => s.label === "不推荐项");
  check("! 行 avoid=true 且 recommended=false", av && av.avoid === true && av.recommended === false);
  check("```next-steps 块从正文剥离", !r.text.includes("next-steps") && r.text.includes("附言") && r.text.includes("结论"));
}

/* ═══════════ 2. 混合：推荐→可选→不推荐 顺序 + 徽标 + data-step ═══════════ */
console.log("\n=== 2: 三档分组与排序 ===");
{
  const steps = [
    { label: "R", recommended: true, avoid: false },
    { label: "N", recommended: false, avoid: false },
    { label: "X", recommended: false, avoid: true },
  ];
  const { box } = renderSteps(steps);
  const recG = box.querySelector(".next-steps__group--rec");
  const moreG = box.querySelector(".next-steps__group--rest");
  const avG = box.querySelector(".next-steps__group--avoid");
  check("有推荐组", !!recG); check("有可选组", !!moreG); check("有不推荐组", !!avG);
  const kids = Array.from(box.children);
  check("顺序 推荐 < 可选 < 不推荐", recG && moreG && avG &&
        kids.indexOf(recG) < kids.indexOf(moreG) && kids.indexOf(moreG) < kids.indexOf(avG),
        `${kids.indexOf(recG)},${kids.indexOf(moreG)},${kids.indexOf(avG)}`);
  const avChip = qsa(avG, ".next-step")[0];
  check("不推荐 chip 带「不推荐」徽标", avChip && avChip.querySelector(".next-step__badge") &&
        avChip.querySelector(".next-step__badge").textContent.trim() === "不推荐");
  check("不推荐 chip 有 next-step--avoid 类", avChip && avChip.classList.contains("next-step--avoid"));
  check("不推荐 chip 的 data-step 指向原始下标 2", avChip && avChip.dataset.step === "2", avChip && avChip.dataset.step);
  check("推荐 chip 数据与可选 chip 数据不偏移",
        qsa(recG, ".next-step")[0].dataset.step === "0" && qsa(moreG, ".next-step")[0].dataset.step === "1");
}

/* ═══════════ 3. 组合：仅不推荐 / 推荐+不推荐 / 可选+不推荐 ═══════════ */
console.log("\n=== 3: 组合分组 ===");
{
  let box = renderSteps([{ label: "X", avoid: true }]).box;
  check("仅不推荐 → 只有不推荐组", !!box.querySelector(".next-steps__group--avoid") &&
        !box.querySelector(".next-steps__group--rec") && !box.querySelector(".next-steps__group--rest"));

  box = renderSteps([{ label: "R", recommended: true }, { label: "X", avoid: true }]).box;
  check("推荐+不推荐 → 无可选(中间)组", !!box.querySelector(".next-steps__group--rec") &&
        !!box.querySelector(".next-steps__group--avoid") && !box.querySelector(".next-steps__group--rest"));
  const k2 = Array.from(box.children);
  check("推荐组排在不推荐组前", box.querySelector(".next-steps__group--rec") &&
        k2.indexOf(box.querySelector(".next-steps__group--rec")) < k2.indexOf(box.querySelector(".next-steps__group--avoid")));

  box = renderSteps([{ label: "N" }, { label: "X", avoid: true }]).box;
  check("可选+不推荐 → 可选为 solo 组且在不推荐前",
        !!box.querySelector(".next-steps__group--rest") && !!box.querySelector(".next-steps__group--avoid") &&
        !box.querySelector(".next-steps__group--rec") &&
        k2.length >= 0 && box.querySelector(".next-steps__group--rest") &&
        Array.from(box.children).indexOf(box.querySelector(".next-steps__group--rest")) <
        Array.from(box.children).indexOf(box.querySelector(".next-steps__group--avoid")));
}

/* ═══════════ 4. 选中 → on + 操作行（与三档并存）═══════════ */
console.log("\n=== 4: 多选与操作行 ===");
{
  const { box } = renderSteps([{ label: "R", recommended: true }, { label: "X", avoid: true }], [0]);
  const onChip = box.querySelector(".next-step--on");
  check("被选中 chip 带 on 类", !!onChip);
  check("选中的是 data-step=0（推荐项）", onChip && onChip.dataset.step === "0");
  const acts = box.querySelector(".next-steps__acts");
  check("出现发送/清除操作行", !!acts && !!acts.querySelector("[data-steps-send]") && !!acts.querySelector("[data-steps-clear]"));
}

/* ═══════════ 5. 空 → 隐藏 ═══════════ */
console.log("\n=== 5: 无建议时隐藏 ===");
{ check("面板 hidden", renderSteps([]).box.hidden === true); }

/* ═══════════ 6. proposal 三档 ═══════════ */
console.log("\n=== 6: proposal 决策卡三档 ===");
{
  const p = { id: "p1", title: "方案对比", verified: true,
    options: [
      { label: "A 增量", verdict: "推荐", pros: ["快"], cons: ["小改动"] },
      { label: "B 重写", verdict: "不推荐", pros: ["彻底"], cons: ["高风险", "丢现场"] },
      { label: "C 维持", pros: ["稳"], cons: ["不进步"] },
    ] };
  const host = doc.createElement("div");
  host.innerHTML = api.proposalCardHtml(p, 0);
  const rows = qsa(host, ".proposal__opts tbody tr");
  check("三个选项行都渲染", rows.length === 3, `n=${rows.length}`);
  const recRow = host.querySelector(".proposal__opt--rec");
  const avRow = host.querySelector(".proposal__opt--avoid");
  check("推荐行有 proposal__opt--rec", !!recRow);
  check("不推荐行有 proposal__opt--avoid", !!avRow);
  check("推荐行 verdict 徽标=推荐(绿)", recRow && recRow.querySelector(".proposal__verdict--rec") &&
        recRow.querySelector(".proposal__verdict--rec").textContent.trim() === "推荐");
  check("不推荐行 verdict 徽标=不推荐(琥珀)", avRow && avRow.querySelector(".proposal__verdict--avoid") &&
        avRow.querySelector(".proposal__verdict--avoid").textContent.trim() === "不推荐");
  check("不推荐行仍保留采纳按钮（可点）", avRow && !!avRow.querySelector('[data-prop-act="adopt"]'));
  check("推荐行用主按钮、不推荐行用幽灵按钮",
        recRow && recRow.querySelector(".st-btn--primary") && avRow && avRow.querySelector(".st-btn--ghost"));
}

/* ═══════════ 7. i18n 三档键 zh+en ═══════════ */
console.log("\n=== 7: i18n 文案 ===");
{
  for (const k of ["nextsteps.badge", "nextsteps.rec.title", "nextsteps.rec.sub",
                   "nextsteps.avoid.badge", "nextsteps.avoid.title", "nextsteps.avoid.sub",
                   "nextsteps.more.title", "nextsteps.solo.title"]) {
    check(`zh+en 都有 ${k}`, !!dict().zh[k] && !!dict().en[k]);
  }
  // 切到英文再验证徽标（t() 读闭包 lang，需经 setLang 切换）
  api.setLang("en");
  const enBadge = (() => { const m = { role: "assistant", text: "x\n```next-steps\n! z\n```", time: 0, steps: [], selSteps: [] };
    const el = api.msgEl(m, 0); doc.getElementById("chat").appendChild(el); api.renderNextSteps(el, { ...m, steps: [{ label: "z", avoid: true }] });
    const c = el.querySelector(".next-step--avoid .next-step__badge"); return c && c.textContent.trim(); })();
  check("英文下不推荐徽标=Not recommended", enBadge === "Not recommended", enBadge);
  api.setLang("zh");
  check("zh 不推荐徽标=不推荐", dict().zh["nextsteps.avoid.badge"] === "不推荐");
  check("zh 不推荐组标题=不推荐建议", dict().zh["nextsteps.avoid.title"] === "不推荐建议");
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("SUGGESTION-TIERS: ALL GREEN");
process.exit(0);   // app.js leaves a live-clock interval on the event loop
