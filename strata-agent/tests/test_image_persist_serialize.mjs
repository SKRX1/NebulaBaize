/* Gate: saveChat must preserve base64 url when ref is empty (the root cause of image loss on reload).
 *
 * Root cause: addFiles uploads async -> ref is only set after fetch returns.
 * If the user sends before the upload resolves (or offline), ref stays undefined.
 * Old saveChat unconditionally mapped images to {name, pid, ref} — dropping url —
 * so on reload the image was gone (render reads ref || url; both were empty).
 *
 * Fix: saveChat keeps {name, pid, ref} when ref exists (lightweight), otherwise
 * falls back to {name, pid, url} (inline base64).  This test drives the REAL saveChat
 * in jsdom and verifies BOTH branches with a differential pair.
 *
 * Run standalone: node tests/test_image_persist_serialize.mjs
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

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;
win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

// --- boot the page scripts ---
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));

// Build the exposed API so we can call saveChat and read/write state
let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
appCode += `
;window.__api = {
  saveChat, getMessages: () => messages, setMessages: (v) => { messages = v; },
  getSessions: () => sessions, setSessions: (v) => { sessions = v; },
  getActiveId: () => activeId, setActiveId: (v) => { activeId = v; },
  getBranches: () => branches, getLiveMessages: () => liveMessages,
  getActiveBranchId: () => activeBranchId,
  mixedSegments, store
};`;
win.eval(appCode);
const api = win.__api;

// --- Test A: image with ref -> stored as lightweight {name, pid, ref} (no url) ---
check("A1. saveChat keeps ref and omits url when ref exists", (() => {
  const testSessions = [{ id: "test-a", name: "TestA", messages: [], updatedAt: 0 }];
  api.setSessions(testSessions);
  api.setActiveId("test-a");
  const msgs = [{ role: "user", text: "hello", time: 1, images: [{ name: "pic.png", pid: 1, ref: "/data/uploads/img-abc.png", url: "data:image/png;base64,AAAA" }] }];
  api.setMessages(msgs);
  api.saveChat();
  // read from localStorage
  const raw = win.localStorage.getItem("strata.sessions");
  if (!raw) return false;
  const s = JSON.parse(raw);
  const sess = s.find(x => x.id === "test-a");
  if (!sess || !sess.messages || !sess.messages[0]) return false;
  const img = sess.messages[0].images[0];
  return img.ref === "/data/uploads/img-abc.png" && img.url === undefined;
})());

// --- Test B (DIFFERENTIAL - root cause lock): image with url but NO ref -> url must be PRESERVED ---
check("B1. saveChat preserves url when ref is empty (root-cause fix)", (() => {
  const testSessions = [{ id: "test-b", name: "TestB", messages: [], updatedAt: 0 }];
  api.setSessions(testSessions);
  api.setActiveId("test-b");
  const msgs = [{ role: "user", text: "img test", time: 1, images: [{ name: "pasted image", pid: 2, url: "data:image/png;base64,BBBBB", ref: undefined }] }];
  api.setMessages(msgs);
  api.saveChat();
  const raw = win.localStorage.getItem("strata.sessions");
  if (!raw) return false;
  const s = JSON.parse(raw);
  const sess = s.find(x => x.id === "test-b");
  if (!sess || !sess.messages || !sess.messages[0]) return false;
  const img = sess.messages[0].images[0];
  // url MUST be preserved for the fallback to work on reload
  return img.url === "data:image/png;base64,BBBBB" && img.ref === undefined;
})());

// --- Test C: render reads ref||url -- mixedSegments must include url-only images ---
check("C1. mixedSegments includes url-only image (no ref, has url)", (() => {
  const m = { text: "see [img:3] here", images: [{ pid: 3, url: "data:image/png;base64,CCC", name: "x.png" }] };
  const segs = api.mixedSegments(m);
  return Array.isArray(segs) && segs.length === 3 && segs[1].type === "image" && segs[1].url === "data:image/png;base64,CCC";
})());

// --- Test D: differential control -- image with neither ref nor url is filtered out by mixedSegments ---
check("D1. mixedSegments skips image with neither ref nor url (renders as chip)", (() => {
  const m = { text: "see [img:9] here", images: [{ pid: 9, name: "orphan.png" }] };
  const segs = api.mixedSegments(m);
  // images filter: (a.url || a.ref) -> neither -> empty -> no image segments -> returns null (no placeholder hit via byPid)
  // Actually placeholder matches pid 9 but byPid[9] is the item with no url/ref -> filter removes it
  // The regex finds [img:9] but byPid is empty (no matching item after filter) -> hit=true but seg has no image
  // hit=true -> not null; segs = [text "see ", text " here"] (placeholder matched but no image added)
  return Array.isArray(segs) && segs.every(s => s.type === "text");
})());

// --- Test E: msgEl render path reads ref||url (static lock) ---
check("E1. app.js msgEl renders from im.ref || im.url (static lock)",
  /if\s*\(im\.ref\s*\|\|\s*im\.url\)/.test(fs.readFileSync(path.join(WEB, "app.js"), "utf8")));

// --- Test F: saveChat serialization lock (static) -- the new conditional ---
check("F1. app.js saveChat has the ref-or-url conditional (static lock)",
  /i\.ref\s*\?\s*\{.*ref:.*\}\s*:\s*\{.*url:/.test(fs.readFileSync(path.join(WEB, "app.js"), "utf8")));

console.log("\nIMAGE PERSIST SERIALIZE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
