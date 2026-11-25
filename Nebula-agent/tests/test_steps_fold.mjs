/* Regression test for the work-log folding (执行过程折叠).
 *
 * A turn that used tool calls must render its intermediate prose / thoughts / tool calls inside one
 * collapsible "执行过程" <details> group, while the final answer stays fully expanded outside it:
 *   1. a tool-using assistant turn gets a .st-steps group; a plain turn does not.
 *   2. a FINISHED turn auto-collapses the group; streaming keeps it open.
 *   3. the summary meta shows step/tool counts and the summed tool duration.
 *   4. the final-answer md node sits outside the group; intermediate prose sits inside.
 *   5. settings.stepsFold=false turns the whole feature off (legacy flat rendering).
 *
 * Run: node tests/test_steps_fold.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

function makeDom(sampling) {
  const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  const doc = win.document;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");
  if (sampling) win.localStorage.setItem("strata.sampling", JSON.stringify(sampling));
  win.localStorage.setItem("strata.chat", JSON.stringify(SEED));
  win.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) +
    "\n;window.__api = { updateAssistant, answerSpec, paintBubble };";
  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  win.eval(appCode);
  return { win, doc };
}

const TOOLS = [{ tool: "fs.read", server: "fs", state: "done", ms: 1500, arguments: { path: "a.js" }, result: "file body" }];
const SEED = [
  { role: "user", text: "Q1", time: 1 },
  { role: "assistant", text: "I will check the file first.|Final answer here.", time: 2 },
  { role: "user", text: "Q2", time: 3 },
  { role: "assistant", text: "Plain answer.", time: 4 },
];
// answerSpec slices text by tool offsets; put a marker for the pre-tool prose via tools[0].at
SEED[1].tools = [{ ...TOOLS[0], at: SEED[1].text.indexOf("|") }];
SEED[1].text = SEED[1].text.replace("|", "\n\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== work-log folding (执行过程折叠) regression ===");

  const { win, doc } = makeDom(null);
  await sleep(30);

  const msgs = doc.querySelectorAll("#chat .st-msg");
  const toolMsg = msgs[1], plainMsg = msgs[3];

  const group = toolMsg && toolMsg.querySelector(".st-steps");
  check("tool-using turn renders a .st-steps group", !!group);
  check("finished turn auto-collapses the group", !!group && !group.open);

  const meta = group && group.querySelector(".st-steps__meta");
  check("summary meta lists step + tool counts", !!meta && /2 steps/.test(meta.textContent) && /1 tool calls/.test(meta.textContent),
    meta ? JSON.stringify(meta.textContent) : "no meta");
  check("summary meta shows summed tool duration", !!meta && /1\.5 s/.test(meta.textContent), meta ? meta.textContent : "");

  const ans = toolMsg && toolMsg.querySelector(".ans");
  const lastSeg = ans && ans.lastElementChild;
  check("final-answer md sits outside the group", !!lastSeg && lastSeg.classList.contains("ans-md") && /Final answer here\./.test(lastSeg.textContent));
  const body = group && group.querySelector(".st-steps__body");
  check("intermediate prose sits inside the group body", !!body && /I will check the file first\./.test(body.textContent));
  check("tool block sits inside the group body", !!body && !!body.querySelector(".tool-call"));
  check("plain turn has no group", !!plainMsg && !plainMsg.querySelector(".st-steps"));

  // streaming keeps the group open; finishing collapses it again (updateAssistant drives both states)
  const mObj = { role: "assistant", text: "Checking first.\n\nDone.", reasoning: "",
                 tools: [{ ...TOOLS[0], at: "Checking first.".length + 2 }], time: 9 };
  const host = doc.querySelector('#chat .st-msg[data-i="1"]');   // a real message el: stats/next-steps need it
  const api = win.__api;
  let live = null;
  try {
    if (!api || typeof api.updateAssistant !== "function") throw new Error("window.__api.updateAssistant missing");
    api.updateAssistant(host, mObj, true);
    const g1 = host.querySelector(".st-steps");
    check("streaming turn keeps the group open", !!g1 && g1.open);
    api.updateAssistant(host, mObj, false);
    const g2 = host.querySelector(".st-steps");
    check("same turn collapses once finished", !!g2 && !g2.open);
  } catch (e) { live = String(e); }
  check("updateAssistant reachable for live-state probe", live === null, live || "");

  const off = makeDom({ stepsFold: false });
  await sleep(30);
  const offMsgs = off.doc.querySelectorAll("#chat .st-msg");
  check("stepsFold=false renders legacy flat segments (no group)", !!offMsgs[1] && !offMsgs[1].querySelector(".st-steps"));

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("STEPS-FOLD: ALL PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
