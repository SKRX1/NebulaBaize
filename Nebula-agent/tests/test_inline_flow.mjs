/* Gate: the mixed text+image bubble keeps the layout the user typed.
 *
 * Contract landed 2026-10-31: a message typed as ONE line (text + pasted thumbnail on the
 * same line) must render as ONE line, and a message typed with real newlines breaks exactly
 * where the user broke it. Mechanism: blocks()/markdown() take an inlineFlow switch, the
 * bubble mixed path passes true, and the newline that stood at a segment boundary (the
 * whitespace the [img:N] anchor consumed) becomes a real <br> node between the nodes.
 *
 * Differential pairs (positive = the new inline shape, negative = every other caller stays
 * on the old <p>-block layout -- anti-drift, both sides locked):
 *   POSITIVE blocks(single line, true) -> NO wrapper (inline, stays in the text flow).
 *   NEGATIVE blocks(single line)       -> <p> wrapper (default path untouched).
 *   POSITIVE blocks(multi line, true)  -> lines separated by <br>, no wrapper.
 *   POSITIVE blank line under inlineFlow -> a visible break between the paragraphs.
 *   NEGATIVE markdown default          -> <p> wrapper stays.
 * Static locks use on-disk literals read this session (no hand-typed codepoints).
 *
 * Run standalone: node tests/test_inline_flow.mjs
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
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks (on-disk literals) ----------------------------------------
check("source: blocks() takes the inlineFlow switch", srcText.includes("function blocks(text, inlineFlow)"));
check("source: markdown() takes the inlineFlow switch", srcText.includes("function markdown(text, inlineFlow)"));
check("source: markdown passes inlineFlow through to blocks", srcText.includes("blocks(rest, inlineFlow)"));
check("source: bubble mixed path calls markdown(sg.text, true)", srcText.includes("markdown(sg.text, true)"));
check("source: wrapP drops the wrapper under inlineFlow", srcText.includes("=> (inlineFlow ? inner :"));
check("source: inlineFlow paragraphs join with br", srcText.includes('out.push(wrapP(para.map(inline).join("<br>")))'));
check("source: blank line emits a visible break under inlineFlow", srcText.includes('if (inlineFlow && out.length) out.push("<br>")'));
check("source: segment-boundary newline appends a br node between segments", srcText.includes('if (_ws.indexOf("\\n") >= 0) b.appendChild(document.createElement("br"));'));

// --- runtime boot: full skeleton so top-level init completes ------------------------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { blocks, markdown };\n";
win.eval(appCode);
const api = win.__api;
check("blocks boots as a real function", typeof api.blocks === "function");
check("markdown boots as a real function", typeof api.markdown === "function");

// --- differential pairs --------------------------------------------------------------
const P1 = api.blocks("one line", true);
check("POSITIVE inlineFlow single line -> inline, no wrapper", !P1.includes("<p>") && P1.includes("one line"));

const N1 = api.blocks("one line");
check("NEGATIVE default single line keeps the <p> wrapper", N1.includes("<p>") && N1.includes("one line"));

const P2 = api.blocks("line one\nline two", true);
check("POSITIVE inlineFlow multi-line -> both lines, broken by <br>, no wrapper",
  !P2.includes("<p>") && P2.includes("line one") && P2.includes("line two") && P2.includes("<br>"));

const P3 = api.blocks("para a\n\npara b", true);
check("POSITIVE inlineFlow blank line -> exactly one visible break", (P3.match(/<br>/g) || []).length === 1 && !P3.includes("<p>"));

const N2 = api.blocks("line one\nline two");
check("NEGATIVE default multi-line keeps block layout", N2.includes("<p>"));

const N3 = api.markdown("plain body");
check("NEGATIVE markdown default keeps <p>", N3.includes("<p>") && N3.includes("plain body"));

const P4 = api.markdown("plain body", true);
check("POSITIVE markdown inlineFlow drops the wrapper", !P4.includes("<p>") && P4.includes("plain body"));

console.log("");
console.log(FAILURES.length ? "INLINE-FLOW: " + FAILURES.length + " FAILURE(S)" : "INLINE-FLOW: ALL GREEN");
process.exit(FAILURES.length ? 1 : 0);
