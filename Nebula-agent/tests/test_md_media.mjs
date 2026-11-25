/* Gate: inline media typed in message text — image / video / audio / document card.
 *
 * Landed 2026-11-11 (single batch, image+video+audio+doc-card). inline() now emits an <img>
 * for ![alt](url) and dispatches [name](url) by media type; everything else keeps the old
 * byte-for-byte link output.
 *
 * Why static locks AND behaviour pairs:
 *   1) the ORDER of the two new branches is load-bearing — the image branch must run before
 *      the link branch (standard Markdown priority) or ![x](y) gets swallowed as a link;
 *   2) the type probe must strip ?query/#hash FIRST (bcebos-style "x.png?x-bce=..." URLs) and
 *      sniff data: URIs by MIME, not extension — both are easy to "fix" back into a bug;
 *   3) the animated-format path (gif/webp/apng) must stay on <img> — it rides native animation
 *      for free, so any code that reroutes it to <video> is a regression, not an improvement.
 *
 * The XSS contract is unchanged: label/url arrive already esc()-escaped, so the jsdom pairs
 * assert the entity round-trip instead of trusting it.
 *
 * Run standalone: node tests/test_md_media.mjs
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

const src = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const sprite = fs.readFileSync(path.join(WEB, "sprite.svg"), "utf-8");

/* ─── 1. static locks ─────────────────────────────────────────────────────────── */
console.log("=== 1: static source locks ===");

// the load-bearing order: image branch BEFORE the link branch inside inline()
const iA = src.indexOf("!\\[");
const iB = src.indexOf("\\[(");
const inlineFn = src.slice(src.indexOf("function inline(s) {"), src.indexOf("function inline(s) {") + 2000);
check("inline() has the image branch", inlineFn.includes("mdImageTag(alt, url)"));
check("inline() has the dispatch branch", inlineFn.includes("mdEmbedOrLink(label, url)"));
check("ORDER: image branch precedes link branch", inlineFn.indexOf("!\\[") < inlineFn.indexOf("mdEmbedOrLink"),
  `img=${inlineFn.indexOf("!\\[")} dispatch=${inlineFn.indexOf("mdEmbedOrLink")}`);

// the two new helpers must be DEFINED (not just called) — the paste_contract failure mode
for (const name of ["mdKindOf", "mdImageTag", "mdEmbedOrLink"]) {
  check(`app.js DEFINES function ${name}`, new RegExp(`function\\s+${name}\\s*\\(`).test(src));
  check(`app.js CALLS ${name}(`, new RegExp(`[^\\w]${name}\\(`).test(src));
}

// the URL alternation must accept data: URIs for the media that needs them
// source regex escapes the slash (data:image\/...) so assert on the unescaped prefix
  check("image branch accepts data:image/ URIs", inlineFn.includes("data:image"));
check("dispatch branch accepts data:(image|video|audio)/", inlineFn.includes("data:(?:image|video|audio)"));

