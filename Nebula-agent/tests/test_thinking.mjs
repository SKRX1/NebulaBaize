/* Regression test for the 思考强度 selector: per-task levels + 跟随模型 (auto).

Boots the REAL index.html + i18n.js + app.js in jsdom with an in-memory fake environment and
locks the contract introduced 2026-10-20:

  Per-task          the ACTIVE session's own level wins over the global default, so switching
                    tasks auto-switches thinking with it (that's the "按任务自动切换" ask).
  Global fallback   a session with no override reuses settings.thinking (untouched install -> high).
  Legacy            the old Off button wrote "none"; it must normalise to "off", not silently break.
  跟随模型 (auto)    resolves to the model's declared think_default, and returns null (key OMITTED)
                    when the model declares none -- that is what "follow the model" means.
  Clamping          a level the model does not offer is clamped DOWN, never sent raw (the endpoint
                    validates the value and answers 400 for anything unknown).
  Readout           thinkOutput() names what auto currently resolves to, so it never looks dead.

Run: node tests/test_thinking.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("E:/Nebula/NebulaBaize/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "zh");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// i18n.js is not loaded automatically (runScripts: outside-only), and thinkOutput() is i18n-driven,
// so the dictionary has to be evaluated explicitly or every key falls back to its own name.
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const injected = appCode + `
;window.__api = {
  modelThinking, sessionThink, normThink, thinkOutput,
  get thinking () { return settings.thinking; },
  setSettings: (patch) => { settings = {...settings, ...patch}; },
  setModels: (d) => { modelsDoc = d; },
  setSession: (sessionsIn, activeIdIn) => { sessions = sessionsIn; activeId = activeIdIn; },
};`;
try {
  win.eval(`(function(){ ${injected} })()`);
} catch (e) {
  console.log("FATAL: app.js failed to evaluate:", String(e).slice(0, 400));
  process.exit(1);
}

const api = win.__api;
const mk = (extras = {}) => ({id: "m1", name: "M1", kind: "local", base_url: "", model: "m1", ...extras});
const one = (x) => ({selected: x.id, models: [x]});

console.log("\nT1 default: no session, no override -> high (unchanged behaviour)");
api.setModels(one(mk()));
api.setSettings({thinking: "high"});
api.setSession([], null);
check("defaults to high", api.modelThinking() === "high", `got ${api.modelThinking()}`);
check("sessionThink falls back to global", api.sessionThink(null) === "high", api.sessionThink(null));

console.log("\nT2 per-task: the active session's own level wins");
const taskA = {id: "a", title: "A", thinking: "off", messages: []};
const taskB = {id: "b", title: "B", thinking: "high", messages: []};
const taskC = {id: "c", title: "C", messages: []};               // no override -> global
api.setSettings({thinking: "medium"});
api.setSession([taskA, taskB, taskC], "a");
check("active task A (off) wins over global medium", api.modelThinking() === "off", `got ${api.modelThinking()}`);
api.setSession([taskA, taskB, taskC], "b");
check("switching to task B auto-switches to high", api.modelThinking() === "high", `got ${api.modelThinking()}`);
api.setSession([taskA, taskB, taskC], "c");
check("task C without override reuses global medium", api.modelThinking() === "medium", `got ${api.modelThinking()}`);

console.log("\nT3 legacy value 'none' written by the old Off button");
check("normThink('none') === 'off'", api.normThink("none") === "off", String(api.normThink("none")));
check("normThink(' HIGH ') === 'high'", api.normThink(" HIGH ") === "high", String(api.normThink(" HIGH ")));
check("normThink('bogus') === '' (unset)", api.normThink("bogus") === "", JSON.stringify(api.normThink("bogus")));
check("normThink('') === ''", api.normThink("") === "", JSON.stringify(api.normThink("")));
api.setSession([{id: "d", thinking: "none", messages: []}], "d");
check("a legacy session still resolves to off", api.modelThinking() === "off", `got ${api.modelThinking()}`);

console.log("\nT4 跟随模型 (auto): follow the model's declared think_default");
api.setSession([], null);
api.setSettings({thinking: "auto"});
api.setModels(one(mk({think_default: "low"})));
check("auto uses the pinned think_default", api.modelThinking() === "low", `got ${api.modelThinking()}`);
api.setModels(one(mk({think_default: "auto"})));
check("unpinned default -> null (omit the key)", api.modelThinking() === null, `got ${api.modelThinking()}`);
api.setModels(one(mk()));
check("no default declared -> null (omit the key)", api.modelThinking() === null, `got ${api.modelThinking()}`);
api.setModels(null);
check("no model at all -> null, no crash", api.modelThinking() === null, `got ${api.modelThinking()}`);

console.log("\nT5 clamping: never send a level the model does not offer");
api.setSettings({thinking: "high"});
api.setSession([], null);
api.setModels(one(mk({think_modes: ["off", "low"]})));
check("high clamped down to low", api.modelThinking() === "low", `got ${api.modelThinking()}`);
api.setModels(one(mk({think_modes: ["off"]})));
check("anything clamped down to off", api.modelThinking() === "off", `got ${api.modelThinking()}`);
api.setSettings({thinking: "medium"});
api.setModels(one(mk({think_modes: ["medium", "high"]})));
check("a supported level is kept verbatim", api.modelThinking() === "medium", `got ${api.modelThinking()}`);
api.setModels(one(mk({think_modes: ["high"], think_default: "low"})));
api.setSettings({thinking: "auto"});
const clamped = api.modelThinking();
check("auto respects think_modes too", clamped === "high", `got ${clamped}`);

console.log("\nT6 readout names what auto resolves to (otherwise it looks broken)");
api.setSettings({thinking: "auto"});
api.setModels(one(mk({think_default: "high"})));
check("auto + pinned names the level", String(api.thinkOutput("auto")).includes("高"), api.thinkOutput("auto"));api.setModels(one(mk()));
const free = String(api.thinkOutput("auto"));
check("auto + unpinned says the engine decides", free.length > 0 && free.includes("引擎"), free);
check("a concrete level stays concrete", String(api.thinkOutput("off")).includes("不思考"), api.thinkOutput("off"));
check("unknown value -> empty readout", api.thinkOutput("bogus") === "", JSON.stringify(api.thinkOutput("bogus")));

console.log("\nT7 the selector really exposes all five choices, and lays them out without squeezing");
const idxHtml = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const appCss = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
const segHtml = idxHtml.slice(idxHtml.indexOf('id="s-thinking"'), idxHtml.indexOf("</div>", idxHtml.indexOf('id="s-thinking"')));
const vals = [...segHtml.matchAll(/data-v="([^"]+)"/g)].map((m) => m[1]);
check("five options in the markup", vals.length === 5, JSON.stringify(vals));
check("order is auto,high,medium,low,off", vals.join(",") === "auto,high,medium,low,off", vals.join(","));
check("each option carries an i18n label", (segHtml.match(/data-i18n=/g) || []).length === 5,
      String((segHtml.match(/data-i18n=/g) || []).length));
// .seg is a hard 4-column grid; without this rule the 5th button lands alone on a second row (or gets
// clipped away in a narrow drawer -- which is exactly how "只有 3 个选项" was reported).
check("follow-the-model spans the whole row", /#s-thinking\s*>\s*\[data-v="auto"\]\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(appCss),
      "missing the 1+4 layout rule");
check("buttons cannot clip their own label", /\.seg button\s*\{[^}]*white-space:\s*nowrap/.test(appCss));

console.log("\n" + (FAILURES.length
  ? `THINKING: ${FAILURES.length} FAILED -> ${FAILURES.join(" | ")}`
  : "THINKING: ALL PASSED"));
process.exit(FAILURES.length ? 1 : 0);
