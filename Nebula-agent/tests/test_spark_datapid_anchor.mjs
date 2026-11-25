/* ROOT-CAUSE A verification: run a spark whose image node is a BARE img (valid src, NO data-pid)
 * through the REAL app.js functions (jsdom-boot, same method as test_wire_image_url.mjs).
 * Prediction: sparkToPush returns images=[] (querySelectorAll("[data-pid]") finds nothing),
 * so the bubble falls to text-only while the LIST (innerHTML=s.html) still shows the image.
 * Standalone: node tests/_verify_rootcauseA.mjs
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
const check = (label, cond) => { console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN")); if (!cond) FAILURES.push(label); };
const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += "\n;window.__api = { sparkToPush, mixedSegments, apiMessages, sanitizeHtml, setMessages: (x) => { messages = x; }, setLastRag: (x) => { lastRag = x; } };";
win.eval(appCode);
const api = win.__api;
check("sparkToPush boots", typeof api.sparkToPush === "function");
check("mixedSegments boots", typeof api.mixedSegments === "function");
check("sanitizeHtml boots", typeof api.sanitizeHtml === "function");

const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A-NEGATIVE (the reported phenomenon): image node = bare img with valid src but NO data-pid.
const bareHtml = '图中渲染bug请修复<img class="inline-ce-img" src="' + DATA + '" alt="shot.png" title="shot.png">请修复';
const stored_bare = api.sanitizeHtml(bareHtml);
const push_bare = api.sparkToPush({ html: stored_bare, text: "图中渲染bug请修复" });
console.log("  bare stored:", stored_bare);
console.log("  bare push:", JSON.stringify(push_bare));
check("A-NEGATIVE bare-img spark: sparkToPush images=[] (no data-pid anchor -> bubble text-only)", push_bare.images.length === 0);
check("A-NEGATIVE bare-img spark: text kept", /图中渲染bug/.test(push_bare.text));

// A-POSITIVE (standard paste chain): data-pid present on the span anchor.
const spanHtml = '<span class="ce-thumb" contenteditable="false" data-pid="1" title="shot.png"><span class="ce-thumb__box"><img class="inline-ce-img" src="' + DATA + '" alt="shot.png" title="shot.png"></span></span>图中渲染bug请修复';
const stored_span = api.sanitizeHtml(spanHtml);
const push_span = api.sparkToPush({ html: stored_span, text: "图中渲染bug请修复" });
check("A-POSITIVE data-pid spark: sparkToPush images=1 (anchor found -> bubble shows image)", push_span.images.length === 1);

// full outbound: bare spark -> apiMessages emits content with NO image_url block (text-only bubble)
api.setLastRag("");
api.setMessages([{ role: "user", text: push_bare.text, images: push_bare.images, files: [], time: 1 }]);
const out = api.apiMessages();
const um = out.find((m) => m.role === "user");
const imgBlock = um && Array.isArray(um.content) && um.content.find((b) => b.type === "image_url");
check("A-NEGATIVE bare spark outbound -> NO image_url block in content (engine gets text-only)", !imgBlock);

console.log("\nROOTCAUSE-A: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
