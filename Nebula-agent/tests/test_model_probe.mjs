/* Regression test: the model switcher must tell the TRUTH about the engine, and the selected
 * model must follow the engine automatically (iq3-s / iq3-xxs share one GPU + one 8080).
 *
 *   T1  engine stopped   -> "engine not running", sibling endpoint "endpoint down"
 *   T2  engine up (xxs)   -> xxs "engine online"; s (no base_url) reads AMBER, not green
 *   T3  no probe at all  -> make no claim (older build / Strata proxy): "served by this instance"
 *   T4  cloud selected   -> amber sibling still shown; auto-align must NOT pull a cloud pick
 *   T5  s selected, xxs live -> auto-align switches selected to iq3-xxs (the live model)
 *   T6  engine dies while the page sits idle -> the dot goes out on its own (no click)
 *   T7  engine starts while the page sits idle -> selection follows it on its own (no click)
 *
 * The poll (4s in the app) calls loadModels() -> autoAlignSelected(); T6/T7 drive one tick of
 * that same path, with the dropdown CLOSED, because "you must click the chip to refresh" is the
 * bug these two exist to prevent.
 * Run: node tests/test_model_probe.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(path.resolve(HERE, ".."), "serve", "web");

const FAILURES = [];
const check = (label, got, want) => {
  const ok = got === want;
  console.log("  " + (ok ? "OK   " : "FAIL ") + label + "  got=" + JSON.stringify(got) +
              (ok ? "" : "  want=" + JSON.stringify(want)));
  if (!ok) FAILURES.push(label);
};

async function mount(payload) {
  const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                        {url: "http://127.0.0.1:8099/", runScripts: "outside-only"});
  const win = dom.window, doc = win.document;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
  win.confirm = () => true;
  win.localStorage.setItem("strata.lang", "zh");
  // mock: GET models/config returns the scenario payload; POST persists `selected` so auto-align
  // is observable (the real server writes config/models.json).
  const config = JSON.parse(JSON.stringify(payload));
  win.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("models/config")) {
      if (opts && opts.method === "POST") {
        const body = JSON.parse(String(opts.body || "{}"));
        config.selected = body.selected;
      }
      return {ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(config))};
    }
    if (u.endsWith("health")) return {ok: true, status: 200, json: async () => ({model: "strata", max_context: 32768})};
    return {ok: true, status: 200, json: async () => ({})};
  };
  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  let code = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  code += `\n;window.__api = {loadModels, pollModels, selectModel, openModelPop, closeModelPop, getDoc: () => modelsDoc};`;
  win.eval(code);
  return {
    win, doc, api: win.__api, config,                     // config is the live mock: mutate it to move the engine
    settle: (ms = 80) => new Promise((r) => setTimeout(r, ms)),
    close: () => dom.window.close(),
  };
}

async function scenario(title, payload, expect) {
  console.log("\n=== " + title + " ===");
  const ctx = await mount(payload);
  const {win, doc, api} = ctx;
  await api.loadModels();
  api.openModelPop();                             // re-fetches (after re-probe), then repaints
  await ctx.settle();                             // let the auto-align POST settle

  const rows = [...doc.querySelectorAll("#model-pop [data-model]")].map((n) => [
    n.dataset.model, n.querySelector(".model-pop__sub").textContent]);
  const head = doc.querySelector("#model-pop .model-pop__group");
  console.log("  rows:", JSON.stringify(rows));
  console.log("  header:", JSON.stringify(head && head.textContent));
  check("local group header", head && head.textContent, expect.header);
  for (const [id, want] of Object.entries(expect.rows)) {
    check("row " + id, (rows.find(([x]) => x === id) || [])[1], want);
  }
  const btn = doc.getElementById("model-btn");
  const lines = (btn.title || "").split("\n");
  console.log("  chip:", JSON.stringify({dot: btn.dataset.dot, hint: lines[1], selected: api.getDoc().selected}));
  check("chip dot", btn.dataset.dot, expect.dot);
  if (expect.hint) check("chip hint", lines[1], expect.hint);
  if (expect.selected !== undefined) check("selected after align", api.getDoc().selected, expect.selected);
  api.closeModelPop();
  ctx.close();
}

/* One unattended poll tick with the dropdown CLOSED: this is the "no click required" contract.
 * `mutate` moves the engine (the real world changing under the page) and only THEN do we tick. */
async function pollScenario(title, payload, mutate, expect) {
  console.log("\n=== " + title + " ===");
  const ctx = await mount(payload);
  const {doc, api} = ctx;
  await api.loadModels();
  await ctx.settle();
  const btn = doc.getElementById("model-btn");
  console.log("  before:", JSON.stringify({dot: btn.dataset.dot, selected: api.getDoc().selected}));
  mutate(ctx.config);
  await api.pollModels();                          // exactly what the 4s timer does
  await ctx.settle();
  console.log("  after: ", JSON.stringify({dot: btn.dataset.dot, selected: api.getDoc().selected,
                                           popHidden: doc.getElementById("model-pop").hidden}));
  check("chip dot after one tick", btn.dataset.dot, expect.dot);
  if (expect.selected !== undefined) check("selected after one tick", api.getDoc().selected, expect.selected);
  check("dropdown stayed closed (no click)", doc.getElementById("model-pop").hidden, true);
  ctx.close();
}

