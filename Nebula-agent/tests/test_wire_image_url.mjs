/* Gate: the OUTBOUND wire format for images must always be the engine-resolvable data URL,
 * never the browser-relative server ref, on BOTH assembly routes.
 *
 * Root cause this locks (2026-10-31): when an async upload succeeded and `ref` landed, the
 * anchor route (mixedSegments) set image_url.url = a.ref||a.url = "uploads/xxx.png" — a browser-
 * relative path the upstream engine cannot fetch, so it DROPPED the image and the agent received
 * text-only. The fix routes BOTH paths through one helper wireImageUrl() = a.url||a.ref (data URL
 * first). A single helper shared by both routes also stops them drifting apart later.
 *
 * Differential pairs (the real net, exercised through live functions booted from source text):
 *   POSITIVE: url + ref both present  -> wire is the data URL (NOT uploads/...).
 *   NEGATIVE: only ref, no url        -> wire falls back to ref (no url to send).
 * Static locks confirm the helper is defined and both routes CALL it (guards against a future
 * revert back to inline a.ref||a.url that would silently re-introduce the drop).
 *
 * Run standalone: node tests/test_wire_image_url.mjs
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
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");

// --- static source locks (immune to eval scope) --------------------------------------------
check("source: wireImageUrl helper is defined", /function wireImageUrl\s*\(/.test(srcText));
check("source: helper returns url first (data URL priority)", /wireImageUrl\(a\)\{[^}]*a\.url\s*\|\|\s*a\.ref/.test(srcText));
check("source: anchor route (mixedSegments) calls the helper", /wire:\s*wireImageUrl\(a\)/.test(srcText));
check("source: fallback route (apiMessages imgs.map) calls the helper", /image_url:\s*\{\s*url:\s*wireImageUrl\(i\)\s*\}/.test(srcText));
check("source: anchor route emits sg.wire (not the raw sg.url)", /image_url:\s*\{\s*url:\s*sg\.wire\s*\}/.test(srcText));

// --- runtime boot: expose the live functions through a closure hook -----------------------
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { wireImageUrl, mixedSegments, apiMessages, setMessages: (x) => { messages = x; }, setLastRag: (x) => { lastRag = x; } };";
win.eval(appCode);
const api = win.__api;
check("wireImageUrl boots as a real function", typeof api.wireImageUrl === "function");
check("mixedSegments boots as a real function", typeof api.mixedSegments === "function");
check("apiMessages boots as a real function", typeof api.apiMessages === "function");

const DATA = "data:image/png;base64,AAA";
const REF = "uploads/xxx.png";

// --- helper direct: differential positive vs negative -------------------------------------
check("helper: url+ref both present -> data URL first (POSITIVE)", api.wireImageUrl({ url: DATA, ref: REF }) === DATA);
check("helper: only ref, no url -> falls back to ref (NEGATIVE)", api.wireImageUrl({ ref: REF }) === REF);
check("helper: only url, no ref -> data URL", api.wireImageUrl({ url: DATA }) === DATA);

// --- mixedSegments: wire field is the data URL, render url stays ref ---------------------
const m1 = { role: "user", text: "hi [img:1]", images: [{ pid: 1, url: DATA, ref: REF, kind: "image" }] };
const segs = api.mixedSegments(m1);
check("mixedSegments returns segments", Array.isArray(segs) && segs.length > 0);
const imgSeg = segs && segs.find((s) => s.type === "image");
check("mixedSegments image segment carries wire = data URL (fix)", imgSeg && imgSeg.wire === DATA);
check("mixedSegments render url stays ref (render path untouched)", imgSeg && imgSeg.url === REF);

// --- full apiMessages: the OUTBOUND payload image block url is the data URL --------------
api.setLastRag("");
api.setMessages([m1]);
const out1 = api.apiMessages();
const userMsg = out1.find((mm) => mm.role === "user");
check("apiMessages emits a multimodal content array for an anchored image message", Array.isArray(userMsg && userMsg.content));
const imgBlock = userMsg && Array.isArray(userMsg.content) && userMsg.content.find((b) => b.type === "image_url");
check("OUTBOUND payload image_url.url is the data URL, not uploads/ (THE FIX)", imgBlock && imgBlock.image_url.url === DATA);

// --- fallback route (no anchor in text): imgs.map goes through the helper ---------------
const m2 = { role: "user", text: "no anchor here", images: [{ pid: 2, url: DATA, ref: REF, kind: "image" }] };
api.setMessages([m2]);
const out2 = api.apiMessages();
const userMsg2 = out2.find((mm) => mm.role === "user");
const imgBlock2 = userMsg2 && Array.isArray(userMsg2.content) && userMsg2.content.find((b) => b.type === "image_url");
check("fallback route OUTBOUND image_url.url is the data URL via helper (THE FIX)", imgBlock2 && imgBlock2.image_url.url === DATA);

// --- negative: ref-only message (no url) — engine can't resolve a relative path today, but
//     the helper must still emit SOMETHING (the ref) so a future absolute-ref stays wireable;
//     the point of this lock is that a url-present case NEVER regresses to the ref. ----------
const m3 = { role: "user", text: "x [img:9]", images: [{ pid: 9, ref: REF, kind: "image" }] };
const segs3 = api.mixedSegments(m3);
const imgSeg3 = segs3 && segs3.find((s) => s.type === "image");
check("ref-only segment: wire falls back to ref (no url to prefer)", imgSeg3 && imgSeg3.wire === REF);

console.log("\nWIRE-IMAGE-URL: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