// type probe: strip query/hash before probing the extension (bcebos-style URLs)
check("mdKindOf strips ?query/#hash before probing", /url\.split\(\/\[\?#\]/.test(src));
check("mdKindOf sniffs data: by MIME, not extension", /\^data:\(\[a-z0-9\.\+-\]/.test(src));

// the animated formats must be in the IMAGE set (they ride native <img> animation)
for (const ext of ["gif", "webp", "apng", "png", "avif"]) {
  check(`MD_EXT_IMG contains ${ext}`, new RegExp(`MD_EXT_IMG[\\s\\S]{0,400}"${ext}"`).test(src));
}
for (const ext of ["mp4", "webm"]) check(`MD_EXT_VIDEO contains ${ext}`, new RegExp(`MD_EXT_VIDEO[\\s\\S]{0,200}"${ext}"`).test(src));
for (const ext of ["mp3", "wav"]) check(`MD_EXT_AUDIO contains ${ext}`, new RegExp(`MD_EXT_AUDIO[\\s\\S]{0,200}"${ext}"`).test(src));
check("MD_EXT_DOC contains pdf (design decision)", /MD_EXT_DOC[\s\S]{0,400}"pdf"/.test(src));

// icon() takes the name WITHOUT the i- prefix (it adds it) — passing "i-attach" yields #i-i-attach
const iconFn = src.match(/const icon = \(name[^)]*\)\s*=>\s*`([^`]+)`/);
check("icon() builds #i-${name}", !!iconFn && iconFn[1].includes("#i-${name}"));
check("doc card calls icon() un-prefixed (attach)", /icon\("attach"\)/.test(src) && !/icon\("i-attach"\)/.test(src));
check("doc card calls icon() un-prefixed (download)", /icon\("download"\)/.test(src) && !/icon\("i-download"\)/.test(src));
check("sprite.svg ships i-attach", /<symbol[^>]*id="i-attach"/.test(sprite));
check("sprite.svg ships i-download", /<symbol[^>]*id="i-download"/.test(sprite));

// the zero-inline-handler invariant (the app has none; the broken-image fallback is pure CSS)
check("app.js emits NO inline onerror= attribute", !/onerror="/.test(src));
check("CSS defines .md-img", /\.md-img\s*\{/.test(css));
check("CSS defines .md-media", /\.md-media\s*\{/.test(css));
check("CSS defines .md-card", /\.md-card\s*\{/.test(css));
const mdImgRule = (css.match(/\.md-img\s*\{[^}]*\}/) || [""])[0];
check(".md-img rule is not display:none", mdImgRule && !/display:\s*none/.test(mdImgRule));
check(".md-img fallback uses background+border (pseudo-elements do not render on <img>)",
  mdImgRule.includes("background:") && mdImgRule.includes("border:"));

// i18n pairing (test_i18n.mjs locks zh/en symmetry; here we lock that app.js actually CALLS them)
for (const k of ["md.video.unsupported", "md.audio.unsupported"]) {
  check(`i18n.js defines ${k} (both languages)`, (i18nSrc.match(new RegExp(`"${k}"`, "g")) || []).length === 2);
  check(`app.js CALLS t("${k}")`, src.includes(`t("${k}")`));
}

// delegation: body pictures open the viewer on single click via a dedicated delegate that
// matches ONLY md-img — so it cannot double-fire with the pre-existing dblclick path.
check("a dedicated click delegate exists for img.md-img", /addEventListener\("click"[\s\S]{0,200}img\.md-img/.test(src));
const dbl = src.match(/\$\("chat"\)\.addEventListener\("dblclick"[\s\S]{0,300}?\}\);/);
check("the pre-existing dblclick delegate does NOT include md-img", !!dbl && !/md-img/.test(dbl[0]));
check("the click delegate opens the viewer", /addEventListener\("click"[\s\S]{0,220}openImageView\(img\.src/.test(src));

/* ─── 2. behaviour pairs (jsdom, on-disk app.js) ───────────────────────────────── */
console.log("\n=== 2: behaviour pairs ===");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
appCode += "\n;window.__api = { inline, markdown, blocks, mdKindOf, inlineMedia, thinkRich, toolBodyHtml, esc };\n";
win.eval(appCode);
const api = win.__api;
check("inline boots as a real function", typeof api.inline === "function");
check("mdKindOf boots as a real function", typeof api.mdKindOf === "function");

const box = (s) => { const d = win.document.createElement("div"); d.innerHTML = s; return d; };
const q = (s, sel) => box(s).querySelector(sel);

// the type probe directly (fast, no regex guessing at the shell)
check("probe: .png -> img", api.mdKindOf("https://x.com/a.png") === "img");
check("probe: .gif -> img (animated rides native <img>)", api.mdKindOf("https://x.com/a.gif") === "img");
check("probe: .mp4 -> video", api.mdKindOf("https://x.com/a.mp4") === "video");
check("probe: .mp3 -> audio", api.mdKindOf("https://x.com/a.mp3") === "audio");
check("probe: .pdf -> doc", api.mdKindOf("https://x.com/a.pdf") === "doc");
check("probe: bare link -> link (behaviour unchanged)", api.mdKindOf("https://x.com/a") === "link");
check("probe: query stripped (bcebos style) -> img", api.mdKindOf("https://x.com/a.png?x-bce-process=image/resize") === "img");
check("probe: hash stripped -> video", api.mdKindOf("https://x.com/a.mp4#t=0.5") === "video");
check("probe: data: sniffed by MIME -> img", api.mdKindOf("data:image/png;base64,AAAA") === "img");
check("probe: data: sniffed by MIME -> video", api.mdKindOf("data:video/mp4;base64,AAAA") === "video");

// end-to-end through inline()
const A = api.inline("![cat](https://x.com/cat.png)");
check("POSITIVE ![alt](png) -> <img class=md-img>", !!q(A, "img.md-img") && q(A, "img.md-img").getAttribute("src") === "https://x.com/cat.png");
check("POSITIVE alt text survives", q(A, "img.md-img").getAttribute("alt") === "cat");
check("POSITIVE empty alt still emits an img", !!q(api.inline("![](https://x.com/a.png)"), "img.md-img"));
check("POSITIVE animated gif through inline() -> img, not video", !!q(api.inline("![m](https://x.com/m.gif)"), "img.md-img") && !/\<video/.test(api.inline("![m](https://x.com/m.gif)")));

const V = api.inline("[clip](https://x.com/clip.mp4)");
check("POSITIVE [name](mp4) -> <video class=md-media controls>", !!q(V, "video.md-media") && q(V, "video.md-media").hasAttribute("controls"));
check("POSITIVE video keeps a fallback child (t() resolved, non-empty)", (q(V, "video.md-media").textContent || "").trim().length > 0,
  JSON.stringify(q(V, "video.md-media").textContent));

const AU = api.inline("[voice](https://x.com/voice.mp3)");
check("POSITIVE [name](mp3) -> <audio class=md-media controls>", !!q(AU, "audio.md-media") && q(AU, "audio.md-media").hasAttribute("controls"));

const D = api.inline("[report](https://x.com/report.pdf)");
check("POSITIVE [name](pdf) -> <a class=md-card>", !!q(D, "a.md-card") && q(D, "a.md-card").getAttribute("href") === "https://x.com/report.pdf");
check("POSITIVE doc card shows the label as its name", (q(D, ".md-card__name") || {}).textContent === "report");
check("POSITIVE doc card carries both sprite icons", !!q(D, ".md-card__ico use") && !!q(D, ".md-card__act use"));
check("POSITIVE doc card icons resolve to i-attach / i-download",
  /#i-attach$/.test(q(D, ".md-card__ico use").getAttribute("href")) && /#i-download$/.test(q(D, ".md-card__act use").getAttribute("href")));

// NEGATIVE: a plain link must stay byte-for-byte the old output (the regression lock)
const L = api.inline("[docs](https://example.com/page)");
check("NEGATIVE plain link keeps the exact old shape",
  L === '<a href="https://example.com/page" target="_blank" rel="noopener noreferrer">docs</a>', JSON.stringify(L));
check("NEGATIVE plain link is not a card", !/md-card/.test(L));

// XSS contract: label/url arrive esc()-escaped; entity round-trip, no live element
const X = api.inline("![a<b](https://x.com/a&b)");
check("XSS: alt attribute holds the escaped label, no live element", q(X, "img.md-img").getAttribute("alt") === "a<b" && X.includes("a&lt;b"));
const X2 = api.inline("[a<b](https://x.com/r.pdf?a&b)");   // extension present -> doc-card path
check("XSS: doc-card name decodes back to the label", q(X2, ".md-card__name").textContent === "a<b");
check("XSS: no script executed (single element, no nested handler run)", box(X2).querySelectorAll("script").length === 0);
  // esc() ran over the whole line, so the source text must hold the ENTITY; the parsed
  // attribute decodes back to the raw &. Both halves asserted (the entity round-trip).
  check("XSS: ampersand in URL survives as an entity",
    X2.includes("&amp;") && q(X2, "a.md-card").getAttribute("href") === "https://x.com/r.pdf?a&b");

// priority differential: ![x](y) must win over the link branch (this is what the ORDER lock protects)
check("PRIORITY: image syntax is not swallowed as a link", !!q(api.inline("before ![i](https://x.com/i.png) after"), "img.md-img"));
const TWO = api.inline("[one](https://x.com/one) mid [two](https://x.com/two.png)");
check("PRIORITY: two links on one line do not swallow each other",
  box(TWO).querySelectorAll("a[href]").length === 1 && box(TWO).querySelectorAll("img").length === 1, JSON.stringify(TWO));

// the whole path end-to-end: a body line with an image renders the media through markdown()
const M = api.markdown("look: ![i](https://x.com/i.png)", true);
check("end-to-end markdown(inlineFlow) renders the inline image", !!q(M, "img.md-img"));
const M2 = api.markdown("look: [doc](https://x.com/doc.pdf)", true);
check("end-to-end markdown(inlineFlow) renders the doc card", !!q(M2, "a.md-card"));

/* --- 3. think-area / tool-card media dispatch (2026-11-11 follow-up) ---
 * These regions must stay VERBATIM except for real media syntax, so the load-bearing
 * differential is: text with NO media syntax renders byte-identical to esc(). If a future
 * edit wires the FULL inline() (bold/em/code) into the think area, a paired "*" in prose
 * (e.g. "a * b * c") gets eaten as <em> and this section goes red. */
console.log("\n=== 3: thinkRich + tool-card media dispatch ===");

check("app.js DEFINES function inlineMedia", /^function inlineMedia\s*\(/m.test(src));
const imBody = (src.match(/^function inlineMedia\(s\) \{[\s\S]*?\n\}/m) || [""])[0];
check("inlineMedia is media-ONLY (no strong/em/inline-code inside)", !!imBody && !/strong|<em>|class="inline"/.test(imBody));
check("thinkRich paints the prose div through inlineMedia", /st-think__txt">\$\{inlineMedia\(x\)}/.test(src));
check("tool-card RESULT pre routes through inlineMedia", /tool-call__pre">\$\{inlineMedia\(tool\.result\)}/.test(src));
check("tool-card ARGUMENTS pre stays esc()-verbatim (JSON must not be re-dispatched)", /tool-call__pre">\$\{esc\(toolArgs\(tool\)/.test(src));

// verbatim differential: no media syntax -> inlineMedia == esc, byte for byte
for (const plain of ["只有想法，没有代码。", "a * b * c", "3 * 2 = 6", "he said \"hi\"",
                     '["alpha", "beta"]', "x < y & z", "100% * done", "a `literal` b", "[y](z)"]) {
  check(`verbatim(no-media): inlineMedia == esc for ${JSON.stringify(plain)}`,
    api.inlineMedia(plain) === api.esc(plain), JSON.stringify(api.inlineMedia(plain)));
}

// thinkRich end-to-end
const T1 = box(api.thinkRich("reading the file ![pic](https://x.com/p.png) now"));
check("thinkRich renders an inline image", !!T1.querySelector("img.md-img"));
check("thinkRich keeps surrounding prose verbatim", T1.querySelector(".st-think__txt").textContent.includes("reading the file"));
const T2 = box(api.thinkRich("note: a * b * c stays literal"));
check("thinkRich does NOT eat a paired asterisk (media-only, no em)", T2.querySelector(".st-think__txt").textContent.includes("a * b * c"),
  JSON.stringify(T2.querySelector(".st-think__txt").textContent));
const TPdf = box(api.thinkRich("see [report](https://x.com/r.pdf) below"));
check("thinkRich dispatches a pdf link to a doc card", !!TPdf.querySelector("a.md-card"));
const TVid = box(api.thinkRich("clip [v](https://x.com/v.mp4) end"));
check("thinkRich dispatches an mp4 link to <video>", !!TVid.querySelector("video.md-media"));

// tool-card body end-to-end
const tool = (over) => Object.assign({ name: "w", tool: "w", arguments: {}, state: "ok", ok: true, open: true }, over);
const TB = box(api.toolBodyHtml(tool({ result: "wrote ![pic](https://x.com/p.png) done" })));
check("tool-card body renders an inline image from the result", !!TB.querySelector("img.md-img"));
const TBv = box(api.toolBodyHtml(tool({ arguments: { "a* b": "x [y](z)" }, result: "a * b * c" })));
const pres = TBv.querySelectorAll(".tool-call__pre");
check("tool-card ARGS pre stays verbatim (JSON keys untouched)", pres[0].textContent.includes('"a* b"'), JSON.stringify(pres[0].textContent));
check("tool-card RESULT pre keeps a paired asterisk literal", pres[1].textContent.includes("a * b * c"), JSON.stringify(pres[1].textContent));

console.log("\n" + (FAILURES.length ? "MD-MEDIA: " + FAILURES.length + " FAILURE(S) — " + FAILURES.join("; ") : "MD-MEDIA: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
