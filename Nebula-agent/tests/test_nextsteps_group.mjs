/* 流式「建议 / 下一步建议」面板重排（2026-10-20）。

诉求：推荐建议要排在第一位、标「推荐」二字、并用不同颜色区分 AI 提出的几类建议。

设计（真 index.html + 真 i18n.js + 真 app.js，jsdom 渲染）：
  旧：所有 chip 都是同一种绿色，推荐项仅多一个小圆点，组标题只有一行「建议下一步」。
  新：拆成两组 ——
    · 推荐建议（绿系，副标题「AI 推荐 · 优先采纳」），每个推荐 chip 带实心「推荐」徽标，排在最前；
    · 下一步建议（中性灰系，副标题「点击可多选」），普通 chip 无徽标，排在推荐组之后。
  没有推荐项时只显示「下一步建议」组（solo 标题），全是推荐项时只显示「推荐建议」组。
  data-step 仍指向原始下标，多选 / 合并发送 / 自动续跑逻辑不变。

锁住的契约：
  1. extractNextSteps：行首 * / • 标推荐，- / + 不标；能拆出 label：detail；块从正文剥离；
  2. 混合列表 → 推荐组在次要组之前，且各自 chip 数正确；
  3. 推荐 chip 都带「推荐」徽标，次要 chip 无徽标；
  4. 推荐 / 次要 chip 的 data-step 精确指向原始推荐 / 次要项（多选映射不偏移）；
  5. 全推荐 → 只有「推荐建议」组；无推荐 → 只有「下一步建议」组（solo 标题）；
  6. 选中 → chip 标 on 且出现发送 / 清除操作行；
  7. 空 steps → 面板隐藏；
  8. i18n 新键 zh+en 齐全，徽标文案 zh=推荐 / en=Recommended。

Run: node tests/test_nextsteps_group.mjs
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
;window.__api = { renderNextSteps, extractNextSteps, msgEl, dict: () => i18n._dict };
;window.__setHideavoid = (v) => { settings.hideavoid = v; };
;window.__initialHideavoid = settings.hideavoid;`);
const api = win.__api;

function renderSteps(steps, selSteps = []) {
  const m = { role: "assistant", text: "done", time: Date.now(), steps, selSteps: [...selSteps] };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return { m, el, box: el.querySelector(".next-steps") };
}
const qsa = (root, sel) => Array.from(root.querySelectorAll(sel));

/* ═══════════ 1. 解析：行首 * / • 标推荐，能拆出 label：detail ═══════════ */
console.log("\n=== 1: extractNextSteps 解析 ===");
{
  const src = "结论。\n```next-steps\n* 立即备份：把当前账本导出\n- 稍后核对余额\n• 优先修复登录\n+ 其它事项\n```\n附言";
  const r = api.extractNextSteps(src);
  check("推荐项被正确标记（* 与 • 共 2 个）",
        r.steps.filter((s) => s.recommended).length === 2,
        JSON.stringify(r.steps.map((s) => s.recommended)));
  check("非推荐项（- 与 +）未被标记", r.steps.filter((s) => !s.recommended).length === 2);
  const bk = r.steps.find((s) => s.label === "立即备份");
  check("带冒号的被拆成 label/detail", bk && bk.detail === "把当前账本导出", bk && JSON.stringify(bk));
  check("```next-steps 块从正文剥离（正文只剩结论+附言）",
        !r.text.includes("next-steps") && r.text.includes("附言") && r.text.includes("结论"),
        JSON.stringify(r.text));
}

/* ═══════════ 2. 混合：推荐组在前、次要组在后，徽标与 data-step 正确 ═══════════ */
console.log("\n=== 2: 混合列表分组与排序 ===");
{
  const steps = [
    { label: "R1", detail: "", recommended: true },
    { label: "N1", detail: "", recommended: false },
    { label: "R2", detail: "", recommended: true },
    { label: "N2", detail: "", recommended: false },
  ];
  const { box } = renderSteps(steps);
  check("面板可见", box && box.hidden === false);
  const recG = box.querySelector(".next-steps__group--rec");
  const restG = box.querySelector(".next-steps__group--rest");
  check("有「推荐建议」组", !!recG);
  check("有「下一步建议」组", !!restG);
  const kids = Array.from(box.children);
  check("推荐组排在次要组之前", recG && restG && kids.indexOf(recG) < kids.indexOf(restG),
        `${kids.indexOf(recG)} < ${kids.indexOf(restG)}`);
  const recChips = qsa(recG, ".next-step");
  const restChips = qsa(restG, ".next-step");
  check("推荐组恰好 2 个 chip", recChips.length === 2, `n=${recChips.length}`);
  check("次要组恰好 2 个 chip", restChips.length === 2, `n=${restChips.length}`);
  check("推荐 chip 都带「推荐」徽标", recChips.every((c) => {
    const b = c.querySelector(".next-step__badge");
    return b && b.textContent.trim() === "推荐";
  }));
  check("次要 chip 没有徽标", restChips.every((c) => !c.querySelector(".next-step__badge")));
  const recIdx = recChips.map((c) => +c.dataset.step).sort();
  const restIdx = restChips.map((c) => +c.dataset.step).sort();
  check("推荐 chip 的 data-step 指向原始推荐项 (0,2)", JSON.stringify(recIdx) === "[0,2]", JSON.stringify(recIdx));
  check("次要 chip 的 data-step 指向原始次要项 (1,3)", JSON.stringify(restIdx) === "[1,3]", JSON.stringify(restIdx));
}

