/* Gate: sanitizeHtml must let pasted spark IMAGES survive, while the XSS safety net stays intact.
 *
 * Why: we added IMG to SPARK_HTML_ALLOW and gave IMG src a scheme allow-list (SPARK_IMG_SRC),
 * and bound contenteditable paste to an upload-then-insert-<img> path. Two risks this locks:
 *   (1) functionality — a pasted image (server ref /data/uploads/... or data:image/* fallback)
 *       must NOT be stripped by sanitizeHtml, or the spark image disappears on save (the bug).
 *   (2) safety — a hand-crafted javascript:/blob: src and any event handler must still be stripped.
 * Differential pairs prove both: allowed src survives, dangerous src/handler is stripped.
 *
 * NOTE: the static locks read the SOURCE TEXT, not eval'd globals -- jsdom top-level `const`
 * is not a window property, so reading it through win.eval would give a false RED. The
 * runtime differential pairs below are the real safety net; they exercise the live sanitizer.
 *
 * Run standalone: node tests/test_spark_image_sanitize.mjs
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

// --- static source locks (read the text, immune to eval scope) -------------------------------
check("source: IMG is in SPARK_HTML_ALLOW", /SPARK_HTML_ALLOW\s*=\s*new Set\(\[[^\]]*?"IMG"/.test(srcText));
check("source: SPARK_IMG_SRC scheme whitelist defined", /const SPARK_IMG_SRC\s*=\s*\//.test(srcText));
check("source: pasteImageToRich is defined", /function pasteImageToRich\s*\(/.test(srcText));
check("source: sanitizeHtml checks IMG src against the whitelist", /IMG"?\s*&&\s*a\.name === "src"[\s\S]{0,120}SPARK_IMG_SRC\.test/.test(srcText));
check("source: contenteditable paste is bound to pasteImageToRich", /addEventListener\("paste"[\s\S]{0,60}pasteImageToRich/.test(srcText));

// --- runtime boot for the live sanitizer differential ----------------------------------------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `\n;window.__api = { sanitizeHtml };`;
win.eval(appCode);
const api = win.__api;
check("sanitizeHtml boots as a real function", typeof api.sanitizeHtml === "function");

// --- functional: allowed srcs SURVIVE (the fix) ----------------------------------------------
check("server-ref image survives (functionality)",
  /<img[^>]*src="\/data\/uploads\/img-abc\.png"/.test(api.sanitizeHtml('<div>x <img src="/data/uploads/img-abc.png"></div>')));
check("data:image base64 fallback survives (functionality)",
  /<img[^>]*src="data:image\/png;base64,AAAA"/.test(api.sanitizeHtml('<img src="data:image/png;base64,AAAA">')));

// --- safety: dangerous src / handlers STILL stripped (XSS net intact) ------------------------
// differential pair vs the two OK cases above: same IMG, dangerous src -> src stripped
check("javascript: src is stripped (XSS net intact)", (() => {
  const out = api.sanitizeHtml('<img src="javascript:alert(1)">');
  return /<img/.test(out) && !/javascript:/i.test(out);
})());
check("blob: src is stripped (dead after reload, not a persistence source)", (() => {
  const out = api.sanitizeHtml('<img src="blob:http://x/y">');
  return !/blob:/i.test(out);
})());
check("event handler on IMG is stripped, src kept (XSS net intact)", (() => {
  const out = api.sanitizeHtml('<img src="/data/uploads/x.png" onerror="alert(1)">');
  return /src="\/data\/uploads\/x\.png"/.test(out) && !/onerror/i.test(out);
})());

console.log("\nSPARK-IMAGE-SANITIZE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
