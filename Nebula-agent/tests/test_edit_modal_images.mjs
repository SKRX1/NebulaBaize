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

// seeded conversation: index 2 is the LAST user message we edit (nothing after it, so a
// soft/hard resend truncates to length 3 and the edited message is the last prompt).
const seeded = [
  { role: "user", text: "Hello", time: 1 },
  { role: "assistant", text: "Hi there.", time: 2 },
  { role: "user", text: "With image?", time: 3 },
];
win.localStorage.setItem("strata.chat", JSON.stringify(seeded));

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
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model", images: true, max_context: 200000 }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "Answer with the image." } }] })}\n`, "data: [DONE]\n"]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;
win.addEventListener("error", (e) => console.log("  WINDOW ERROR:", e.error ? (e.error.stack || e.error) : e.message));

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
// app.js runs in ONE eval; its top-level `let/const` AND function declarations are lexically
// scoped to that eval (jsdom outside-only does not surface them on window). So EVERYTHING the
// test needs — live variables and the functions it calls — is exported from the SAME eval via
// __peek. Variables are getters (they are reassigned at runtime); functions are direct refs.
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
  renderEditAttachments: (...a) => renderEditAttachments(...a),
  insertPlaceholder: (...a) => insertPlaceholder(...a),
  undoEdit: (...a) => undoEdit(...a),
  attachNextPid: (...a) => attachNextPid(...a),
};`;
  win.eval(appSrc + peek);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = () => win.__peek;        // the single export bridge built inside app.js's eval
const v = (key) => P()[key]();     // live value of a page lexical var (getter)

const main = async () => {
  await sleep(40);

  check("health.images is on (feature precondition)", v("health").images === true);

  console.log("=== open edit modal on the last user message (index 2) ===");
  P().openEditModal(2);
  const modal = doc.querySelector("#edit-modal");
  check("edit modal opened", !!modal && !modal.hidden);
  const ta = modal && modal.querySelector("#edit-area");
  check("modal edit area prefilled", !!ta && ta.textContent === "With image?", ta ? JSON.stringify(ta.textContent) : "no edit area");

  console.log("\n=== D1: the modal owns an INDEPENDENT attachment list (scope parametrization) ===");
  check("composer global attachments starts empty", v("attachments").length === 0);
  const pid = P().attachNextPid();
  v("editAttachments").push({ kind: "image", name: "pasted.png", url: "data:image/png;base64,iVBORw0KGgo=", pid });
  P().renderEditAttachments();
  P().insertPlaceholder(pid, ta);   // drop the [img:N] reference at the caret, in the MODAL box
  check("placeholder tag landed in the modal edit area", ta.textContent.includes(`[img:${pid}]`), JSON.stringify(ta.textContent));
  check("modal-scoped list holds the image", v("editAttachments").length === 1);
  check("composer global list still untouched (no cross-contamination)", v("attachments").length === 0, `len=${v("attachments").length}`);

  console.log("\n=== select HARD strategy (the one that used to be non-undoable) ===");
  const hardOpt = modal.querySelector('.edit-strategy__opt[data-v="hard"]');
  check("hard strategy option exists", !!hardOpt);
  hardOpt.click();
  check("strategy is hard", modal.dataset.strategy === "hard", String(modal.dataset.strategy));

  console.log("\n=== send: the image must ride along on the sent message ===");
  const chatBefore = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  modal.querySelector("#edit-send").click();   // confirmEdit -> captures imgs -> closeEditModal -> editResend
  await sleep(150);
  const chatAfter = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("exactly one completion issued", chatAfter.length === chatBefore + 1, `before=${chatBefore} after=${chatAfter.length}`);
  if (chatAfter.length === chatBefore + 1) {
    const nonsys = chatAfter[chatAfter.length - 1].body.messages.filter((m) => m.role !== "system");
    const edited = nonsys[nonsys.length - 1];
    check("the edited message was sent multimodal (image part present)", Array.isArray(edited.content)
      && edited.content.some((p) => p.type === "image_url" || p.type === "image"),
      JSON.stringify(edited && (Array.isArray(edited.content) ? edited.content.map((p) => p.type) : edited.content)));
    // mixedSegments replaces the [img:N] placeholder with a real image part; the surviving text
    // part must carry the typed words. (Asserting the LITERAL [img:N] here would be WRONG — the
    // whole point of the feature is that the placeholder becomes the image.)
    check("the typed text survived beside the image part", Array.isArray(edited.content)
      && edited.content.some((p) => p.type === "text" && /With image/.test(p.text || "")),
      JSON.stringify(Array.isArray(edited.content) && edited.content.map((p) => p.type + ":" + (p.text || p.url || "").slice(0, 20))));
  }

  console.log("\n=== D3: HARD is now undoable (differential vs the old undoStack=null) ===");
  check("undoStack is NON-NULL after a hard resend (the fix)", v("undoStack") != null,
    JSON.stringify(v("undoStack") && { at: v("undoStack").at, hasImgs: ("editedFromImages" in v("undoStack")) }));

  console.log("\n=== undo restores the edited message ===");
  P().undoEdit();
  await sleep(30);
  const editedMsg = v("messages")[2];   // the message we edited
  check("undo restored the original edited text", editedMsg && editedMsg.text === "With image?", editedMsg ? JSON.stringify(editedMsg.text) : "no message");
  // The edited message had NO images before the edit, so undo must bring it back image-free
  // (locked by editedFromImages === undefined). This proves undo reverts BOTH text and images.
  check("undo reverted images too (back to the pre-edit state = none)", editedMsg && (editedMsg.images == null || editedMsg.images.length === 0),
    editedMsg ? JSON.stringify(editedMsg.images) : "no message");
  check("undoStack consumed", v("undoStack") === null);

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); win.close(); process.exit(1); }
  console.log("EDIT-MODAL-IMAGES: ALL GREEN");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
