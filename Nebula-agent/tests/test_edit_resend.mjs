/* Regression test for edit & resend (custom modal + soft/hard/branch strategies).
 *
 * Seeds a 4-message conversation (user A / assistant A / user B / assistant B). Edits the MIDDLE
 * user message (index 2) in the custom edit modal, commits via the 重新生成 button (default
 * strategy: soft delete), and asserts:
 *   1. the edit opens the #edit-modal with a textarea prefilled with the current text.
 *   2. the downstream preview lists exactly the 1 message that will be affected.
 *   3. NO native confirm() is used (the modal replaced it).
 *   4. exactly one chat completion request is issued.
 *   5. the truncated payload carries user A, assistant A, and the EDITED user B (the old
 *      assistant B reply after the edited message is discarded, not preserved).
 *   6. after the stream, the chat shows 4 messages and the last is the freshly generated answer.
 *
 * Run: node tests/test_edit_resend.mjs
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

const seeded = [
  { role: "user", text: "First question", time: 1 },
  { role: "assistant", text: "First answer.", time: 2 },
  { role: "user", text: "Second question", time: 3 },
  { role: "assistant", text: "Second answer.", time: 4 },
];
win.localStorage.setItem("strata.chat", JSON.stringify(seeded));

const calls = [];
const confirmCalls = [];
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
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Edited answer." } }] })}\n`,
      "data: [DONE]\n",
    ]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = (msg) => { confirmCalls.push(msg); return true; };
win.addEventListener("error", (e) => console.log("  WINDOW ERROR:", e.error ? (e.error.stack || e.error) : e.message));

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  console.log("=== edit-in-place + truncate-and-regenerate regression ===");
  await sleep(30);

  const editBtn = doc.querySelector('#chat .st-msg[data-i="2"] [data-action="edit"]');
  check("edit button present on the middle user message", !!editBtn);

  let threw = null;
  try { if (editBtn) editBtn.click(); } catch (e) { threw = e; }
  check("click handler did not throw synchronously", threw === null, threw ? String(threw) : "");

  const modal = doc.querySelector("#edit-modal");
  check("edit modal opened", !!modal && !modal.hidden);
  const ta = modal && modal.querySelector("#edit-area");
  check("modal is prefilled with the current text", !!ta && ta.textContent === "Second question", ta ? JSON.stringify(ta.textContent) : "no edit area");
  if (!modal || !ta) { console.log("\nFAILED (no modal, cannot continue)"); win.close(); process.exit(1); }

  const previewItems = modal.querySelectorAll("#edit-preview .edit-preview__item:not(.edit-preview__ph)");
  check("downstream preview lists the 1 affected message", previewItems.length === 1, `got ${previewItems.length}`);
  // 2026-10-28 user decision: the default is HARD delete (zhen-shan-chu, leftmost card; template order hard|soft|branch)
  check("default strategy is hard delete", modal.dataset.strategy === "hard", String(modal.dataset.strategy));

  ta.textContent = "Second question EDITED";
  modal.querySelector("#edit-send").click();

  await sleep(20);
  check("no native confirm() is used (modal replaced it)", confirmCalls.length === 0, JSON.stringify(confirmCalls));

  await sleep(80);

  const chatCalls = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("exactly one chat completion request", chatCalls.length === 1, `got ${chatCalls.length}`);
  if (chatCalls.length === 1) {
    const nonsys = chatCalls[0].body.messages.filter((m) => m.role !== "system");
    check("payload truncated to 3 non-system messages (user, assistant, edited user)",
      nonsys.length === 3, `roles=${JSON.stringify(nonsys.map((m) => m.role))}`);
    check("first turn preserved", nonsys[0] && nonsys[0].role === "user" && nonsys[0].content === "First question");
    check("assistant A preserved", nonsys[1] && nonsys[1].role === "assistant" && /First answer/.test(nonsys[1].content || ""));
    check("edited message is the last prompt in the request",
      nonsys[2] && nonsys[2].role === "user" && nonsys[2].content === "Second question EDITED",
      JSON.stringify(nonsys.map((m) => m.content)));
  }

  const msgs = doc.querySelectorAll("#chat .st-msg");
  check("chat shows 4 messages (A/A/B/edited-answer)", msgs.length === 4, `len=${msgs.length}`);
  const lastText = msgs.length ? msgs[msgs.length - 1].textContent : "";
  check("regenerated reply rendered", /Edited answer\./.test(lastText), JSON.stringify(lastText.slice(0, 40)));

  // ── Phase 2: branch strategy + branch switcher (dataset ids are strings; branch ids are numbers) ──
  console.log("\n=== branch strategy + branch switcher regression ===");
  const editBtn2 = doc.querySelector('#chat .st-msg[data-i="2"] [data-action="edit"]');
  check("edit button present again on the middle user message", !!editBtn2);
  if (editBtn2) editBtn2.click();
  const modal2 = doc.querySelector("#edit-modal");
  check("edit modal reopened", !!modal2 && !modal2.hidden);
  if (!modal2) { console.log("\nFAILED (no modal, cannot continue)"); win.close(); process.exit(1); }

  const branchOpt = modal2.querySelector('.edit-strategy__opt[data-v="branch"]');
  check("branch strategy option exists", !!branchOpt);
  branchOpt.click();
  check("branch strategy selected", modal2.dataset.strategy === "branch", String(modal2.dataset.strategy));

  modal2.querySelector("#edit-area").textContent = "Second question BRANCHED";
  modal2.querySelector("#edit-send").click();
  await sleep(120);

  const bar = doc.querySelector("#branch-bar");
  check("branch bar rendered after branch resend", !!bar && !bar.hidden);
  const chips = bar ? bar.querySelectorAll(".branch-chip") : [];
  check("branch bar has 2 chips (live + saved branch)", chips.length === 2, `got ${chips.length}`);
  check("live chip is current before switching",
    chips[0] && chips[0].getAttribute("aria-current") === "true");

  const branchChip = bar ? bar.querySelector('.branch-chip[data-bid="1"]') : null;
  check("saved-branch chip has data-bid=1", !!branchChip);
  let threw2 = null;
  try { if (branchChip) branchChip.click(); } catch (e) { threw2 = e; }
  check("clicking the branch chip did not throw", threw2 === null, threw2 ? String(threw2) : "");
  await sleep(30);

  const afterBranch = doc.querySelectorAll("#chat .st-msg");
  check("branch view shows the 4-message history", afterBranch.length === 4, `len=${afterBranch.length}`);
  const branchMid = afterBranch.length > 2 ? afterBranch[2].textContent : "";
  check("branch shows the history AS IT WAS at edit time (pre-phase-2 edit)",
    /Second question EDITED/.test(branchMid) && !/BRANCHED/.test(branchMid),
    JSON.stringify(branchMid.slice(0, 40)));
  const freshBranchChip = doc.querySelector('#branch-bar .branch-chip[data-bid="1"]');
  check("branch chip is current after switching (re-queried after re-render)",
    !!freshBranchChip && freshBranchChip.getAttribute("aria-current") === "true");

  const liveChip = doc.querySelector('#branch-bar .branch-chip[data-bid=""]');
  check("live chip present", !!liveChip);
  if (liveChip) liveChip.click();
  await sleep(30);
  const afterLive = doc.querySelectorAll("#chat .st-msg");
  const liveMid = afterLive.length > 2 ? afterLive[2].textContent : "";
  check("switching back to live restores the branched thread", /Second question BRANCHED/.test(liveMid),
    JSON.stringify(liveMid.slice(0, 40)));
  const freshLiveChip = doc.querySelector('#branch-bar .branch-chip[data-bid=""]');
  check("live chip is current again (re-queried after re-render)",
    !!freshLiveChip && freshLiveChip.getAttribute("aria-current") === "true");

  // ── Phase 3: same-text resend is ALLOWED (means "regenerate from here"); only empty is blocked ──
  console.log("\n=== same-text resend (regenerate from here) regression ===");
  const callsBefore = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  const editBtn3 = doc.querySelector('#chat .st-msg[data-i="2"] [data-action="edit"]');
  check("edit button present for phase 3", !!editBtn3);
  if (editBtn3) editBtn3.click();
  const modal3 = doc.querySelector("#edit-modal");
  check("edit modal reopened for phase 3", !!modal3 && !modal3.hidden);
  if (!modal3) { console.log("\nFAILED (no modal, cannot continue)"); win.close(); process.exit(1); }
  const textNow = modal3.querySelector("#edit-area").textContent;
  check("textarea prefilled with the current (unedited) text", textNow === "Second question BRANCHED", JSON.stringify(textNow));
  modal3.querySelector("#edit-send").click();          // unchanged text, straight resend
  await sleep(120);
  const callsAfter = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("same-text resend still issues a completion (not blocked)", callsAfter.length === callsBefore + 1,
    `before=${callsBefore} after=${callsAfter.length}`);
  if (callsAfter.length === callsBefore + 1) {
    const nonsys3 = callsAfter[callsAfter.length - 1].body.messages.filter((m) => m.role !== "system");
    check("resend payload keeps the same user text",
      nonsys3[nonsys3.length - 1] && nonsys3[nonsys3.length - 1].content === "Second question BRANCHED",
      JSON.stringify(nonsys3.map((m) => m.content)));
  }
  const emptyModal = doc.querySelector("#edit-modal");
  if (emptyModal) {                                    // empty body must still be rejected
    const editBtn4 = doc.querySelector('#chat .st-msg[data-i="2"] [data-action="edit"]');
    if (editBtn4) editBtn4.click();
    await sleep(10);
    const m4 = doc.querySelector("#edit-modal");
    m4.querySelector("#edit-area").textContent = "   ";
    m4.querySelector("#edit-send").click();
    await sleep(20);
    check("empty body is still rejected (no extra completion)",
      calls.filter((c) => c.url.endsWith("v1/chat/completions")).length === callsAfter.length);
  }

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); win.close(); process.exit(1); }
  console.log("EDIT-RESEND: ALL PASSED");
  win.close();
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
