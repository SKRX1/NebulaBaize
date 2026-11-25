/* Regression test for #toolcontent (2026-11): a NON-STRING tool result must never be sent to the
 * upstream as a message `content`, or a compact/continue request 400s with
 *   "messages[N].content must be a string or an array of content parts"
 * and compaction rolls the history back unchanged every time (分段压缩失败 + lost context, and it can
 * never compact past the bad row). The renderer already String()s every tool result because such rows
 * exist; apiMessages -> assistantMessages was the one path that sent t.result verbatim.
 *
 * T1  toolResultText coerces every shape to a string (null->"", string verbatim, object->JSON,
 *     number->String, array->JSON) so the wire content is ALWAYS a string.
 * T2  assistantMessages emits a tool message whose content is a STRING for an object-valued result
 *     (LOAD-BEARING: before the fix this is the raw object -> typeof !== "string").
 * T3  assistantMessages keeps the string-result path byte-identical (the fix never wraps a string,
 *     and null/undefined still reach "" so the array-shape stays valid).
 *
 * Run: node tests/test_tool_result_content.mjs
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
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      {url: "http://127.0.0.1:8765/", runScripts: "outside-only"});
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ok: true, status: 200, json: async () => ({model: "m", max_context: 32768}),
                          text: async () => ""});

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let code = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8");
code += `
;window.__api = {
  assistantMessages: (m) => assistantMessages(m),
  toolResultText: (v) => toolResultText(v),
};`;
win.eval(code);
const api = win.__api;

console.log("\n=== T1: toolResultText always returns a string ===");
check("null -> empty string", api.toolResultText(null) === "");
check("undefined -> empty string", api.toolResultText(undefined) === "");
check("string is returned verbatim", api.toolResultText("plain text") === "plain text");
check("object -> JSON string", api.toolResultText({k: "v", n: 1}) === JSON.stringify({k: "v", n: 1}));
check("array -> JSON string", api.toolResultText([1, 2, "x"]) === JSON.stringify([1, 2, "x"]));
check("number -> string", api.toolResultText(5) === "5");
check("every result shape yields typeof string",
      [null, undefined, "s", {a: 1}, [1], 5, true, 0].every((v) => typeof api.toolResultText(v) === "string"));

console.log("\n=== T2: a tool message built from an OBJECT result has a STRING content (load-bearing) ===");
const mObj = {role: "assistant", text: "intro then tools",
  tools: [{id: "t1", name: "some_tool", arguments: {}, round: 0, at: 0, state: "done", result: {k: "v", deep: {n: 1}}} ]};
const outObj = api.assistantMessages(mObj);
const toolMsg = outObj.find((x) => x.role === "tool");
check("a tool message was produced", !!toolMsg);
check("its content is a string, not the raw object  " + JSON.stringify(typeof (toolMsg && toolMsg.content)),
      toolMsg && typeof toolMsg.content === "string");
check("the object survives losslessly as JSON  " + JSON.stringify(toolMsg && toolMsg.content),
      toolMsg && toolMsg.content === JSON.stringify({k: "v", deep: {n: 1}}));
check("the assistant tool_calls turn still precedes it (order preserved)",
      outObj[0].role === "assistant" && Array.isArray(outObj[0].tool_calls));

console.log("\n=== T3: the string-result path is byte-identical; null/undefined reach \"\" (no regression) ===");
const mStr = {role: "assistant", text: "x",
  tools: [{id: "t2", name: "some_tool", arguments: {}, round: 0, at: 0, state: "done", result: "raw tool output"}]};
const sMsg = api.assistantMessages(mStr).find((x) => x.role === "tool");
check("a string result is sent verbatim (no JSON double-wrap)", sMsg && sMsg.content === "raw tool output");
const mNull = {role: "assistant", text: "x",
  tools: [{id: "t3", name: "some_tool", arguments: {}, round: 0, at: 0, state: "done", result: null}]};
const nMsg = api.assistantMessages(mNull).find((x) => x.role === "tool");
// Real contract: the ENTRY filter (t.result != null) drops a null result BEFORE content is built,
// so no tool message is emitted at all; either way it can never reach content as a non-string.
check("a null result is filtered at the entry (no tool message emitted)", !nMsg);
check("and toolResultText(null) is still an empty string (defence in depth)", api.toolResultText(null) === "");

console.log("");
if (FAILURES.length) {
  console.log(`TOOL-RESULT-CONTENT: ${FAILURES.length} FAILED`);
  FAILURES.forEach((f) => console.log("  - " + f));
} else {
  console.log("TOOL-RESULT-CONTENT: ALL PASSED");
}
process.exit(FAILURES.length ? 1 : 0);
