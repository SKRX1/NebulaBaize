/* Render tests for the Tools tab (serve/web/admin.js).
 *
 * Drives the real admin.js against a jsdom document with a mocked fetch, so the
 * list, the detail forms, the CRUD wiring and the read-only degradation are
 * exercised without a browser or a live server.
 *
 * The fetch mock reproduces the LIVE contract of POST /mcp/call, measured with
 * curl against a running host:
 *     {"server": "...", "tool": "...", "ok": true,
 *      "text": "<the tool's payload as JSON>", "chars": N, "truncated": false, "ms": 0}
 * A client that reads `content[0].text` (or expects the raw payload as the body)
 * gets nothing here — that is the point: these tests fail if the wrapper shape
 * is ever misread again.
 *
 * Run: node tests/test_admin_render.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// The mock's mutable state, so a save/delete visibly changes the next list.
const SERVERS = [
  { name: "filesystem", command: "py", args: ["fs.py"], cwd: "", env: {}, origin: "builtin", skill: null },
  { name: "<img src=x onerror=alert(1)>", command: "evil", args: [], cwd: "", env: {}, origin: "user", skill: null },
];
const SKILLS = [{
  name: "example", file: "example.yaml", description: "demo skill",
  tools: [{ mcp: "example-server", command: "python", args: ["$SKILL_DIR/example_server.py"] }],
  permissions: {}, triggers: ["example"], requires_env: {}, servers: ["example-server"],
}];
const LIVE = {
  servers: [
    { name: "filesystem", transport: "stdio", status: "ready", error: null, info: {},
      tools: [{ name: "filesystem__read", tool: "read", description: "read a file" }] },
    { name: "shell", transport: "stdio", status: "failed", error: "boom", info: {}, tools: [] },
  ],
  tools: 4,
};

const html = `<!doctype html><html><body>
  <div id="adm-servers"></div>
  <div id="adm-skills"></div>
  <div class="adm-main"><div id="adm-notice"></div><div id="adm-detail"></div></div>
  <textarea id="adm-import"></textarea>
  <button id="adm-new-server"></button>
  <button id="adm-new-skill"></button>
  <button id="adm-import-btn"></button>
</body></html>`;

function makeDom({ registry = true } = {}) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8080/", runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document;
  // Force English so the static-string assertions below stay stable.
  win.localStorage.setItem("strata.lang", "en");
  const calls = [];
  // The live /mcp/call wrapper: the tool's payload rides inside `text` as JSON.
  const wrap = (server, tool, payload, ok = true) =>
    ({ server, tool, ok, text: (ok ? JSON.stringify(payload) : payload),
       chars: 1, truncated: false, ms: 1 });

  win.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const u = String(url);
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch (e) { /* not JSON */ }
    calls.push({ url: u, method, body });

    if (u === "mcp" && method === "GET") {
      return { ok: true, status: 200, json: async () => LIVE };
    }
    if (u === "mcp/call" && method === "POST") {
      if (!registry) {
        // what the host answers when the registry server is not configured
        return { ok: true, status: 200, json: async () =>
          wrap(body.server, `${body.server}__${body.tool}`,
               `error: there is no tool named '${body.server}__${body.tool}'`, false) };
      }
      const tool = body.tool;
      if (tool === "list_servers") {
        return { ok: true, status: 200, json: async () =>
          wrap("registry", "list_servers", { servers: SERVERS.map((s) => ({
            name: s.name, command: s.command, origin: s.origin, skill: s.skill, n_args: s.args.length })) }) };
      }
      if (tool === "list_skills") {
        return { ok: true, status: 200, json: async () =>
          wrap("registry", "list_skills", { skills: SKILLS.map((s) => ({
            name: s.name, file: s.file, description: s.description,
            servers: s.servers, triggers: s.triggers })) }) };
      }
      if (tool === "get_server") {
        const s = SERVERS.find((x) => x.name === body.args.name);
        if (!s) return { ok: true, status: 200, json: async () =>
          wrap("registry", "get_server", { error: `server '${body.args.name}' not found` }) };
        return { ok: true, status: 200, json: async () => wrap("registry", "get_server", { server: s }) };
      }
      if (tool === "get_skill") {
        const s = SKILLS.find((x) => x.name === body.args.name);
        if (!s) return { ok: true, status: 200, json: async () =>
          wrap("registry", "get_skill", { error: `skill '${body.args.name}' not found` }) };
        return { ok: true, status: 200, json: async () => wrap("registry", "get_skill", { skill: s }) };
      }
      if (tool === "test_server") {
        return { ok: true, status: 200, json: async () =>
          wrap("registry", "test_server", { ok: true, tools: [{ name: "recall" }], error: null }) };
      }
      if (tool === "add_server") {
        SERVERS.push({ ...body.args.spec, name: body.args.name, origin: "user", skill: null });
        return { ok: true, status: 200, json: async () =>
          wrap("registry", "add_server", { server: { name: body.args.name, origin: "user" },
                                           warnings: [], backup: "B:/x/mcp_servers.1.json" }) };
      }
      if (tool === "delete_server") {
        const i = SERVERS.findIndex((x) => x.name === body.args.name);
        if (i >= 0) SERVERS.splice(i, 1);
        return { ok: true, status: 200, json: async () =>
          wrap("registry", "delete_server", { deleted: body.args.name, origin: "user", backup: "B:/x" }) };
      }
      if (tool === "add_skill" || tool === "update_skill" || tool === "delete_skill") {
        return { ok: true, status: 200, json: async () =>
          wrap("registry", tool, { skill: { name: body.args.name } }) };
      }
      return { ok: true, status: 200, json: async () => wrap("registry", tool, { error: "unmocked" }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "not found" } }) };
  };
  win.confirm = () => true;
  win.eval(fs.readFileSync(path.join(ROOT, "serve", "web", "i18n.js"), "utf8"));
  win.eval(fs.readFileSync(path.join(ROOT, "serve", "web", "admin.js"), "utf8"));
  return { win, doc, calls };
}

