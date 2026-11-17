/* Live smoke test for the redesigned Tools tab (parasitic mode, real browser).
 *
 * Drives the deployed app at http://127.0.0.1:8080/ with a real renderer:
 *   - the Tools tab renders the server list from the registry MCP tools, with live
 *     status badges from GET /mcp (the same overlay the Monitor card uses);
 *   - selecting a server fetches its full spec (get_server) and fills the editor;
 *   - the Test button probes a candidate and reports in seconds (not timeout_s);
 *   - the Monitor tab still renders its MCP card (no regression);
 *   - the sidebar is chat-only (no-sidebar rule) and zero JS errors are collected.
 *
 * Run: node tests/test_tools_tab_live.mjs
 */
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { chromium } = require("playwright");

const BASE = "http://127.0.0.1:8080";
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const main = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on("pageerror", (e) => jsErrors.push(String(e)));
  // resource failures are reported by the response handler below WITH their URL
  // (the console text carries none), so the generic line is skipped here
  page.on("console", (m) => {
    if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) jsErrors.push(m.text());
  });
  page.on("response", (r) => {
    // favicon is ambient; /config.json is the API-key fallback that only the gateway
    // serves — in parasitic mode it 404s by design and app.js ignores it.
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")
        && !r.url().endsWith("/config.json")) {
      jsErrors.push(`HTTP ${r.status()} ${r.url()}`);
    }
  });

  console.log("=== 加载与工具页 ===");
  await page.goto(BASE + "/#tools", { waitUntil: "networkidle" });
  await page.waitForSelector("#adm-servers .adm-item", { timeout: 30000 });
  const servers = await page.$$("#adm-servers .adm-item");
  check("服务器列表渲染（registry 工具）", servers.length >= 7, `${servers.length} items`);
  const badges = await page.$$("#adm-servers .adm-item .st-badge");
  check("运行状态徽章叠加（GET /mcp）", badges.length >= 7, `${badges.length} badges`);
  const names = await page.$$eval("#adm-servers .adm-item__name", (els) => els.map((e) => e.textContent));
  check("registry 自身在列表中", names.includes("registry"), names.join(","));
  check("中文名服务器无乱码（UTF-8 链路）", names.every((n) => !n.includes("\ufffd")));

  console.log("\n=== 选中服务器 → 完整 spec 表单 ===");
  await page.click('#adm-servers .adm-item[data-name="filesystem"]');
  await page.waitForSelector("#f-command", { timeout: 15000 });
  await page.waitForFunction(() => document.getElementById("f-command") &&
    document.getElementById("f-command").value.length > 0, null, { timeout: 15000 });
  const cmd = await page.inputValue("#f-command");
  check("command 由 get_server 填充", cmd.includes("python"), cmd);
  const args = await page.inputValue("#f-args");
  check("args 每行一个且中文路径完好", args.includes("fs_server.py") && args.includes("星云智能体"), args.slice(0, 80));
  const env = await page.inputValue("#f-env");
  check("env 以 KEY=value 行渲染", env.includes("FS_ROOT="), env.slice(0, 60));
  check("已有条目 name 只读", await page.$eval("#f-name", (el) => el.hasAttribute("readonly")));
  check("保存/试连/删除按钮在位",
    !!(await page.$("#f-save")) && !!(await page.$("#f-test")) && !!(await page.$("#f-del")));

  console.log("\n=== 试连（真实子进程探活）===");
  const t0 = Date.now();
  await page.click("#f-test");
  // wait for the FINAL state (an .adm-note), not the "正在启动…" placeholder
  await page.waitForSelector("#f-result .adm-note", { timeout: 60000 });
  const took = (Date.now() - t0) / 1000;
  const result = await page.textContent("#f-result");
  check("试连快速返回（<30s，非 60s 挂起）", took < 30, `${took.toFixed(1)}s`);
  check("探活报告工具清单", /已连接|Connected/.test(result) && /工具|tool/i.test(result), result.slice(0, 120));

  console.log("\n=== 技能区 ===");
  const skills = await page.$$("#adm-skills .adm-item");
  check("技能列表渲染", skills.length >= 1, `${skills.length} items`);
  if (skills.length) {
    await skills[0].click();
    await page.waitForSelector("#f-desc", { timeout: 15000 });
    check("技能表单渲染", !!(await page.$("#f-desc")));
    check("工具行填充 mcp 名", (await page.inputValue('#f-tools [data-k="mcp"]')).length > 0);
  }

  console.log("\n=== 新建流程（写通道可用）===");
  await page.click("#adm-new-server");
  await page.waitForSelector("#f-name", { timeout: 10000 });
  check("新条目 name 可编辑", !(await page.$eval("#f-name", (el) => el.hasAttribute("readonly"))));
  await page.fill("#f-name", "live-smoke-tmp");
  await page.fill("#f-command", process.env.PYTHON_FOR_PROBE || "python");
  await page.fill("#f-args", "-c\nimport sys; sys.exit(0)");
  await page.click("#f-save");
  await page.waitForFunction(() => {
    const n = document.getElementById("adm-notice");
    return n && n.textContent.trim().length > 0;
  }, null, { timeout: 30000 });
  const notice = await page.textContent("#adm-notice");
  check("保存成功并提示重启生效", /已保存|Saved/.test(notice) && /重启|Restart/.test(notice), notice.slice(0, 100));
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#adm-servers .adm-item__name")]
      .some((e) => e.textContent === "live-smoke-tmp"), null, { timeout: 15000 });
  check("新服务器出现在列表", true);

  console.log("\n=== 删除流程（复原，不留下临时条目）===");
  await page.click('#adm-servers .adm-item[data-name="live-smoke-tmp"]');
  await page.waitForSelector("#f-del", { timeout: 15000 });
  page.once("dialog", (d) => d.accept());
  await page.click("#f-del");
  await page.waitForFunction(() =>
    ![...document.querySelectorAll("#adm-servers .adm-item__name")]
      .some((e) => e.textContent === "live-smoke-tmp"), null, { timeout: 15000 });
  check("临时条目已删除（配置复原）", true);

  console.log("\n=== 监控页无回归 ===");
  await page.click("#tab-btn-monitor");
  await page.waitForFunction(() => {
    const el = document.getElementById("mcp-list");
    return el && el.children.length > 0;
  }, null, { timeout: 20000 });
  const mcpRows = await page.$$("#mcp-list .mcp-server");
  check("监控页 MCP 卡片渲染", mcpRows.length >= 7, `${mcpRows.length} servers`);
  const monText = await page.textContent("#mcp-list");
  check("监控页含 registry 条目", monText.includes("registry"));

  console.log("\n=== 布局：侧栏仅对话页 ===");
  await page.click("#tab-btn-tools");
  await page.waitForTimeout(300);
  const sideHiddenTools = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".st-sidebar")).display === "none");
  check("工具页左栏隐藏（no-sidebar）", sideHiddenTools);
  await page.click("#tab-btn-chat");
  await page.waitForTimeout(300);
  const sideVisibleChat = await page.evaluate(() =>
    getComputedStyle(document.querySelector(".st-sidebar")).display !== "none");
  check("对话页左栏显示", sideVisibleChat);

  console.log("\n=== JS 错误 ===");
  check("零 pageerror / console.error", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

  await browser.close();
  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  }
  console.log("TOOLS TAB LIVE: ALL PASSED");
};

main().catch((e) => { console.error(e); process.exit(1); });
