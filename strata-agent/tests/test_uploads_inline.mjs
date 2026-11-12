/* Gate: a search-download image (local /data/uploads/... path) must render inline in the
 * chat body. Two-layer lock per the proposal-card rule (verified, not assumed):
 *   LAYER 1 static source locks — app.js inline() image branch accepts /data/uploads/,
 *          AND http_server.py routes /data/uploads/ to the real drop-point + the security
 *          check additionally allows that prefix (the drop-point is OUTSIDE the web root).
 *   LAYER 2 behaviour differential — a pure-string replica of the render chain proves the
 *          new branch is LOAD-BEARING: WITH /data/uploads/ in the regex an ![local](...) line
 *          produces an <img>; the CONTROL regex (old, without it) leaves it as escaped text.
 *
 * The real drop-point fact is load-bearing: websearch_server.py `_cache_dir()` = ROOT/data/uploads/search,
 * which sits OUTSIDE serve/web (the web root), so BOTH the route branch AND the security
 * prefix-allow are required — drop either and the image 403s.
 *
 * NOTE app.js source escapes the slashes INSIDE its regex literals (\/data\/uploads\/), so the
 * static locks match that byte form ("\\/data\\/uploads\\/" in a JS string), NOT the bare path.
 *
 * Run standalone: node tests/test_uploads_inline.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WEB = path.join(ROOT, "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const src = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const srv = fs.readFileSync(path.join(ROOT, "runtime", "http_server.py"), "utf8");

/* ─── LAYER 1: static source locks ────────────────────────────────────────────── */
console.log("=== 1: static source locks ===");

// the byte form app.js carries inside its regex literals (escaped slashes)
// LOCK DEPENDENCY: this byte-form lock assumes app.js keeps the ESCAPED-slash shape
// (\/data\/uploads\/). If someone "cleans" the regex into an optional group like
// (?:\/)?data\/uploads\/, the literal bytes change and THIS static lock breaks.
const ESC = "\\/data\\/uploads\\/";   // == bytes: backslash slash data backslash slash uploads backslash slash

// app.js chat-body inline(): BOTH the image replace and the link replace must carry the branch.
const inlineFn = src.slice(src.indexOf("function inline(s) {"), src.indexOf("function inline(s) {") + 1400);
const imgLine  = (inlineFn.split("\n").find((l) => l.includes("!\\[")) || "");
const linkLine = (inlineFn.split("\n").find((l) => l.includes("\\[(")) || "");
check("app.js inline(): IMAGE replace line carries the escaped /data/uploads/ branch", imgLine.includes(ESC));
check("app.js inline(): LINK replace line carries the escaped /data/uploads/ branch", linkLine.includes(ESC));

// the shared inlineMedia (think/tool bodies) already had it — confirm it is intact (no regression).
const imFn = src.slice(src.indexOf("function inlineMedia(s) {"), src.indexOf("function inlineMedia(s) {") + 700);
check("inlineMedia() keeps the /data/uploads/ image branch", imFn.includes(ESC));

// http_server.py: route table maps the /data/uploads/ URL prefix to ROOT/data/uploads (the real
// drop-point, which is OUTSIDE the web root) — this is the whole point of the backend half.
check("http_server routes data/uploads/ prefix", /clean\.startswith\("data\/uploads\/"\)/.test(srv));
check("http_server maps it to ROOT/data/uploads", /Path\(ROOT\)\s*\/\s*"data"\s*\/\s*"uploads"/.test(srv));
check("http_server security check ALSO allows the uploads root prefix",
      /uploads_root[\s\S]{0,160}startswith\(str\(uploads_root\)\)/.test(srv) &&
      /startswith\(str\(web_root\)\)\s*or[\s\S]{0,40}startswith\(str\(uploads_root\)\)/.test(srv));

/* ─── LAYER 2: behaviour differential (pure-string replica of the render chain) ─ */
console.log("\n=== 2: behaviour differential ===");

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const MD_EXT_IMG = new Set(["png", "jpg", "jpeg", "gif", "webp", "apng", "avif", "bmp", "svg"]);
function mdKindOf(url) {
  const d = /^data:([a-z0-9.+-]+)\/([a-z0-9.+-]+)/i.exec(url);
  if (d) return d[1] === "image" ? "img" : (d[1] === "video" ? "video" : (d[1] === "audio" ? "audio" : "doc"));
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  if (m && MD_EXT_IMG.has(m[1].toLowerCase())) return "img";
  return "link";
}
const mdImageTag = (alt, url) => `<img class="md-img" src="${url}" alt="${alt}" loading="lazy">`;
function mdEmbedOrLink(label, url) {
  if (mdKindOf(url) === "img") return mdImageTag(label, url);
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
function render(md, withBranch) {
  const altImg = withBranch
    ? /!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+|\/data\/uploads\/[^)\s]+)\)/g
    : /!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+|data:image\/[^)\s]+)\)/g;          // CONTROL: old regex, no local branch
  const altLink = withBranch
    ? /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|data:(?:image|video|audio)\/[^)\s]+|\/data\/uploads\/[^)\s]+)\)/g
    : /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|data:(?:image|video|audio)\/[^)\s]+)\)/g;
  return esc(md).replace(altImg, (_, a, u) => mdImageTag(a, u)).replace(altLink, (_, l, u) => mdEmbedOrLink(l, u));
}

const LOCAL = "the downloaded image: ![result](/data/uploads/search/cat.png) right there";

// POSITIVE (with the branch): a local path becomes a real <img>.
const POS = render(LOCAL, true);
check("POSITIVE local /data/uploads/ -> <img class=md-img>", POS.includes('<img class="md-img" src="/data/uploads/search/cat.png"'));
// CONTROL (branch removed): the SAME input stays escaped text (no <img>) -> proves the new
// regex branch is load-bearing, not decorative.
const CTRL = render(LOCAL, false);
check("CONTROL (no branch) does NOT produce an <img> -> branch is load-bearing", !CTRL.includes("<img") && CTRL.includes("/data/uploads/search/cat.png"));

// regression: remote https + data: images still render on the WITH-branch path.
check("REGRESSION remote https image still renders", render("![x](https://x.com/y.png)", true).includes('<img class="md-img" src="https://x.com/y.png"'));
check("REGRESSION data: uri image still renders", render("![x](data:image/png;base64,AAAA)", true).includes('<img class="md-img" src="data:image/png;base64,AAAA'));

console.log("\n" + (FAILURES.length ? "UPLOADS-INLINE: " + FAILURES.length + " FAILURE(S) — " + FAILURES.join("; ") : "UPLOADS-INLINE: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