const MODELS = [
  {id: "iq3-s", name: "swift-1.5-iq3_s", kind: "local", base_url: "", model: "swift-1.5-iq3_s"},
  {id: "iq3-xxs", name: "swift-1.5-iq3_xxs", kind: "local", base_url: "http://127.0.0.1:8080", model: "swift-1.5-iq3_xxs"},
  {id: "cloud-x", name: "Cloud X", kind: "custom", base_url: "https://api.example.com/v1", model: "gpt-x", api_key_set: true},
];
const DOWN = {"iq3-s": {url: "http://127.0.0.1:8080", ok: false},
              "iq3-xxs": {url: "http://127.0.0.1:8080", ok: false},
              "__engine__": {url: "http://127.0.0.1:8080", ok: false, loaded: null}};
const UP = {"iq3-s": {url: "http://127.0.0.1:8080", ok: true},
            "iq3-xxs": {url: "http://127.0.0.1:8080", ok: true},
            "__engine__": {url: "http://127.0.0.1:8080", ok: true, loaded: "swift-1.5-iq3_xxs"}};

await scenario("T1: the engine is stopped — say so", {selected: "iq3-s", models: MODELS, probe: DOWN},
               {header: "本地模型（需实例已启动）",
                rows: {"iq3-s": "本机 · 引擎未启动", "iq3-xxs": "127.0.0.1:8080 · 端点未启动"},
                dot: "off", hint: "引擎未启动 —— 现在发消息会失败"});

await scenario("T2: engine up, holds xxs — xxs green, s reads AMBER (no green lie)",
               {selected: "iq3-xxs", models: MODELS, probe: UP},
               {header: "本地模型（需实例已启动） · 引擎实载 swift-1.5-iq3_xxs",
                rows: {"iq3-s": "本机 · 引擎实载 swift-1.5-iq3_xxs", "iq3-xxs": "127.0.0.1:8080"},
                dot: "on", hint: "引擎在线，正在服务这个模型"});

await scenario("T3: no probe (older build / proxy) — make no claim", {selected: "iq3-s", models: MODELS},
               {header: "本地模型（需实例已启动）",
                rows: {"iq3-s": "本机 · 由本实例提供", "iq3-xxs": "127.0.0.1:8080"},
                dot: "na"});

// iq3-s has an empty base_url: before the fix it always read green (a "sibling instance"). T2 already
// covers the green/amber split; this T4 confirms a cloud pick is left alone by auto-align while the
// amber sibling is still rendered truthfully.
await scenario("T4: cloud selected — amber sibling shown, auto-align does NOT pull a cloud pick",
               {selected: "cloud-x", models: MODELS, probe: UP},
               {header: "本地模型（需实例已启动） · 引擎实载 swift-1.5-iq3_xxs",
                rows: {"iq3-s": "本机 · 引擎实载 swift-1.5-iq3_xxs", "iq3-xxs": "127.0.0.1:8080"},
                dot: "na", selected: "cloud-x"});

// The headline case: user picked s, but the engine is actually running xxs. The poll must follow
// the engine and switch the selection on its own — no click required.
await scenario("T5: s selected but xxs is live — auto-align switches selection to iq3-xxs",
               {selected: "iq3-s", models: MODELS, probe: UP},
               {header: "本地模型（需实例已启动） · 引擎实载 swift-1.5-iq3_xxs",
                rows: {"iq3-s": "本机 · 引擎实载 swift-1.5-iq3_xxs", "iq3-xxs": "127.0.0.1:8080"},
                dot: "on", selected: "iq3-xxs"});

// The user's actual complaint: the green dot stayed lit after the engine was closed, and only a
// click on the chip corrected it. One unattended tick must be enough.
await pollScenario("T6: engine dies while the page idles — the dot goes out by itself",
                   {selected: "iq3-xxs", models: MODELS, probe: UP},
                   (cfg) => { cfg.probe = JSON.parse(JSON.stringify(DOWN)); },
                   {dot: "off"});

await pollScenario("T7: engine starts while the page idles — selection follows it by itself",
                   {selected: "iq3-s", models: MODELS, probe: DOWN},
                   (cfg) => { cfg.probe = JSON.parse(JSON.stringify(UP)); },
                   {dot: "on", selected: "iq3-xxs"});

// ...but a human hand outranks the poll: picking the other model is how you pre-select one you are
// about to start. Without the grace, a 4s tick would undo the pick before the engine even came up.
console.log("\n=== T8: a fresh manual pick survives the next poll (60s grace) ===");
{
  const ctx = await mount({selected: "iq3-xxs", models: MODELS, probe: UP});
  const btn = ctx.doc.getElementById("model-btn");
  await ctx.api.loadModels();
  await ctx.settle();
  check("starts green on the live model", btn.dataset.dot, "on");
  await ctx.api.selectModel("iq3-s");              // a real click, not an auto-align
  await ctx.settle();
  await ctx.api.pollModels();                      // the very next tick must not undo it
  await ctx.settle();
  console.log("  after pick + poll:", JSON.stringify({dot: btn.dataset.dot, selected: ctx.api.getDoc().selected}));
  check("manual pick is kept through a poll", ctx.api.getDoc().selected, "iq3-s");
  check("and it honestly reads amber meanwhile", btn.dataset.dot, "mismatch");
  ctx.close();
}

console.log(FAILURES.length ? "\nMODEL PROBE: " + FAILURES.length + " FAILED" : "\nMODEL PROBE: ALL PASSED");
process.exit(FAILURES.length ? 1 : 0);
