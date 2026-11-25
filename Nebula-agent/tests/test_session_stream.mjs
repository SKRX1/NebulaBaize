/* Contract test: session_stream 方案 A 的拼接纯函数 assembleStreamBubbles 必须真实存在且拼接正确。
 *
 * Why this exists
 * ---------------
 * session_stream 的核心逻辑是「多条 seq chunk → 按序拼接成单气泡」。这是 pollSessionOutbox 注入
 * 气泡前的关键一步；如果拼接顺序错（seq 乱序）、done 取错（不是最后一条）、或多 session 没分组，
 * 用户看到的会话气泡就会内容错位。这段逻辑没有网络、纯函数，最适合用 jsdom 喂多条 entries 直接断言。
 *
 * Run standalone: node tests/test_session_stream.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label);
  if (!cond) FAILURES.push(label);
};

const src = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

// --- static lock: the pure function must be DEFINED, not just called -------------------
check("app_utils.js/app.js DEFINES function assembleStreamBubbles",
  /^function assembleStreamBubbles\s*\(/m.test(src));
check("pollSessionOutbox CALLS assembleStreamBubbles(",
  /assembleStreamBubbles\(entries\)/.test(src));
check("injected bubble carries a streaming flag",
  /streaming:\s*\(e\.done === false\)/.test(src));

// --- runtime lock: boot the page and exercise the function on multiple seq entries -----
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += `\n;window.__api = { assembleStreamBubbles };`;
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);
const api = win.__api;

check("boots as a real function: assembleStreamBubbles", typeof api.assembleStreamBubbles === "function");
const asm = api.assembleStreamBubbles;

// --- behaviour locks -------------------------------------------------------------------

check("empty input returns empty array", asm([]).length === 0);

// single entry passes through unchanged (backward compat: summary's no-seq format)
const single = asm([{ session_name: "jobA", text: "hello", ok: true, done: true }]);
check("single entry passes through (text preserved)", single.length === 1 && single[0].text === "hello");
check("single entry keeps its own done=true", single.length === 1 && single[0].done === true);

// multiple seq entries in REVERSE arrival order must be concatenated in seq order
const multi = asm([
  { session_name: "jobB", text: "chunk2", seq: 2, ok: true, done: false },
  { session_name: "jobB", text: "chunk0", seq: 0, ok: true, done: false },
  { session_name: "jobB", text: "chunk1", seq: 1, ok: true, done: false },
  { session_name: "jobB", text: "chunk3-final", seq: 3, ok: true, done: true },
]);
check("multiple seq entries collapse into ONE bubble", multi.length === 1);
check("chunks concatenated in seq order (0,1,2,3)",
  multi.length === 1 && multi[0].text.split("\n").join("|") === "chunk0|chunk1|chunk2|chunk3-final");
check("done flag comes from the LAST entry (true)", multi.length === 1 && multi[0].done === true);
check("chunks count recorded (4)", multi.length === 1 && multi[0].chunks === 4);

// done flag from a non-final-seq entry does NOT mark the assembled bubble done
const doneMid = asm([
  { session_name: "jobC", text: "a", seq: 0, ok: true, done: false },
  { session_name: "jobC", text: "b", seq: 1, ok: true, done: false },
]);
check("no done=true anywhere => assembled done=false (cursor would blink)",
  doneMid.length === 1 && doneMid[0].done === false);

// two different sessions stay separate bubbles
const twoSess = asm([
  { session_name: "jobX", text: "x1", seq: 0, ok: true, done: false },
  { session_name: "jobY", text: "y1", seq: 0, ok: true, done: true },
  { session_name: "jobX", text: "x2", seq: 1, ok: true, done: true },
]);
check("two sessions stay separate (2 bubbles)", twoSess.length === 2);
const xBubble = twoSess.find((b) => b.session_name === "jobX");
check("jobX assembled in order + done=true", xBubble && xBubble.text.split("\n").join("|") === "x1|x2" && xBubble.done === true);
const yBubble = twoSess.find((b) => b.session_name === "jobY");
check("jobY single bubble text preserved", yBubble && yBubble.text === "y1" && yBubble.done === true);

// missing text fields are treated as empty, not crashes
const missingText = asm([
  { session_name: "jobD", seq: 0, ok: false, done: false },
  { session_name: "jobD", text: "ok-part", seq: 1, ok: true, done: true },
]);
check("missing-text chunk does not crash; assembled keeps the real text",
  missingText.length === 1 && missingText[0].text === "\nok-part");

console.log("\nREGRESSION: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
