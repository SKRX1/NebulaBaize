/* Regression test for auto-resume after automatic compaction (approved design 2026-10).
 *
 * app.js is strict-mode, so its top-level lets aren't on window; like test_stream_intel we
 * append an export block to the evaluated source to reach the internal symbols. Messages are
 * injected via the shared scope.
 *
 * The auto-compact gate needs messages.length > 6 and a hot window rule (maxCtx 1000,
 * lastPromptTokens 900 >= 85%).
 *
 * Scenario A (plan signal): the last assistant turn has unfinished plan items. The trigger
 * arms the snapshot, the compact turn ends, the hook fires exactly one resume request whose
 * last prompt is the i18n resume command (en); the resume turn's assistant message carries
 * the badge (meta "Auto-resume" + hidden autoResume flag) so the UI can tell it apart from
 * human input. Then the chain STOPS (cooldown).
 * Scenario B (manual): same seed, manual path (confirm=true): also resumes now (approved).
 * Scenario C (dangling prompt): no plan signals, but the LAST message is an unanswered user
 * prompt (Stop mid-flight); the default snapshot arms it (scan silent) -> resume fires.
 * Scenario D (clean finish): the scan is silent AND nothing is dangling -> RESUME ANYWAY.
 * Inverted 2026-10 (user-approved): compaction IS truncation, so every compact (auto or
 * manual) arms a resume; the 3s undo window and Stop are the user's regret gates. The
 * earlier 2026-10-19 "scan decides, clean finish stays silent" rule is superseded: a
 * missed resume stalls a live task, a spurious one costs only a polite closing turn.
 *
 * Run: node tests/test_auto_resume.mjs
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
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const RESUME_EN = "Continue the task that was interrupted by the auto-compaction";
const BADGE_EN = "Auto-resume";
const PANEL_EN = "auto-resumed this turn";      // pure-ASCII assertion word (zh display excluded)
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));   // undo window is 3s: scenarios wait >3.2s past the compact turn

const EXPORT = `
;window.__api = {
  maybeAutoCompact, compactConversation, taskResumeSnapshot, lastTurnUnanswered,
  fire: (mp) => { maxCtx = 1000; lastPromptTokens = mp; autoCompactCooldown = 0; },
  getResume: () => resumeSnapshot, getBadge: () => resumeBadge,
  setMessages: (m) => { messages = m; }, getMessages: () => messages,
};
`;

function boot() {
  const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
  const win = dom.window;
  win.TextDecoder = TextDecoder;
  win.TextEncoder = TextEncoder;
  win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, media: "", onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
  if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.localStorage.setItem("strata.lang", "en");
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
    if (u.endsWith("health")) return { ok: true, status: 200, json: async () => ({ model: "test-model" }) };
    if (u.endsWith("mcp")) return { ok: true, status: 200, json: async () => ({ servers: [], tools: 0 }) };
    if (u.endsWith("v1/chat/completions")) {
      return streamResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Compact summary text here." } }] })}\n`,
        "data: [DONE]\n",
      ]);
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  win.confirm = () => true;
  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) + EXPORT);
  return { win, calls };
}

// 8 messages so the auto-compact gate (messages.length > 6) can fire.
const fillers = () => {
  const msgs = [];
  for (let i = 1; i <= 7; i++) msgs.push({ role: i % 2 ? "user" : "assistant", text: `Filler ${i}`, time: i });
  return msgs;
};
const seedPlan = () => [...fillers().slice(0, 7),
  { role: "assistant", text: "Working on it.", time: 8,
    plan: [{ label: "step one", done: true }, { label: "step two", done: false }] }];
const seedDangling = () => [...fillers(),
  { role: "user", text: "Do the remaining steps", time: 8 }];      // never answered
const seedClean = () => [...fillers(),
  { role: "assistant", text: "All done, nothing pending.", time: 8 }];

const chatReqs = (calls) => calls.filter((c) => c.url.endsWith("v1/chat/completions"));
const lastPrompt = (body) => { const ns = body.messages.filter((m) => m.role !== "system"); return ns.length ? ns[ns.length - 1].content : ""; };
const lastAssistant = (msgs) => [...msgs].reverse().find((m) => m.role === "assistant");
const noteText = (win) => (win.document.querySelector("#ins-ctx-note") || {}).textContent || "";

const main = async () => {
  console.log("=== auto-resume after automatic compaction ===");

  // --- Scenario A: plan signal arms the snapshot, resume fires, resume turn is badged ---
  {
    const { win, calls } = boot();
    await sleep(50);
    const api = win.window.__api;
    api.setMessages(seedPlan());
    check("A: snapshot sees the unfinished plan",
      api.taskResumeSnapshot() && api.taskResumeSnapshot().leftItems === 1,
      JSON.stringify(api.taskResumeSnapshot()));
    api.fire(900);
    api.maybeAutoCompact();
    check("A: trigger armed the snapshot", api.getResume() !== null, String(api.getResume()));
    await sleep(3700);
    const chat = chatReqs(calls);
    check("A: two chat requests (compact, resume); chain stopped by cooldown",
      chat.length === 2, `got ${chat.length}`);
    if (chat.length >= 2) {
      check("A: request 1 is the compact request (not a resume)", !lastPrompt(chat[0].body).startsWith(RESUME_EN));
      check("A: request 2's last prompt is the resume command",
        lastPrompt(chat[1].body).startsWith(RESUME_EN), JSON.stringify(lastPrompt(chat[1].body).slice(0, 50)));
      const la = lastAssistant(api.getMessages());
      check("A: the resume turn carries the badge label", la && la.meta === BADGE_EN, la ? JSON.stringify(la.meta) : "none");
      check("A: the resume turn carries the hidden autoResume flag", la && la.autoResume === true);
      check("A: panel note shows the auto-resumed segment", noteText(win).includes(PANEL_EN), JSON.stringify(noteText(win).slice(0, 60)));
    }
    check("A: snapshot consumed (one-shot)", api.getResume() === null, String(api.getResume()));
    check("A: badge consumed (one-shot)", api.getBadge() === null, String(api.getBadge()));
    win.close();
  }
  await sleep(100);

  // --- Scenario B: manual path resumes too (approved 2026-10) ---
  {
    const { win, calls } = boot();
    await sleep(50);
    const api = win.window.__api;
    api.setMessages(seedPlan());
    api.fire(900);
    api.compactConversation(false);                    // manual: confirm mocked true
    await sleep(3700);
    const chat = chatReqs(calls);
    check("B: two chat requests (compact, resume)", chat.length === 2, `got ${chat.length}`);
    check("B: request 2's last prompt is the resume command", chat[1] && lastPrompt(chat[1].body).startsWith(RESUME_EN), chat[1] ? JSON.stringify(lastPrompt(chat[1].body).slice(0, 50)) : "none");
    check("B: the resume turn is badged", (() => { const la = lastAssistant(api.getMessages()); return la && la.meta === BADGE_EN && la.autoResume === true; })());
    check("B: panel note shows the auto-resumed segment", noteText(win).includes(PANEL_EN), JSON.stringify(noteText(win).slice(0, 60)));
    win.close();
  }
  await sleep(100);

  // --- Scenario C: dangling unanswered prompt arms the snapshot via lastTurnUnanswered ---
  {
    const { win, calls } = boot();
    await sleep(50);
    const api = win.window.__api;
    api.setMessages(seedDangling());
    check("C: plan scan is silent (no plan/limit signals)", api.taskResumeSnapshot() === null, String(api.taskResumeSnapshot()));
    check("C: the dangling-prompt check fires", api.lastTurnUnanswered() === true);
    api.fire(900);
    api.maybeAutoCompact();
    check("C: trigger armed the snapshot (default; scan silent)", api.getResume() !== null, String(api.getResume()));
    await sleep(3700);
    const chat = chatReqs(calls);
    check("C: two chat requests (compact, resume)", chat.length === 2, `got ${chat.length}`);
    if (chat.length >= 2) {
      check("C: request 2's last prompt is the resume command",
        lastPrompt(chat[1].body).startsWith(RESUME_EN), JSON.stringify(lastPrompt(chat[1].body).slice(0, 50)));
      const la = lastAssistant(api.getMessages());
      check("C: the resume turn is badged", la && la.meta === BADGE_EN && la.autoResume === true);
      check("C: panel note shows the auto-resumed segment", noteText(win).includes(PANEL_EN), JSON.stringify(noteText(win).slice(0, 60)));
    }
    win.close();
  }
  await sleep(100);

  // --- Scenario D: clean finish but compaction still resumes (approved 2026-10) ---
  {
    const { win, calls } = boot();
    await sleep(50);
    const api = win.window.__api;
    api.setMessages(seedClean());
    check("D: the scan is silent on a clean finish", api.taskResumeSnapshot() === null, String(api.taskResumeSnapshot()));
    check("D: nothing dangling", api.lastTurnUnanswered() === false);
    api.fire(900);
    api.maybeAutoCompact();
    check("D: compaction arms the resume anyway (fallback snapshot)", api.getResume() !== null, String(api.getResume()));
    await sleep(3700);
    const chat = chatReqs(calls);
    check("D: two chat requests (compact, resume)", chat.length === 2, `got ${chat.length}`);
    if (chat.length >= 2) {
      check("D: request 2's last prompt is the resume command",
        lastPrompt(chat[1].body).startsWith(RESUME_EN), JSON.stringify(lastPrompt(chat[1].body).slice(0, 50)));
      const laD = lastAssistant(api.getMessages());
      check("D: the resume turn is badged", laD && laD.meta === BADGE_EN, laD ? JSON.stringify(laD.meta) : "none");
      check("D: panel note shows the auto-resumed segment", noteText(win).includes(PANEL_EN), JSON.stringify(noteText(win).slice(0, 60)));
    }
    win.close();
  }
  // --- Scenario E: undo inside the 3s window cancels the deferred resume ---
  {
    const { win, calls } = boot();
    await sleep(50);
    const api = win.window.__api;
    api.setMessages(seedPlan());
    api.fire(900);
    api.maybeAutoCompact();
    await sleep(2500);                                  // compact turn done, undo window still open
    const chat1 = chatReqs(calls);
    check("E: only the compact request while the window is open", chat1.length === 1, `got ${chat1.length}`);
    check("E: the panel row shows the undo button", noteText(win).includes(PANEL_EN) &&
      !!win.document.querySelector('#ins-ctx-note [data-action="resume-undo"]'),
      JSON.stringify(noteText(win).slice(0, 70)));
    const btn = win.document.querySelector('#ins-ctx-note [data-action="resume-undo"]');
    btn.click();
    await sleep(3700);                                  // longer than the window: a live timer would have sent by now
    const chat2 = chatReqs(calls);
    check("E: still only the compact request after the cancel", chat2.length === 1, `got ${chat2.length}`);
    check("E: no resume command anywhere", !chat2.some((c) => JSON.stringify(c.body).includes(RESUME_EN)));
    const la = lastAssistant(api.getMessages());
    check("E: no badge (the cancelled send never started a stream)", !la || !la.autoResume);
    check("E: panel row fell back (undo button gone)",
      !win.document.querySelector('#ins-ctx-note [data-action="resume-undo"]') &&
      !noteText(win).includes(PANEL_EN), JSON.stringify(noteText(win).slice(0, 70)));
    win.close();
  }

  console.log();
  if (FAILURES.length) { console.log(`FAILED (${FAILURES.length}):`); for (const f of FAILURES) console.log("  - " + f); process.exit(1); }
  console.log("AUTO-RESUME: ALL PASSED");
  process.exit(0);
};

main().catch((e) => { console.error(e); process.exit(1); });
