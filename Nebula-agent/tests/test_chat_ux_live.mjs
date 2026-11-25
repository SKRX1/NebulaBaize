/* Live browser test for the two chat-UX fixes (parasitic mode, real renderer):
 *
 *   1. Next-step suggestion chips are MULTI-SELECT: clicking toggles a selection
 *      (not an immediate send), and an action row sends the picked items together.
 *   2. The rules-draft approval banner is EXPANDABLE: it lists the actual proposed
 *      conventions with per-item checkboxes, so the human can judge BEFORE merging;
 *      a partial merge keeps the un-approved lines in the draft (data-loss guard).
 *
 * A throwaway session in a scratch workspace is seeded through localStorage, and the
 * draft file is seeded through the real filesystem MCP. Nothing outside the scratch
 * dir is touched; the dir is removed at the end.
 *
 * Run: node tests/test_chat_ux_live.mjs   (needs Strata on 127.0.0.1:8080)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8080";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WS = path.join(HERE, "_scratch_ux");
const SHOTS = path.join(HERE, "_scratch_ux_shots");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const DRAFT = [
  "探活失败必须在 10 秒内返回，不能干等超时",
  "部署用 cp 逐文件加 MD5 校验，不用 robocopy",
  "改完前端必须硬刷新验证",
];

const mcp = async (server, tool, args) => {
  const r = await fetch(BASE + "/mcp/call", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server, tool, args }),
  });
  return r.json();
};

const main = async () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  // seed the pending draft through the real filesystem MCP (proves the file the UI reads)
  const seeded = await mcp("filesystem", "write",
    { path: WS + "\\RULES.draft.md", content: DRAFT.join("\n") });
  if (!seeded.ok) { console.log("SKIP: cannot seed the draft via filesystem MCP:", seeded.text); return 0; }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) jsErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")
        && !r.url().endsWith("/config.json")) {
      jsErrors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  const steps = [
    { label: "浏览器实玩一轮", detail: "打开 index.html 玩一轮反馈手感" },
    { label: "做一次性能压测", detail: "" },
    { label: "横屏适配", detail: "把静音状态与最高分持久化" },
  ];
  const msgs = [
    { role: "user", text: "做完了" },
    { role: "assistant", text: "好的，任务完成。", steps },
  ];
  // NOTE: addInitScript passes its arguments as ONE array, so take a single object.
  // (A destructured (a, b, c) signature silently receives undefined for b/c, and
  // JSON.stringify(undefined) then stores the literal string "undefined".)
  await page.addInitScript((seed) => {
    seed.sessions[0].workspace = seed.ws;
    localStorage.setItem("strata.sessions", JSON.stringify(seed.sessions));
    localStorage.setItem("strata.session.active", JSON.stringify(seed.active));
    localStorage.setItem("strata.chat", JSON.stringify(seed.chat));
  }, { sessions: [{ id: "ux1", title: "UX 验证", permission: "full", messages: msgs }],
       active: "ux1", chat: msgs, ws: WS });

  console.log("=== 1. 下一步建议：多选 chips ===");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.waitForSelector(".next-steps .next-step", { timeout: 20000 });
  const chipSel = (i) => `.next-steps .next-step >> nth=${i}`;
  const chipState = () => page.$$eval(".next-step", (els) =>
    els.map((e) => `${e.dataset.step}:${e.classList.contains("next-step--on") ? "on" : "off"}`).join(","));
  check("每条建议渲染为一个 chip", (await page.$$(".next-steps .next-step")).length === 3);
  check("未选中时没有动作条", !(await page.$("[data-steps-send]")));

  await page.click(chipSel(0));
  await page.waitForTimeout(250);
  check("点击 chip 进入选中态（不再即发）", /0:on/.test(await chipState()), await chipState());
  check("选中态有 aria-pressed", (await page.$eval(".next-step--on", (el) => el.getAttribute("aria-pressed"))) === "true");
  const sendBtn = await page.textContent("[data-steps-send]");
  check("动作条显示已选数量", /发送所选的 1 项/.test(sendBtn), sendBtn);

  await page.click(chipSel(2));
  await page.waitForTimeout(250);
  const sendBtn2 = await page.textContent("[data-steps-send]");
  check("第二个 chip 也可选中（多选）", /发送所选的 2 项/.test(sendBtn2), sendBtn2);
  check("两个 chip 同时高亮", (await page.$$(".next-step--on")).length === 2, await chipState());

  await page.click(chipSel(0));
  await page.waitForTimeout(250);
  check("再点一次取消选中", (await page.$$(".next-step--on")).length === 1, await chipState());
  await page.screenshot({ path: path.join(SHOTS, "chips_selected.png") });

  await page.click("[data-steps-clear]");
  await page.waitForTimeout(250);
  check("清除按钮清空选择", !(await page.$("[data-steps-send]")) && (await page.$$(".next-step--on")).length === 0);

  console.log("\n=== 2. 审批横幅：展开可见内容 + 逐条勾选 ===");
  // clicking the session row re-runs loadRulesState, exactly like a real session switch
  await page.click('[data-sid="ux1"]');
  await page.waitForSelector("#rules-draft-banner:not([hidden])", { timeout: 15000 });
  const bannerTitle = await page.textContent("#rules-draft-title");
  check("横幅显示待审数量", /3 条工作约定/.test(bannerTitle), bannerTitle);
  check("面板默认折叠", await page.$eval("#rules-draft-body", (el) => el.hidden));

  await page.click("#rules-draft-peek");
  await page.waitForSelector("#rules-draft-body:not([hidden])", { timeout: 5000 });
  const rows = await page.$$("#rules-draft-body [data-rd-i]");
  check("展开后列出全部待审约定", rows.length === 3, `${rows.length} rows`);
  const rowTexts = await page.$$eval("#rules-draft-body .rd-row__txt", (els) => els.map((e) => e.textContent));
  check("每条约定的正文可见（不再是只有一个数字）", DRAFT.every((d) => rowTexts.some((r) => r.includes(d))), rowTexts.join(" | ").slice(0, 120));
  check("默认全部勾选", (await page.$$("#rules-draft-body [data-rd-i]:checked")).length === 3);
  await page.screenshot({ path: path.join(SHOTS, "banner_expanded.png") });

  await rows[1].click();   // uncheck the middle rule
  const mergeLabel = await page.textContent("#rules-draft-merge");
  check("取消一条后合并按钮变为部分合并", /合并勾选的 2 条/.test(mergeLabel), mergeLabel);

  await page.click("#rules-draft-merge");
  // a PARTIAL merge leaves the un-approved line pending: the banner stays, now with 1
  await page.waitForFunction(() => (document.getElementById("rules-draft-title") || {}).textContent, null, { timeout: 15000 });
  await page.waitForFunction(() => /1 条工作约定/.test(document.getElementById("rules-draft-title").textContent), null, { timeout: 15000 });
  check("部分合并后横幅显示剩余数量", /1 条工作约定/.test(await page.textContent("#rules-draft-title")));

  const rulesMd = await mcp("filesystem", "read", { path: WS + "\\RULES.md" });
  const draftMd = await mcp("filesystem", "read", { path: WS + "\\RULES.draft.md" });
  check("RULES.md 收到勾选的 2 条", rulesMd.ok && rulesMd.text.includes(DRAFT[0]) && rulesMd.text.includes(DRAFT[2]), rulesMd.text.slice(0, 80));
  check("RULES.md 没有收到未勾选的那条", !rulesMd.text.includes(DRAFT[1]));
  check("未勾选的那条仍留在草稿里（数据不丢）", draftMd.ok && draftMd.text.trim() === DRAFT[1], draftMd.text);

  console.log("\n=== 3. 刷新后草稿仍在，可丢弃 ===");
  await page.reload({ waitUntil: "networkidle" });
  await page.click('[data-sid="ux1"]');
  await page.waitForSelector("#rules-draft-banner:not([hidden])", { timeout: 15000 });
  const bannerTitle2 = await page.textContent("#rules-draft-title");
  check("刷新后剩余 1 条仍在待审", /1 条工作约定/.test(bannerTitle2), bannerTitle2);
  await page.click("#rules-draft-discard");
  await page.waitForSelector("#rules-draft-banner", { state: "hidden", timeout: 15000 });
  const draftMd2 = await mcp("filesystem", "read", { path: WS + "\\RULES.draft.md" });
  check("丢弃后草稿文件清空", draftMd2.ok && draftMd2.text.trim() === "", draftMd2.text);

  check("全程零 JS 错误", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

  await browser.close();
  fs.rmSync(WS, { recursive: true, force: true });
  console.log("\n" + (FAILURES.length ? `CHAT UX LIVE: ${FAILURES.length} FAILED -> ${FAILURES.join(" | ")}` : "CHAT UX LIVE: ALL PASSED"));
  return FAILURES.length ? 1 : 0;
};

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
