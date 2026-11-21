/* Gate: a send/confirmEdit that fires the INSTANT you paste (before the async FileReader
 * onload lands the DOM chip + array entry) must NOT read the body as empty and bail.
 *
 * Root cause this locks (2026-11): the paste feature lands the DOM node + attachments entry
 * inside reader.onload (async, fires even for a LOCAL file). pasteImageToRich does not block,
 * so a send that fires before onload saw: ceText -> "" (no chip yet) AND attachments.length==0
 * -> the guard `if ((!text && !attachments.length)) return` bailed. The reported symptom:
 *   - paste an image with NO text typed  -> nothing sends at all (guard trips, both empty);
 *   - paste an image THEN type text      -> sends, but the image is often missing (onload lost).
 * Fix: register a per-paste gate in pendingPastes BEFORE readAsDataURL, resolve it the instant
 * DOM+array land, and have send()/confirmEdit await pendingPastes BEFORE the empty-guard.
 * The upload stays background (after resolve).
 *
 * Static ORDER locks prove the wiring (await line sits before the guard; gate registered
 * before readAsDataURL; resolve after the push; confirmEdit made async). The differential
 * runtime pairs exercise the LIVE functions through the real async FileReader: paste->send
 * with NO text (the exact failing case) must now produce a user message WITH an image block,
 * while the same run on a code copy that strips the await (the pre-fix behaviour) sends nothing.
 *
 * Run standalone: node tests/test_paste_pending_gate.mjs
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
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");

const FAILURES = [];
const check = (label, cond) => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (cond ? "" : "  <-- BROKEN"));
  if (!cond) FAILURES.push(label);
};

const srcText = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const L = srcText.split(/\r?\n/);
const lineOf = (needle) => L.findIndex((l) => l.includes(needle));

// --- static ORDER locks (immune to eval scope; the real wiring) ---------------------------
check("source: pendingPastes set is declared", /let pendingPastes = new Set\(\)/.test(srcText));
check("source: gate is registered BEFORE readAsDataURL", (() => {
  const reg = lineOf("pendingPastes.add(_gate)");
  const read = lineOf("reader.readAsDataURL(f)");
  return reg >= 0 && read >= 0 && reg < read;
})());
check("source: gate is RESOLVED after the array push (DOM+array are real by then)", (() => {
  const push = lineOf("attachments.push(entry)");
  const resolve = lineOf("reader._landResolve()");
  return push >= 0 && resolve >= 0 && resolve > push;
})());
check("source: send awaits pendingPastes BEFORE its empty-guard return", (() => {
  const awaitLine = lineOf("if (pendingPastes.size) await Promise.allSettled(pendingPastes);   // 2026-11: a paste still landing");
  const guard = lineOf("if ((!text && !attachments.length) || busy) return;");
  return awaitLine >= 0 && guard >= 0 && awaitLine < guard;
})());
check("source: confirmEdit made async and awaits pendingPastes before its empty guard", (() => {
  const sig = lineOf("async function confirmEdit()");
  const awaitLine = lineOf("if (pendingPastes.size) await Promise.allSettled(pendingPastes);   // 2026-11: same gate as composer send");
  const guard = lineOf('if (!newText) { toast("warn", t("ctx.edit.empty")); return; }');
  return sig >= 0 && awaitLine >= 0 && guard >= 0 && sig < awaitLine && awaitLine < guard;
})());

// --- differential runtime: LIVE functions through the REAL async FileReader ---------------
async function bootRun(stripAwait) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1/", runScripts: "outside-only" });
  const win = dom.window;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  if (!win.document.getElementById("toasts")) { const d = win.document.createElement("div"); d.id = "toasts"; win.document.body.appendChild(d); }
  let appCode = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
  if (stripAwait) {
    // simulate the PRE-FIX behaviour: drop the await so send() bails on the still-empty body
    appCode = appCode.replace(/if \(pendingPastes\.size\) await Promise\.allSettled\(pendingPastes\);   \/\/ 2026-11: a paste still landing[\s\S]*?\n(\s*)let text = ceText/, "$1let text = ceText");
  }
  appCode += "\n;window.__api = { pasteImageToRich, send, health_set: (v) => { health = v; }, getAtt: () => attachments, getMsgs: () => messages };";
  win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
  win.eval(appCode);
  const api = win.__api;
  api.health_set({ model: "strata", images: true, max_context: 0 });

  const inp = win.document.getElementById("input");
  inp.textContent = "";   // NO text typed -- the exact failing case

  const png = new win.Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: "image/png" });
  const file = new win.File([png], "pasted.png", { type: "image/png" });
  const cd = { files: [file], items: [{ kind: "file", type: "image/png", getAsFile: () => file }] };
  const ev = { clipboardData: cd, preventDefault() {} };

  // paste WITHOUT awaiting -> then fire send() the instant after, before onload lands
  await api.pasteImageToRich(ev, inp);   // the call itself returns before onload (it loops, not awaits onload)
  // the paste's onload is still pending here; send fires now:
  api.send();
  await new Promise((r) => setTimeout(r, 1500));   // let onload + the send await both settle

  const msgs = api.getMsgs();
  const user = msgs.find((m) => m.role === "user");
  const hasImage = user && (user.images || []).length > 0;
  return { sentMsg: !!user, hasImage };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POSITIVE: fixed code -> paste (no text) + instant send STILL lands the image
const fixed = await bootRun(false);
check("DIFFERENTIAL POSITIVE: paste-no-text + instant send sends a message (the guard no longer trips)", fixed.sentMsg);
check("DIFFERENTIAL POSITIVE: the sent message carries the pasted image", fixed.hasImage);

// NEGATIVE: strip the await (= pre-fix) -> the same action sends nothing (guard trips, both empty)
const prefix = await bootRun(true);
check("DIFFERENTIAL NEGATIVE: without the await, paste-no-text + instant send sends NOTHING (proves the await is load-bearing)", !prefix.sentMsg);

// keep the negative run from exiting before its promise settles
await sleep(50);

console.log("\nPASTE-PENDING-GATE: " + (FAILURES.length ? "RED — " + FAILURES.join("; ") : "ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
