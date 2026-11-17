/* Frontend smoke test for the About > 运行参数 card (GET/POST /api/runtime-config).
 * Loads index.html + i18n.js + app.js in jsdom, mocks fetch, verifies the card renders
 * the 10 live keys and that the save button POSTs only the changed values. No server needed.
 * Run: node tests/test_runtime_config_frontend.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");
const read = (p) => fs.readFileSync(path.join(WEB, p), "utf8");

let FAIL = [];
function check(name, cond, extra) {
  console.log((cond ? "  OK   " : "  FAIL ") + name + (extra && !cond ? "  → " + extra : ""));
  if (!cond) FAIL.push(name);
}

const PAYLOAD = {
  file: "E:/WorkBuddy/星云智能体/strata-agent/config/mcp_servers.json",
  mode: "direct",
  keys: [
    {key: "max_rounds", kind: "number", value: 1000, default: 1000, help: "cap rounds", scope: "loop", live: true},
    {key: "turn_budget_s", kind: "number", value: 3600, default: 3600, help: "turn ceiling", scope: "loop", live: true},
    {key: "idle_timeout_s", kind: "number", value: 180, default: 180, help: "stall watchdog", scope: "loop", live: true},
    {key: "timeout_s", kind: "number", value: 330, default: 330, help: "per-command", scope: "executor", live: true},
    {key: "server_timeout_s", kind: "number", value: 1800, default: 1800, help: "per-server", scope: "executor", live: true},
    {key: "max_result_chars", kind: "number", value: 30000, default: 30000, help: "truncate", scope: "executor", live: true},
    {key: "tool_result_cap", kind: "number", value: 10000, default: 10000, help: "hist cap", scope: "loop", live: true},
    {key: "tool_head_lines", kind: "number", value: 15, default: 15, help: "head lines", scope: "loop", live: true},
    {key: "tool_tail_lines", kind: "number", value: 15, default: 15, help: "tail lines", scope: "loop", live: true},
    {key: "tool_keep_recent", kind: "number", value: 2, default: 2, help: "keep recent", scope: "loop", live: true},
  ],
};

const dom = new JSDOM(read("index.html"), {url: "http://127.0.0.1:8099/", runScripts: "outside-only"});
const win = dom.window, doc = win.document;
for (const C of ["TextDecoder", "TextEncoder", "AbortController"]) win[C] = globalThis[C];
win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "zh");

let lastPost = null;
win.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("api/runtime-config")) {
    if (opts && opts.method === "POST") { lastPost = JSON.parse(String(opts.body || "{}")); return {ok: true, status: 200, json: async () => ({changed: Object.keys(lastPost.set || {}), file: PAYLOAD.file, mode: "direct"})}; }
    return {ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(PAYLOAD))};
  }
  if (u.includes("config")) return {ok: true, status: 200, json: async () => ({keys: [], file: ""})};  // engine cfg (hidden)
  if (u.endsWith("health")) return {ok: true, status: 200, json: async () => ({model: "strata", max_context: 32768})};
  return {ok: true, status: 200, json: async () => ({})};
};

win.eval(read("i18n.js"));
let code = read("app.js") + "\n;window.__loadRuntimeConfig = loadRuntimeConfig;";
win.eval(code);

await win.__loadRuntimeConfig();
await new Promise((r) => setTimeout(r, 60));

const card = doc.getElementById("rt-card");
check("运行参数卡片可见", card && card.hidden === false);
const inputs = [...doc.querySelectorAll("#rt-form input")];
check("渲染出 10 个数值输入框", inputs.length === 10, "got " + inputs.length);
const labels = [...doc.querySelectorAll("#rt-form label")].map((l) => l.textContent);
check("含 max_rounds 标签", labels.some((t) => t.includes("max_rounds")), JSON.stringify(labels));
check("首个输入预填 1000", inputs[0] && inputs[0].value === "1000", inputs[0] && inputs[0].value);
check("默认中文帮助可见", labels.some((t) => t.includes("工具轮数上限")), JSON.stringify(labels.slice(0, 1)));

// change only max_rounds, leave the rest at default → save must POST only that one
const liveInputs = () => [...doc.querySelectorAll("#rt-form input")];
liveInputs()[0].value = "222";
doc.getElementById("rt-save").dispatchEvent(new win.Event("click"));
await new Promise((r) => setTimeout(r, 60));
check("保存只提交了改动项", lastPost && JSON.stringify(lastPost.set) === JSON.stringify({max_rounds: 222}), JSON.stringify(lastPost));

// invalid value (negative) on a live input → no new POST (lastPost stays the previous one)
liveInputs()[1].value = "-5";
doc.getElementById("rt-save").dispatchEvent(new win.Event("click"));
await new Promise((r) => setTimeout(r, 60));
check("负值不提交", lastPost && JSON.stringify(lastPost.set) === JSON.stringify({max_rounds: 222}), JSON.stringify(lastPost));

console.log(FAIL.length ? "\nRUNTIME-CONFIG FRONTEND: " + FAIL.length + " FAILED" : "\nRUNTIME-CONFIG FRONTEND: ALL PASSED");
process.exit(FAIL.length ? 1 : 0);