const main = async () => {
  console.log("=== 脚本装载 ===");
  const { win, doc, calls } = makeDom();
  check("loadAdmin 已导出到 window", typeof win.loadAdmin === "function");

  console.log("\n=== 列表渲染（同源 mcp + mcp/call）===");
  await win.loadAdmin();
  await tick();
  const items = () => doc.querySelectorAll("#adm-servers .adm-item");
  check("渲染出 2 个 server", items().length === 2, `got ${items().length}`);
  check("渲染出 1 个 skill", doc.querySelectorAll("#adm-skills .adm-item").length === 1);
  check("读取走 GET mcp（实时状态源）", calls.some((c) => c.url === "mcp" && c.method === "GET"));
  check("写入/读取走 POST mcp/call", calls.some((c) => c.url === "mcp/call" && c.method === "POST"));
  check("list 用 registry 工具", calls.some((c) => c.url === "mcp/call" && c.body.tool === "list_servers"));
  check("运行中的服务器带状态徽章", !!doc.querySelector("#adm-servers .st-badge"));
  check("没有崩溃的服务器无徽章", items()[1] && !items()[1].querySelector(".st-badge"));
  check("显示来源徽章 builtin", !!doc.querySelector("#adm-servers .adm-tag--builtin"));
  check("显示来源徽章 user", !!doc.querySelector("#adm-servers .adm-tag--user"));

  console.log("\n=== XSS 转义 ===");
  const raw = doc.querySelector("#adm-servers").innerHTML;
  check("正文中的恶意名称已转义为实体", raw.includes("&lt;img"), "escaped in text");
  check("未创建注入的元素", doc.querySelectorAll("#adm-servers img").length === 0);
  check("属性值完整保留为文本（未被解析成标签）",
    items()[1].dataset.name === "<img src=x onerror=alert(1)>");
  check("显示文本是原文而非 HTML",
    items()[1].querySelector(".adm-item__name").textContent === "<img src=x onerror=alert(1)>");

  console.log("\n=== 空态 ===");
  check("未选中时显示引导文案", /Pick a server or skill/.test(doc.querySelector("#adm-detail").textContent));

  console.log("\n=== 选中 server（按需拉完整 spec）===");
  items()[0].click();
  await tick();
  check("选中后调用 get_server", calls.some((c) => c.body && c.body.tool === "get_server"));
  check("出现 command 输入框", !!doc.getElementById("f-command"));
  check("command 值已填充", doc.getElementById("f-command").value === "py");
  check("args 以每行一个渲染", doc.getElementById("f-args").value === "fs.py");
  check("已有条目 name 只读", doc.getElementById("f-name").hasAttribute("readonly"));
  check("有保存/试连/删除按钮",
    !!doc.getElementById("f-save") && !!doc.getElementById("f-test") && !!doc.getElementById("f-del"));

  console.log("\n=== 试连 ===");
  doc.getElementById("f-test").click();
  await tick();
  check("调用了 test_server", calls.some((c) => c.body && c.body.tool === "test_server"));
  check("试连结果已渲染", /Connected/.test(doc.querySelector("#f-result").textContent));

  console.log("\n=== 选中 skill ===");
  doc.querySelector("#adm-skills .adm-item").click();
  await tick();
  check("选中后调用 get_skill", calls.some((c) => c.body && c.body.tool === "get_skill"));
  check("渲染出技能表单", !!doc.getElementById("f-desc"));
  check("工具行已填充 mcp 名",
    doc.querySelector('#f-tools [data-k="mcp"]').value === "example-server");
  check("工具行保留 $SKILL_DIR",
    doc.querySelector('#f-tools [data-k="args"]').value.includes("$SKILL_DIR"));
  check("triggers 已填充", doc.getElementById("f-trig").value === "example");
  check("有新增工具按钮", !!doc.getElementById("f-add-tool"));

  console.log("\n=== 新增流程 ===");
  doc.getElementById("adm-new-server").click();
  check("新条目 name 可编辑", !doc.getElementById("f-name").hasAttribute("readonly"));
  check("新建时无删除按钮", !doc.getElementById("f-del"));
  doc.getElementById("f-name").value = "my-new-server";
  doc.getElementById("f-command").value = "node";
  doc.getElementById("f-args").value = "server.js\n--port\n3000";
  doc.getElementById("f-env").value = "TOKEN=abc=def\nBAD_LINE";
  doc.getElementById("f-save").click();
  await tick();
  const post = calls.find((c) => c.method === "POST" && c.body.tool === "add_server");
  check("调用了 registry add_server", !!post);
  if (post) {
    const a = post.body.args;
    check("提交 name 正确", a.name === "my-new-server");
    check("args 按行解析", JSON.stringify(a.spec.args) === JSON.stringify(["server.js", "--port", "3000"]));
    check("env 按行解析（= 只切第一个）", a.spec.env.TOKEN === "abc=def");
    check("忽略无 = 的行", Object.keys(a.spec.env).length === 1);
  }
  check("保存后提示重启生效", /Restart/.test(doc.querySelector("#adm-notice").textContent));
  check("新条目出现在列表里", [...items()].some((b) => b.dataset.name === "my-new-server"));

  console.log("\n=== 删除流程 ===");
  items()[0].click();
  await tick();
  doc.getElementById("f-del").click();
  await tick();
  check("调用了 registry delete_server",
    calls.some((c) => c.method === "POST" && c.body.tool === "delete_server"));

  console.log("\n=== 批量导入 ===");
  doc.getElementById("adm-import").value = JSON.stringify({
    mcpServers: { "imported-a": { command: "a" }, "imported-b": { command: "b" } },
  });
  doc.getElementById("adm-import-btn").click();
  await tick();
  const imported = calls.filter((c) => c.method === "POST" && c.body.tool === "add_server");
  check("导入了 2 条", imported.length >= 2, `${imported.length} 次 add_server`);
  check("导入后清空输入框", doc.getElementById("adm-import").value === "");

  console.log("\n=== 非法 JSON（全局通知，不依赖选中项）===");
  doc.getElementById("adm-import").value = "{not json";
  doc.getElementById("adm-import-btn").click();
  await tick();
  check("提示 JSON 解析失败", /Not valid JSON/.test(doc.querySelector("#adm-notice").textContent));
  check("通知独立于 detail 渲染",
    !/Not valid JSON/.test(doc.querySelector("#adm-detail").textContent));

  console.log("\n=== 空 mcpServers 块 ===");
  doc.getElementById("adm-import").value = '{"somethingElse":{}}';
  doc.getElementById("adm-import-btn").click();
  await tick();
  check("提示缺少 mcpServers 块", /No mcpServers block/.test(doc.querySelector("#adm-notice").textContent));

  console.log("\n=== 只读降级（registry 工具缺失）===");
  const ro = makeDom({ registry: false });
  await ro.win.loadAdmin();
  await tick();
  const roItems = ro.doc.querySelectorAll("#adm-servers .adm-item");
  check("实时列表仍可渲染（来自 GET mcp）", roItems.length === 2, `got ${roItems.length}`);
  check("技能区提示不可用", /Unavailable/.test(ro.doc.querySelector("#adm-skills").textContent));
  roItems[0].click();
  await tick();
  check("详情显示只读模式与原因", /Read-only mode/.test(ro.doc.querySelector("#adm-detail").textContent));
  check("只读态没有保存按钮", !ro.doc.getElementById("f-save"));
  check("仍显示运行中的工具", /read/.test(ro.doc.querySelector("#adm-detail").textContent));

  console.log("\n=== /mcp/call 完全不可达 ===");
  const dead = new JSDOM(html, { url: "http://127.0.0.1:8080/", runScripts: "outside-only" });
  const dwin = dead.window;
  dwin.localStorage.setItem("strata.lang", "en");
  dwin.fetch = async () => { throw new Error("connection refused"); };
  dwin.eval(fs.readFileSync(path.join(ROOT, "serve", "web", "i18n.js"), "utf8"));
  dwin.eval(fs.readFileSync(path.join(ROOT, "serve", "web", "admin.js"), "utf8"));
  await dwin.loadAdmin();
  await tick();
  check("页面不崩溃（列表为空 + 无 JS 异常）",
    dead.window.document.querySelectorAll("#adm-servers .adm-item").length === 0);

  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  }
  console.log("ADMIN RENDER: ALL PASSED");
};

main().catch((e) => { console.error(e); process.exit(1); });
