/* Live (Playwright) end-to-end for the gateway fix: choosing a LOCAL instance that names a
 * base_url (a sibling on another port) and ticking "tool calls" must run THIS machine's MCP
 * tools -- exactly like the empty-base (self) case. The old code routed such an entry to a
 * plain proxy (the comment assumed a sibling "runs its own tools"), so the checked tools
 * silently vanished; only leaving the address empty kept them working.
 *
 * This is the browser-level counterpart to the python tests test_local_sibling_loop.py (pure
 * route predicate) and test_local_sibling_e2e.py (gateway subprocess, no browser). Those two
 * already pass in run_tests. This one drives the REAL FRONTEND in a real Chromium so the
 * full chain -- model form (a local entry WITH a base_url) -> frontend sends strata_mcp:true
 * (app.js:7760) -> gateway _wants_local_sibling_loop runs its OWN agent loop -> an MCP tool
 * executes here -> the gateway injects a strata_mcp event -> the frontend renders a .tool-call
 * card (app.js:7861 / 2333) -- is exercised against the real renderer.
 *
 * Load-bearing signal: a .tool-call card only ever appears when the frontend receives a chunk
 * carrying a `strata_mcp` field (app.js:7861). A plain proxy forwards the mock upstream's
 * OpenAI tool_calls delta, which has NO such field and renders nothing. So the presence of a
 * rendered tool card proves the gateway ran OUR loop for a sibling entry -- not a proxy. The
 * counterfactual phase (the SAME entry with tools:false) must therefore render NO tool card.
 *
 * Self-contained: it starts a mock upstream + a real gateway (the same construction as
 * test_local_sibling_e2e.py), isolated registry + isolated output file; the real config/ is
 * never touched.
 *
 * Run: from the repo root `npm i playwright` once (a pure-JS package, a few MB; no browser
 *       is pulled — it lands in the repo-root node_modules the jsdom tests already share),
 *       then `node tests/test_local_sibling_browser.mjs`. It resolves Playwright locally and
 *       drives your installed Microsoft Edge via channel:"msedge", so it never downloads its
 *       own Chromium (PW_CHANNEL=chromium opts back into the bundled build). On a fresh box
 *       the ONLY prerequisites are npm + Edge — both are already assumed present.
 *       NOT registered in run_tests, like the other *_live.mjs -- those run manually against
 *       a live install, not in the headless CI pool).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve Playwright LOCALLY first so a plain `npm i playwright` is enough on any machine:
// requiring from this test file's own directory makes Node walk up into the repo-root
// node_modules (the same one the jsdom recovery channel uses). Only if that misses do we
// fall back to the legacy managed workspace. A real miss prints the exact fix command.
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch (e) {
  try {
    ({ chromium } = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/")("playwright"));
  } catch (e2) {
    console.error(
      "playwright is not installed here. From the repo root run:\n" +
      "    npm i playwright\n" +
      "(a pure-JS package, a few MB; it does NOT pull a browser). Then this test drives your\n" +
      "installed Microsoft Edge via channel:\"msedge\" — no Chromium download.\n" +
      "Set PW_CHANNEL=chromium only if you deliberately want Playwright's own browser.");
    process.exit(2);
  }
}
const ROOT = path.resolve(__dirname, "..");                 // Nebula-agent
const RT = path.join(ROOT, "runtime");
const PY = process.env.PY || "python";

const MOCK_PORT = Number(process.env.MOCK_PORT || 8256);
const GW_PORT = Number(process.env.GW_PORT || 8257);
const GW_BASE = "http://127.0.0.1:" + GW_PORT;
const E2E_FILE = path.join(ROOT, "temp", "__gw_browser_sibling__", "hit.txt");
const MODELS_CFG = path.join(ROOT, "tests", "_scratch_browser_sibling_models.json");
const TOOL = "filesystem__write";

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// ---- mock OpenAI-compatible upstream: 1st turn emits a tool call, 2nd finishes ----
function writeModels(toolsFlag) {
  const entry = { id: "sib", name: "Sibling Local", kind: "local",
                  base_url: "http://127.0.0.1:" + MOCK_PORT + "/v1", model: "sib-model" };
  if (toolsFlag !== null) entry.tools = toolsFlag;
  fs.writeFileSync(MODELS_CFG, JSON.stringify({ selected: "sib", models: [entry] }));
}

function startMock() {
  const state = { turn: 0 };
  const srv = http.createServer((req, res) => {
    let n = 0, chunks = [];
    req.on("data", (d) => { chunks.push(d); n += d.length; if (n >= +(req.headers["content-length"] || 0)) go(); });
    req.on("end", () => { if (!chunks.length) go(); });
    function go() {
      state.turn++;
      let seq;
      if (state.turn % 2 === 1) {
        seq = [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1",
                 function: { name: TOOL, arguments: JSON.stringify({ path: E2E_FILE, content: "browser ok" }) } }] } }] },
               { choices: [{ delta: {}, finish_reason: "tool_calls" }] }];
      } else {
        seq = [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
      }
      const body = seq.map((d) => "data: " + JSON.stringify(d) + "\n\n").join("") + "data: [DONE]\n\n";
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(body);
    }
  });
  srv.listen(MOCK_PORT, "127.0.0.1");
  return srv;
}

function startGateway() {
  const env = Object.assign({}, process.env, {
    STRATA_MODELS_CONFIG: MODELS_CFG,
    FS_ROOT: ROOT, FS_ALLOW: path.resolve(ROOT, ".."),
  });
  const p = spawn(PY, ["gateway.py", "--serve", "--agent",
                       "--url", "http://127.0.0.1:" + MOCK_PORT + "/v1",
                       "--model", "default-model", "--port", String(GW_PORT)],
                 { cwd: RT, env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", () => {}); p.stderr.on("data", () => {});
  return p;
}

async function waitMcp(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(GW_BASE + "/mcp");
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const toolCardCount = (page) => page.evaluate(() => document.querySelectorAll(".tool-call").length);
const pageHasToolCard = async (page, want, ms) => {
  try {
    await page.waitForFunction((w) => {
      const got = document.querySelectorAll(".tool-call").length > 0;
      return w ? got : true;            // want=true: wait for a card; want=false handled by caller
    }, want, { timeout: ms });
    return true;
  } catch (e) { return false; }
};

async function sendMessage(page, text) {
  await page.click("#input");
  await page.evaluate((t) => {
    const el = document.getElementById("input");
    el.innerHTML = ""; el.textContent = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
  await page.waitForFunction(() => !document.getElementById("send-btn").disabled, null, { timeout: 15000 });
  await page.click("#send-btn");
}

async function main() {
  fs.mkdirSync(path.dirname(E2E_FILE), { recursive: true });
  try { fs.rmSync(E2E_FILE, { force: true }); } catch (e) {}
  writeModels(true);

  const mock = startMock();
  const gw = startGateway();
  let browser;
  try {
    console.log("=== waiting for the real gateway (real frontend served by it) ===");
    if (!(await waitMcp())) { check("gateway came up", false, "timeout on /mcp"); return finish(); }
    check("gateway /mcp reachable (it has local tools to run)", true);

    // Reuse a SYSTEM browser so Playwright never downloads its own Chromium (the user has
    // Edge and Chromium would bloat the workspace). channel:"msedge" drives the installed
    // msedge.exe; set PW_CHANNEL=chromium to use a bundled one instead.
    const channel = process.env.PW_CHANNEL || "msedge";
    browser = await chromium.launch(channel === "chromium" ? {} : { channel });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const jsErrors = [];
    page.on("pageerror", (e) => jsErrors.push(String(e)));

    console.log("\n=== T1: a LOCAL entry WITH a base_url + tools -> a rendered tool card ===");
    await page.goto(GW_BASE + "/", { waitUntil: "domcontentloaded" });
    // the model chip must reflect the seeded sibling entry (local, with a base_url)
    let chip = null;
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById("model-btn");
        return b && !b.hidden && b.dataset.kind === "local";
      }, null, { timeout: 15000 });
      chip = await page.evaluate(() => {
        const b = document.getElementById("model-btn");
        return b ? { kind: b.dataset.kind, local: b.dataset.local, name: document.getElementById("model-name").textContent } : null;
      });
    } catch (e) {}
    console.log("  model chip:", JSON.stringify(chip));
    check("a local entry that HAS a base_url is selected (kind=local, local=0)",
          chip && chip.kind === "local" && chip.local === "0", JSON.stringify(chip));

    await page.click("#tab-btn-chat");
    await sendMessage(page, "请把文字 browser ok 写入 " + E2E_FILE.replace(/\\/g, "/"));

    // the load-bearing signal: a .tool-call card rendered from a strata_mcp chunk
    const gotCard = await pageHasToolCard(page, true, 30000);
    const cards = await toolCardCount(page);
    console.log("  tool cards in DOM:", cards);
    check("the frontend rendered a tool card (strata_mcp ran HERE, not proxied)  [load-bearing]",
          gotCard && cards > 0, "cards=" + cards);
    const toolNames = await page.$$eval(".tool-call .tool-call__name", (els) => els.map((e) => e.textContent));
    console.log("  tool names:", JSON.stringify(toolNames));
    check("the rendered card is our local MCP tool", toolNames.some((t) => t.includes(TOOL)), JSON.stringify(toolNames));
    check("no page errors during the tool turn", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));

    // the file the local tool wrote is hard proof the loop executed it on THIS machine
    let wrote = false;
    for (let i = 0; i < 40 && !wrote; i++) { wrote = fs.existsSync(E2E_FILE); if (!wrote) await new Promise((r) => setTimeout(r, 250)); }
    check("the local tool actually wrote the file (loop executed here)", wrote, E2E_FILE);

    console.log("\n=== T2: the SAME entry with tools:false -> NO tool card (checkbox OFF honoured) ===");
    jsErrors.length = 0;
    await new Promise((r) => fs.rm(E2E_FILE, { force: true }, r));
    writeModels(false);                                   // flip only the tools flag; registry re-read per request
    // reload so the frontend re-reads /api/models and modelAllowsTools() turns strata_mcp off
    await page.goto(GW_BASE + "/", { waitUntil: "domcontentloaded" });
    await page.click("#tab-btn-chat");
    await sendMessage(page, "请把文字 browser ok 再写入 " + E2E_FILE.replace(/\\/g, "/"));
    await page.waitForFunction(() => {
      const c = document.querySelector("#chat");
      return c && /done|回复|回答/.test(c.textContent);    // turn reached an answer
    }, null, { timeout: 30000 }).catch(() => {});
    const cards2 = await toolCardCount(page);
    const wrote2 = fs.existsSync(E2E_FILE);
    console.log("  tool cards after tools:false:", cards2);
    check("with tools:false NO tool card is rendered (the checkbox OFF is honoured)  [load-bearing]",
          cards2 === 0 && !wrote2, "cards=" + cards2 + " wrote=" + wrote2);

    console.log("\n=== T3: the two phases differ ONLY by the tools flag ===");
    check("turn-1 (tools on) proved a tool ran; turn-2 (tools off) proved none did  [differential]",
          cards > 0 && cards2 === 0 && wrote && !wrote2, "cards=" + cards + "/" + cards2);

    await page.screenshot({ path: path.join(ROOT, "tests", "_scratch_ux_shots", "local_sibling_browser.png") }).catch(() => {});
    finish();
  } catch (e) {
    console.error("HARNESS ERROR:", e);
    FAILURES.push("harness threw");
    finish();
  }

  function finish() {
    try { if (browser) browser.close(); } catch (e) {}
    try { gw.kill(); } catch (e) {}
    try { mock.close(); } catch (e) {}
    try { fs.rmSync(E2E_FILE, { force: true }); fs.rmdirSync(path.dirname(E2E_FILE), { recursive: true }); } catch (e) {}
    try { fs.rmSync(MODELS_CFG, { force: true }); } catch (e) {}
    console.log(FAILURES.length ? "\nLOCAL SIBLING BROWSER: " + FAILURES.length + " FAILED"
                                : "\nLOCAL SIBLING BROWSER: ALL PASSED");
    process.exit(FAILURES.length ? 1 : 0);
  }
}
main();
