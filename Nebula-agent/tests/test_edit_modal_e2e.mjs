/* E2E differential gate for the bubble-edit modal (2026-10-29 user report):
 * paste image / type text / delete image IN THE MODAL -> hard delete -> regenerate ->
 * the BUBBLE must reflect every change (text, image added, image deleted).
 * jsdom has no execCommand (paste falls back to appendChild) and a real File/FileReader/
 * clipboardData mock is injected. The full chain is exercised for real:
 *   openEditModal -> pasteImageToRich -> typed text node -> delete delegation -> strategy
 *   -> #edit-send click -> editResend -> messages + request payload + rendered bubble.
 * Run: node tests/test_edit_modal_e2e.mjs
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

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");

// seeded conversation: index 0 user WITHOUT images (the modal starts text-only, like the
// user's screenshot), index 1 assistant. The edit happens on index 0.
const seeded = [
  { role: "user", text: "mixed input test", time: 1 },
  { role: "assistant", text: "First answer.", time: 2 },
];
win.localStorage.setItem("strata.chat", JSON.stringify(seeded));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const calls = [];
function streamResponse(chunks) {
  let i = 0; const enc = new TextEncoder();
  return { ok: true, status: 200, json: async () => ({}),
    body: { getReader() { return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } } };
}
win.fetch = async (url, opts = {}) => {
  const u = String(url); const method = opts.method || "GET";
  calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", images: true }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("api/images/upload")) return { ok: true, status: 200, json: async () => ({ ref: "uploads/testpaste.png" }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Regenerated answer." } }] })}\n`,
      "data: [DONE]\n",
    ]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;
win.addEventListener("error", (e) => console.log("  WINDOW ERROR:", e.error ? (e.error.stack || e.error) : e.message));

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
{
  const appSrc = (fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8"));
  const peek = `
;window.__peek = {
  health: () => health,
  attachments: () => attachments,
  editAttachments: () => editAttachments,
  undoStack: () => undoStack,
  messages: () => messages,
  openEditModal: (...a) => openEditModal(...a),
  pasteImageToRich: (...a) => pasteImageToRich(...a),
  bindInlineThumbDelete: (...a) => bindInlineThumbDelete(...a),
};`;
  win.eval(appSrc + peek);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => win.__peek;
const v = (key) => P()[key]();

// a fake paste event: the modal path reads e.clipboardData.files
function fakePaste(files) {
  return { clipboardData: { files, items: {} }, preventDefault() { this._pd = true; } };
}

function lastBubbleText() {
  const el = doc.querySelector('#chat .st-msg[data-i="0"] .st-bubble');
  return el ? el.textContent.trim() : null;
}
function lastBubbleImgs() {
  const el = doc.querySelector('#chat .st-msg[data-i="0"]');
  return el ? Array.from(el.querySelectorAll("img")).map((i) => i.getAttribute("src")) : [];
}

const main = async () => {
  await sleep(60);
  check("health.images is on (feature precondition)", v("health").images === true);
  check("bubble starts text-only", lastBubbleText() === "mixed input test", JSON.stringify(lastBubbleText()));

  console.log("\n=== A: paste image + type text -> regenerate -> bubble shows BOTH (the reported bug) ===");
  P().openEditModal(0);
  const modal = doc.querySelector("#edit-modal");
  check("edit modal opened", !!modal && !modal.hidden);
  const ta = modal.querySelector("#edit-area");
  check("modal prefilled with the stored text", ta.textContent === "mixed input test", JSON.stringify(ta.textContent));
  const file = new win.File([Buffer.from(PNG_B64, "base64")], "pasted.png", { type: "image/png" });
  await P().pasteImageToRich(fakePaste([file]), ta);
  await sleep(60);   // FileReader + upload fetch are async
  check("paste landed an inline thumbnail in the modal edit area", !!ta.querySelector("[data-pid]"), ta.innerHTML.slice(0, 140));
  check("modal-scoped list holds the pasted image", v("editAttachments").length === 1, `len=${v("editAttachments").length}`);
  // simulate typing AFTER the chip (the caret was moved after it): a bare text node at top level
  ta.appendChild(doc.createTextNode(" plus typed words"));
  // default strategy is hard
  check("default strategy is hard delete", modal.dataset.strategy === "hard", String(modal.dataset.strategy));
  let chatCallsBefore = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  modal.querySelector("#edit-send").click();
  await sleep(150);
  let chatCalls = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("A: exactly one completion issued", chatCalls.length === chatCallsBefore + 1, `before=${chatCallsBefore} after=${chatCalls.length}`);
  const editedMsgA = v("messages")[0];
  check("A: stored text keeps BOTH typed words and the image anchor",
    /plus typed words/.test(editedMsgA.text || "") && /\[img:\d+\]/.test(editedMsgA.text || ""),
    JSON.stringify(editedMsgA && editedMsgA.text));
  check("A: stored message carries the pasted image", (editedMsgA.images || []).length === 1,
    JSON.stringify(editedMsgA && (editedMsgA.images || []).map((a) => a.name)));
  check("A: bubble text now contains the typed words", /plus typed words/.test(lastBubbleText() || ""), JSON.stringify(lastBubbleText()));
  check("A: bubble renders the inline image (interleaved)", lastBubbleImgs().length >= 1, JSON.stringify(lastBubbleImgs()));

  console.log("\n=== B: delete the pasted image (hover x), keep text -> regenerate -> bubble image-free ===");
  chatCallsBefore = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  P().openEditModal(0);
  check("modal reopened with the inline thumbnail", !!ta.querySelector("[data-pid]"), ta.innerHTML.slice(0, 140));
  const delX = ta.querySelector(".ce-thumb__x");
  check("delete button present on the thumbnail", !!delX);
  delX.click();
  await sleep(30);
  check("thumbnail node removed from the edit area", !ta.querySelector("[data-pid]"), ta.innerHTML.slice(0, 140));
  check("modal-scoped list dropped the image", v("editAttachments").length === 0, `len=${v("editAttachments").length}`);
  // the stored text of the CURRENT message (post-A) contains [img:N]; after the delete the DOM
  // must read back as text WITHOUT the anchor.
  modal.querySelector("#edit-send").click();
  await sleep(150);
  chatCalls = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("B: exactly one completion issued", chatCalls.length === chatCallsBefore + 1, `before=${chatCallsBefore} after=${chatCalls.length}`);
  const editedMsgB = v("messages")[0];
  check("B: stored text no longer carries the image anchor", !/\[img:\d+\]/.test(editedMsgB.text || ""), JSON.stringify(editedMsgB && editedMsgB.text));
  check("B: stored message is image-free (delete stuck)", (editedMsgB.images || []).length === 0,
    JSON.stringify(editedMsgB && editedMsgB.images));
  check("B: bubble is image-free", lastBubbleImgs().length === 0, JSON.stringify(lastBubbleImgs()));

  console.log("\n=== C: regenerate payload agrees with the stored message (request side) ===");
  const lastReq = chatCalls[chatCalls.length - 1];
  const nonsys = lastReq.body.messages.filter((m) => m.role !== "system");
  const userPrompt = nonsys[0];
  check("C: request prompt is plain text (no ghost image part)", typeof userPrompt.content === "string"
    ? /plus typed words/.test(userPrompt.content)
    : Array.isArray(userPrompt.content) && userPrompt.content.every((p) => p.type !== "image_url" && p.type !== "image"),
    JSON.stringify(userPrompt && (Array.isArray(userPrompt.content) ? userPrompt.content.map((p) => p.type + ":" + (p.text || p.url || "").slice(0, 24)) : userPrompt.content)));

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); win.close(); process.exit(1); }
  console.log("EDIT-MODAL-E2E: ALL GREEN");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
