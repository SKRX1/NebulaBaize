/* Differential gate: "Shift+/ (the ? key) must TYPE normally inside every contenteditable input."
 * THE FIX (app.js:8946): the global "?" keyboard-shortcut listener guards the shortcut so "?" still
 * types inside an input. Its focus-exemption originally only let #input and a TEXTAREA through, so a
 * contenteditable DIV (the composer #input rides its id exemption, but #edit-area / #spark-add-input /
 * .spark-edit-ta are contenteditable DIVs with no id match and tagName!=TEXTAREA) fell through to
 * preventDefault() and popped the shortcut popover INSTEAD of typing the question mark. Fix: the
 * exemption now ALSO calls the existing isCE(el) helper, so ANY focused contenteditable is exempt.
 *
 * Static lock = the broadened exemption (defends the fix from silently reverting). Runtime
 * differential = isCE on the three affected shapes (contenteditable="true" divs, exactly what the
 * gate saw in the source) MUST be true (=> exempt, ? types) while a PLAIN div (the shortcut-target
 * case, focus NOT in an input) MUST be false (=> shortcut still fires, no over-broadening).
 *
 * Run standalone: node tests/test_question_key_contenteditable.mjs
 */
import fs from "fs"; import path from "path"; import { fileURLToPath } from "url"; import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, {url:"http://127.0.0.1/", runScripts:"outside-only"});
const win = dom.window; const doc = win.document;
win.matchMedia = () => ({matches:false, addEventListener(){}, removeEventListener(){}});
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
win.fetch = async () => ({ok:true, status:200, json:async()=>({})});
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `\n;globalThis.__api={isCE};`;
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(appCode);
const api = win.__api;
const results = []; let fails = 0;
const ok = (l, c, extra) => { results.push((c?"OK  ":"FAIL")+" "+l+(extra?("  ["+extra+"]"):"")); if(!c) fails++; };

// ---------- static lock: the broadened exemption must exist (defends silent revert) ----------
const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
ok("static: exemption now includes isCE(ae) on the ? guard", src.includes('ae.tagName === "TEXTAREA" || isCE(ae)'));
ok("static: original id+TEXTAREA branches intact (composer #input still exempt)", src.includes('ae.id === "input" || ae.tagName === "TEXTAREA"'));
ok("static: isCE helper is a real function", src.includes("function isCE(el)"));

// ---------- runtime differential: isCE on the exact shapes the gate read in the source ----------
function shape(tag, attrs) {
  const el = doc.createElement(tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  doc.body.appendChild(el);
  return el;
}
// the three affected inputs are contenteditable="true" divs (id/class taken from the real source)
const editArea = shape("div", {id:"edit-area", class:"st-textarea ce-input", contenteditable:"true", role:"textbox"});
const sparkAdd = shape("div", {id:"spark-add-input", class:"ce-input", contenteditable:"true"});
const sparkTa  = shape("div", {class:"st-input st-textarea spark-edit-ta rich", contenteditable:"true"});
ok("DIFF+ #edit-area (contenteditable div) -> exempt (isCE true)", api.isCE(editArea) === true);
ok("DIFF+ #spark-add-input (contenteditable div) -> exempt (isCE true)", api.isCE(sparkAdd) === true);
ok("DIFF+ .spark-edit-ta (contenteditable div) -> exempt (isCE true)", api.isCE(sparkTa) === true);
// control: a PLAIN div with NO contenteditable (focus NOT in an input => shortcut must still fire)
const plain = shape("div", {id:"kbd-hints-popover-target"});
ok("DIFF- plain non-contenteditable div -> NOT exempt (isCE false, shortcut preserved)", api.isCE(plain) === false);
// composer #input via the real path: contenteditable true on a div
const composer = shape("div", {id:"input", class:"ce-input", contenteditable:"true"});
ok("DIFF+ composer #input (contenteditable) still exempt", api.isCE(composer) === true);
// null/undefined guard on isCE (defensive: must not throw, must be falsy)
ok("DIFF: isCE(null) is falsy (no crash on document focus edge)", !api.isCE(null));

console.log("\n" + results.join("\n"));
console.log("QUESTION-KEY-CE: " + (fails ? "RED - " + fails + " failures" : "ALL GREEN"));
process.exit(fails ? 1 : 0);