/* ═══════════ 3. 全是推荐 → 只显示「推荐建议」组 ═══════════ */
console.log("\n=== 3: 全推荐，无次要组 ===");
{
  const { box } = renderSteps([{ label: "A", recommended: true }, { label: "B", recommended: true }]);
  check("有「推荐建议」组", !!box.querySelector(".next-steps__group--rec"));
  check("没有「下一步建议」空组", !box.querySelector(".next-steps__group--rest"));
  check("两个推荐 chip 都有徽标", qsa(box, ".next-step").every((c) => c.querySelector(".next-step__badge")));
}

/* ═══════════ 4. 无推荐 → 只显示「下一步建议」组（solo 标题） ═══════════ */
console.log("\n=== 4: 无推荐，solo 组 ===");
{
  const { box } = renderSteps([{ label: "X", recommended: false }, { label: "Y", recommended: false }]);
  check("没有「推荐建议」组", !box.querySelector(".next-steps__group--rec"));
  const g = box.querySelector(".next-steps__group--rest");
  check("有「下一步建议」组", !!g);
  const dict = api.dict();
  check("solo 标题为「建议下一步」",
        g && g.querySelector(".next-steps__title").textContent.trim() === dict.zh["nextsteps.solo.title"],
        g && g.querySelector(".next-steps__title").textContent);
}

/* ═══════════ 5. 选中 → chip 标 on，且出现发送 / 清除操作行 ═══════════ */
console.log("\n=== 5: 多选与操作行 ===");
{
  const { box } = renderSteps([{ label: "R1", recommended: true }, { label: "N1", recommended: false }], [0]);
  const onChip = box.querySelector(".next-step--on");
  check("被选中的 chip 带 on 类", !!onChip);
  check("选中的是 data-step=0", onChip && onChip.dataset.step === "0");
  const acts = box.querySelector(".next-steps__acts");
  check("出现发送 / 清除操作行",
        !!acts && !!acts.querySelector("[data-steps-send]") && !!acts.querySelector("[data-steps-clear]"));
}

/* ═══════════ 6. 空 steps → 面板隐藏 ═══════════ */
console.log("\n=== 6: 无建议时面板隐藏 ===");
{
  const { box } = renderSteps([]);
  check("面板 hidden", box && box.hidden === true);
}

/* ═══════════ 7. i18n 新键 zh+en 齐全，徽标文案存在 ═══════════ */
console.log("\n=== 7: i18n 文案 ===");
{
  const dict = api.dict();
  for (const k of ["nextsteps.badge", "nextsteps.rec.title", "nextsteps.rec.sub",
                   "nextsteps.more.title", "nextsteps.more.sub", "nextsteps.solo.title", "nextsteps.solo.sub"])
    check(`zh+en 都有 ${k}`, !!dict.zh[k] && !!dict.en[k]);
  check("zh 徽标=「推荐」，en=Recommended",
        dict.zh["nextsteps.badge"] === "推荐" && dict.en["nextsteps.badge"] === "Recommended");
  check("zh 推荐组标题=「推荐建议」", dict.zh["nextsteps.rec.title"] === "推荐建议");
}

/* ═══ 8. hideavoid: ON hides the not-recommended tier, OFF shows it (default) ═══ */
console.log("\n=== 8: hideavoid toggle (default OFF = show; ON = hide the avoid tier) ===");
{
  const steps = [{ label: "R", recommended: true }, { label: "A", avoid: true }];
  win.__setHideavoid(false);
  let { box } = renderSteps(steps);
  check("OFF (default): avoid tier still rendered", !!box.querySelector(".next-steps__group--avoid"));
  check("OFF: recommended tier present", !!box.querySelector(".next-steps__group--rec"));
  win.__setHideavoid(true);
  ;({ box } = renderSteps(steps));
  check("ON: avoid tier hidden", !box.querySelector(".next-steps__group--avoid"));
  check("ON: other tiers (recommended) still render", !!box.querySelector(".next-steps__group--rec"));
  win.__setHideavoid(true);
  ;({ box } = renderSteps([{ label: "A", avoid: true }]));
  check("ON + only-avoid tier -> panel collapses (no blank bar)", !!box && box.hidden === true);
  win.__setHideavoid(false);
}

/* ═══ 9. hideavoid DEFAULT = ON (2026-11-13 flip): a fresh profile (no stored value) defaults to HIDING the not-recommended tier ═══ */
/*  This locks the DEFAULT itself (section 8 drives it by explicit set, so a default drift would go uncaught).
    Load-bearing differential: the same input renders WITH the avoid tier when the flag is OFF and WITHOUT it
    when ON; the fresh-profile default is ON, so it renders WITHOUT. */
console.log("\n=== 9: hideavoid default ON = the avoid tier is hidden by default (differential) ===");
{
  check("DEFAULT (fresh profile, no stored value) hideavoid === true", win.__initialHideavoid === true, String(win.__initialHideavoid));
  const steps = [{ label: "R", recommended: true }, { label: "A", avoid: true }];
  // ship default path (ON) -> avoid hidden
  win.__setHideavoid(true);
  let { box } = renderSteps(steps);
  check("DEFAULT-ON: avoid tier NOT rendered (hidden)", !box.querySelector(".next-steps__group--avoid"));
  check("DEFAULT-ON: recommended tier still renders (load-bearing: only the avoid tier is filtered)", !!box.querySelector(".next-steps__group--rec"));
  // differential control (explicit OFF) -> avoid shows again
  win.__setHideavoid(false);
  ;({ box } = renderSteps(steps));
  check("DIFFERENTIAL OFF: avoid tier renders again (the flag is load-bearing, not decorative)", !!box.querySelector(".next-steps__group--avoid"));
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("NEXTSTEPS-GROUP: ALL GREEN");
process.exit(0);   // mirrors seed test: app.js leaves a live-clock interval on the event loop
