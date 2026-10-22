/* Regression test for the "灵感便签" (Sparks) feature — M1 (capture → manage → execute).
 *
 * Loads the REAL index.html + i18n.js + app.js in jsdom and drives the real handlers:
 *   1. the Sparks tab renders and shows the empty state when there are no sparks.
 *   2. saving a spark from the tab's add box appends it to the list and bumps the tab badge.
 *   3. the docked composer strip (toggle → type → save) also captures a spark.
 *   4. running a spark while the AI is idle pushes its text as a user message into the
 *      current chat (a real POST to v1/chat/completions is fired carrying that text).
 *   5. deleting a spark removes it from the list and clears the badge when none remain.
 *
 * The busy→queue→idle-drain path (executeSpark queuing while `busy`, then
 * drainSparkQueue firing on idle) is asserted deterministically via win.eval("busy=..."),
 * which reaches the module-scoped `busy` binding loaded through win.eval.
 *
 * Run: node tests/test_spark.mjs
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

// globals app.js touches (jsdom doesn't always provide them)
win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);

win.localStorage.setItem("strata.lang", "en");      // stable strings
win.localStorage.removeItem("strata.spark");          // start clean
win.localStorage.removeItem("strata.chat");           // no seeded conversation

// fetch mock: capture chat requests, answer with a tiny SSE stream
const calls = [];
function streamResponse(chunks) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    ok: true, status: 200, json: async () => ({}),
    body: { getReader() { return { read() {
      if (i < chunks.length) return Promise.resolve({ value: enc.encode(chunks[i++]), done: false });
      return Promise.resolve({ value: undefined, done: true });
    } }; } },
  };
}
win.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
  if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
  if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
  if (u.endsWith("v1/chat/completions")) {
    return streamResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n`, "data: [DONE]\n"]);
  }
  return { ok: true, status: 200, json: async () => ({}) };
};
win.confirm = () => true;

// Load i18n.js + app.js in a SINGLE eval so the test bridge (appended in the same
// scope) can reach the module-scoped `busy` binding and `drainSparkQueue`/`executeSpark`
// via closures — a later separate win.eval cannot see eval-scoped let/function declarations.
const i18nCode = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const bridge = `
window.__test = {
  setBusy: function (v) { busy = v; },
  getBusy: function () { return busy; },
  drain: function () { return drainSparkQueue(); },
  execute: function (id) { return executeSpark(id); }
};`;
win.eval(i18nCode + "\n;\n" + appCode + "\n;\n" + bridge);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => doc.querySelector(s);
const sparkCount = () => doc.querySelectorAll("#spark-list .spark-item").length;
const badgeText = () => { const b = $("#spark-tab-badge"); return b.hidden ? "" : b.textContent; };
const storedSparks = () => JSON.parse(win.localStorage.getItem("strata.spark") || "[]");
const resetSparkState = () => {
  win.localStorage.removeItem("strata.spark");
  win.localStorage.removeItem("strata.spark_memory");
  const b = $("#tab-btn-spark"); if (b) b.click();   // re-render the (now empty) view
};
const addSparkViaUI = (text, tags = "") => {
  const ed = $("#spark-add-input");
  ed.textContent = text;            // editor is a contenteditable div (no .value)
  const tg = $("#spark-add-tags"); if (tg) tg.value = tags;
  $("#spark-add-btn").click();
};

const main = async () => {
  console.log("=== Sparks (灵感便签) M1 regression ===");
  await sleep(40);   // let boot (loadHealth/loadMcp) settle

  // 1. tab renders + empty state
  const tabBtn = $("#tab-btn-spark");
  check("Sparks tab button exists", !!tabBtn);
  tabBtn.click();
  check("Sparks view becomes visible", $("#view-spark").hidden === false);
  check("empty-state shown when no sparks", $("#spark-empty").hidden === false);
  check("badge hidden when empty", $("#spark-tab-badge").hidden === true);

  // 2. save a spark from the tab add box
  const text1 = "Add a dark-mode toggle to the report page";
  $("#spark-add-input").textContent = text1;   // contenteditable div (no .value)
  $("#spark-add-btn").click();
  check("spark appears in list (count=1)", sparkCount() === 1, `count=${sparkCount()}`);
  check("badge shows 1", badgeText() === "1", `badge=${badgeText()}`);
  check("stored text matches", /report page/.test($("#spark-list .spark-item__text").textContent));

  // 3. docked composer strip captures a spark
  $("#spark-toggle").click();
  check("docked strip opens", $("#spark-strip").hidden === false);
  const text2 = "Cache the OKX ticker for 5s";
  $("#spark-strip-input").value = text2;
  $("#spark-strip-save").click();
  check("strip-save added a 2nd spark", sparkCount() === 2, `count=${sparkCount()}`);
  check("badge shows 2", badgeText() === "2", `badge=${badgeText()}`);
  check("strip auto-collapses after save", $("#spark-strip").hidden === true);

  // 4. run a spark while idle → sends a user message (real chat request, then idle).
  //    Newest spark is first (unshift), so the first list item is text2.
  const firstText = doc.querySelector("#spark-list .spark-item__text").textContent;
  const before = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  doc.querySelector("#spark-list .spark-item .spark-exec").click();
  await sleep(140);   // let the mocked stream finish + finalize
  const after = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("running a spark fires a chat request", after.length === before + 1, `delta=${after.length - before}`);
  const sentText = after.length ? after[after.length - 1].body.messages
    .filter((m) => m.role === "user").map((m) => m.content).join("|") : "";
  check("spark text was sent as the user message", sentText.includes(firstText), sentText);
  check("executed spark no longer counted in badge", badgeText() === "1", `badge=${badgeText()}`);
  check("executed spark marked sent (only 1 exec button left)", doc.querySelectorAll("#spark-list .spark-exec").length === 1);

  // 5. delete the pending spark. The executed (sent) spark stays in the list by design
  //    (marked "Sent"), so after deleting the pending one we expect 1 item, badge cleared.
  check("one pending spark remains before delete", doc.querySelectorAll("#spark-list .spark-exec").length === 1);
  const pendingItem = [...doc.querySelectorAll("#spark-list .spark-item")].find((el) => el.querySelector(".spark-exec"));
  pendingItem.querySelector(".spark-del").click();
  check("pending spark deleted (exec button gone)", doc.querySelectorAll("#spark-list .spark-exec").length === 0);
  check("sent spark still listed", sparkCount() === 1, `count=${sparkCount()}`);
  check("badge cleared (sent not counted)", $("#spark-tab-badge").hidden === true);
  // delete the sent one too → list empty
  doc.querySelector("#spark-list .spark-item .spark-del").click();
  check("all sparks removed → empty", sparkCount() === 0, `count=${sparkCount()}`);
  check("badge hidden when empty", $("#spark-tab-badge").hidden === true);

  // ---- M2 / M3 extensions ----------------------------------------------------
  console.log("=== Sparks M2/M3 extensions ===");

  // M2-A: tags + filter
  resetSparkState();
  addSparkViaUI("Add a dark-mode toggle to the report page", "ui");
  addSparkViaUI("Cache the OKX ticker for 5s", "perf");
  addSparkViaUI("Write a changelog entry", "");
  check("3 sparks added (incl. tags)", sparkCount() === 3, `count=${sparkCount()}`);
  check("filter chips = All + 2 tags", doc.querySelectorAll("#spark-filters .spark-filter").length === 3,
        `n=${doc.querySelectorAll("#spark-filters .spark-filter").length}`);
  doc.querySelector('#spark-filters .spark-filter[data-filter="ui"]').click();
  check("filter by 'ui' shows 1", sparkCount() === 1, `count=${sparkCount()}`);
  check("filtered item is the ui-tagged spark", /dark-mode/.test($("#spark-list .spark-item__text").textContent));
  doc.querySelector('#spark-filters .spark-filter[data-filter="all"]').click();
  check("filter 'All' shows 3 again", sparkCount() === 3, `count=${sparkCount()}`);

  // M2-B: run all → every spark becomes 'done', 3 chat requests fired, badge cleared
  const beforeChat = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  $("#spark-runall").click();
  let tries = 0;
  while (tries++ < 120 && storedSparks().filter((s) => s.status === "done").length < 3) await sleep(30);
  check("run-all executed all 3 (status done)", storedSparks().filter((s) => s.status === "done").length === 3,
        `done=${storedSparks().filter((s) => s.status === "done").length}`);
  const afterChat = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  check("run-all fired 3 chat requests", afterChat === beforeChat + 3, `delta=${afterChat - beforeChat}`);
  check("run-all cleared the badge", $("#spark-tab-badge").hidden === true);

  // M2-C: clear done
  $("#spark-cleardone").click();
  check("clear-done removed all done sparks", sparkCount() === 0, `count=${sparkCount()}`);

  // M2-D: bulk select-all + delete selected
  resetSparkState();
  addSparkViaUI("bulk x1"); addSparkViaUI("bulk x2"); addSparkViaUI("bulk x3");
  check("3 sparks for bulk test", sparkCount() === 3);
  const selall = $("#spark-selall");
  selall.checked = true; selall.dispatchEvent(new win.Event("change", { bubbles: true }));
  check("select-all selects all 3", doc.querySelectorAll("#spark-list .spark-sel:checked").length === 3,
        `n=${doc.querySelectorAll("#spark-list .spark-sel:checked").length}`);
  $("#spark-delselected").click();
  check("delete-selected removed all 3", sparkCount() === 0, `count=${sparkCount()}`);

  // M3-A: promote → long-term memory, then restore back to sparks
  resetSparkState();
  addSparkViaUI("keep this idea across sessions");
  addSparkViaUI("another durable idea");
  check("2 sparks before promote", sparkCount() === 2);
  const firstId = doc.querySelector("#spark-list .spark-item").dataset.id;
  doc.querySelector(`#spark-list .spark-item[data-id="${firstId}"] .spark-promote`).click();
  check("promote removes from active list (1 left)", sparkCount() === 1, `count=${sparkCount()}`);
  check("promote adds to memory (1 in memory)", doc.querySelectorAll("#spark-memory-list .spark-memory-item").length === 1,
        `n=${doc.querySelectorAll("#spark-memory-list .spark-memory-item").length}`);
  const memId = doc.querySelector("#spark-memory-list .spark-memory-item").dataset.id;
  doc.querySelector(`#spark-memory-list .spark-memory-item[data-id="${memId}"] .spark-restore`).click();
  check("restore returns spark to active list (2 again)", sparkCount() === 2, `count=${sparkCount()}`);
  check("restore empties memory", doc.querySelectorAll("#spark-memory-list .spark-memory-item").length === 0);

  // M3-B: deleting a memory entry returns the spark to the active list
  const pid = doc.querySelector("#spark-list .spark-item").dataset.id;
  doc.querySelector(`#spark-list .spark-item[data-id="${pid}"] .spark-promote`).click();
  check("promoted again (1 active, 1 memory)", sparkCount() === 1 &&
        doc.querySelectorAll("#spark-memory-list .spark-memory-item").length === 1);
  const mid = doc.querySelector("#spark-memory-list .spark-memory-item").dataset.id;
  doc.querySelector(`#spark-memory-list .spark-memory-item[data-id="${mid}"] .spark-mem-del`).click();
  check("delete-memory returns spark to active list", sparkCount() === 2, `count=${sparkCount()}`);

  // M3-C: drag reorder persists in storage order
  const order0 = storedSparks().map((s) => s.id);
  const items2 = [...doc.querySelectorAll("#spark-list .spark-item")];
  const dragEl = items2.find((el) => el.dataset.id === order0[0]);
  const dropEl = items2.find((el) => el.dataset.id === order0[1]);
  dragEl.dispatchEvent(new win.Event("dragstart", { bubbles: true }));
  dropEl.dispatchEvent(new win.Event("dragover", { bubbles: true }));
  dropEl.dispatchEvent(new win.Event("drop", { bubbles: true }));
  const order1 = storedSparks().map((s) => s.id);
  check("drag reorder swaps first two in storage", order1[0] === order0[1] && order1[1] === order0[0], JSON.stringify(order1));

  // M3-D: rich text is sanitized (scripts/images/handlers stripped), formatting kept,
  // rendered as HTML in the list, and sent to chat as plain text.
  console.log("=== Sparks rich-text (sanitize + render) ===");
  resetSparkState();
  const richInput = $("#spark-add-input");
  richInput.innerHTML = '<b>bold idea</b><script>alert(1)</script><img src=x onerror=alert(1)><i>italic</i>';
  $("#spark-add-btn").click();
  const richStored = storedSparks()[0];
  check("rich: <b> preserved in stored html", /<b>bold idea<\/b>/.test(richStored.html || ""));
  check("rich: <i> preserved in stored html", /<i>italic<\/i>/.test(richStored.html || ""));
  check("rich: <script> stripped", !/<script/i.test(richStored.html || ""));
  check("rich: <img> stripped", !/<img/i.test(richStored.html || ""));
  check("rich: onerror handler stripped", !/onerror/i.test(richStored.html || ""));
  const richItemText = $("#spark-list .spark-item__text");
  check("rich: rendered as HTML (has <b>)", /<b>bold idea<\/b>/.test(richItemText.innerHTML));
  check("rich: plain text recoverable", /bold idea/.test(richItemText.textContent) && /italic/.test(richItemText.textContent));
  const richId = doc.querySelector("#spark-list .spark-item").dataset.id;
  const beforeRichChat = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  doc.querySelector(`#spark-list .spark-item[data-id="${richId}"] .spark-exec`).click();
  await sleep(140);
  const richSent = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("rich: exec fires a chat request", richSent.length === beforeRichChat + 1, `delta=${richSent.length - beforeRichChat}`);
  if (richSent.length) {
    const um = richSent[richSent.length - 1].body.messages.filter((m) => m.role === "user").map((m) => m.content).join("|");
    check("rich: chat gets plain text (no markup/malware)", /bold idea/.test(um) && !/<script/i.test(um) && !/<b>/i.test(um), um);
  }

  // Direction B: real auto-run path — AI busy → spark queues → AI idle → drain fires it.
  console.log("=== Sparks drain (busy→queue→idle) ===");
  resetSparkState();
  addSparkViaUI("idea queued while busy");
  const qid = doc.querySelector("#spark-list .spark-item").dataset.id;
  const baseChat = calls.filter((c) => c.url.endsWith("v1/chat/completions")).length;
  win.__test.setBusy(true);                                  // simulate the AI being mid-task
  doc.querySelector(`#spark-list .spark-item[data-id="${qid}"] .spark-exec`).click();
  await sleep(20);
  const qStatus = storedSparks().find((s) => s.id === qid).status;
  check("busy run → status queued (not sent)", qStatus === "queued", `status=${qStatus}`);
  check("queued: no chat request yet", calls.filter((c) => c.url.endsWith("v1/chat/completions")).length === baseChat,
        `n=${calls.filter((c) => c.url.endsWith("v1/chat/completions")).length}`);
  win.__test.setBusy(false);                                 // AI goes idle
  await win.__test.drain();                                  // the idle hook that setBusy(false) schedules
  await sleep(140);
  const postChat = calls.filter((c) => c.url.endsWith("v1/chat/completions"));
  check("idle drain fires a chat request", postChat.length === baseChat + 1, `delta=${postChat.length - baseChat}`);
  const drainedText = postChat.length ? postChat[postChat.length - 1].body.messages
    .filter((m) => m.role === "user").map((m) => m.content).join("|") : "";
  check("drained spark text was sent", drainedText.includes("idea queued while busy"), drainedText);
  check("queued spark now done", storedSparks().find((s) => s.id === qid).status === "done", `status=${storedSparks().find((s) => s.id === qid).status}`);

  console.log();
  if (FAILURES.length) {
    console.log(`FAILED (${FAILURES.length}):`);
    for (const f of FAILURES) console.log("  - " + f);
    process.exit(1);
  }
  console.log("SPARK TESTS PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
