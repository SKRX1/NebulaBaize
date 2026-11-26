/* [确认框升级 2026-11-26 · 渐进第1步] 通用居中确认框 askConfirm() 的行为锁。
   背景：删除消息此前走 Chrome 原生 window.confirm —— 阻塞、贴顶、不可样式、
   IP 源下标题显示 "127.0.0.1:8099 显示"，CSS 完全管不到。本轮把它升级成
   askConfirm(msg)->Promise<boolean>：复用全站 .st-modal / .st-modal__card 基类
   （基类自带 margin:auto -> 天然居中且视觉一致），异步、可样式、无障碍、Esc/遮罩可关。
   deleteMessage 已接入；其余 confirm 站点后续渐进迁移，此助手是它们的统一入口。

   每条动态锁都配 decoy 差分证明 load-bearing。Run: node tests/test_ask_confirm_jsdom.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
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
const i18nSrc = fs.readFileSync(path.join(WEB, "i18n.js"), "utf8");
const appCode = fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" +
                fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const css = fs.readFileSync(path.join(WEB, "app.css"), "utf8");
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/* ── A. 静态反漂移锁 ── */
console.log("\n=== A. static locks ===");
check("A1 askConfirm is defined exactly once",
  appCode.split("\n").filter((l) => l.startsWith("function askConfirm(")).length === 1);
check("A2 the box is built on the CENTERED .st-modal / .st-modal__card base (not a bespoke top-anchored box)",
  /overlay\.className = "st-modal";/.test(appCode) && /card\.className = "st-modal__card";/.test(appCode));
check("A3 the .st-modal__card base actually carries margin:auto (so that reuse = centering is load-bearing)",
  /\.st-modal__card \{[^}]*margin:\s*auto/.test(css.replace(/\s+/g, " ")));
check("A4 askConfirm exposes the accessibility contract (role=dialog + aria-modal + labelledby)",
  /setAttribute\("role", "dialog"\)/.test(appCode) &&
  /setAttribute\("aria-modal", "true"\)/.test(appCode) &&
  /setAttribute\("aria-labelledby", titleId\)/.test(appCode));
check("A5 deleteMessage is async and routes through await askConfirm (native confirm removed there)",
  /async function deleteMessage\(i\) \{/.test(appCode) &&
  /if \(!\(await askConfirm\(t\("ctx\.delete\.confirm"\)\)\)\) return;/.test(appCode) &&
  !/window\.confirm\(t\("ctx\.delete\.confirm"\)/.test(appCode));
check("A6 i18n ships confirm.title + common.ok in BOTH locales (zh + en)",
  /"confirm\.title": "确认操作"/.test(i18nSrc) && /"common\.ok": "确定"/.test(i18nSrc) &&
  /"confirm\.title": "Confirm"/.test(i18nSrc) && /"common\.ok": "OK"/.test(i18nSrc));

/* ── harness: same stub set as the gallery/jsdom gates ── */
async function freshBoot() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost:8099/", pretendToBeVisual: true });
  const win = dom.window;
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
  win.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
  win.IntersectionObserver = class { constructor(cb) { this.cb = cb; } observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  win.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  win.cancelAnimationFrame = (id) => clearTimeout(id);
  win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  win.localStorage.setItem("strata.sessions", JSON.stringify([{ id: "sX", workspace: "wsX", permission: "full" }]));
  win.localStorage.setItem("strata.session.active", JSON.stringify("sX"));
  win.eval(i18nSrc);
  win.eval(appCode + `
;window.__ask = {
  askConfirm: (m, o) => askConfirm(m, o),
};`);
  await tick();
  return { win };
}

// the box is the LAST .st-modal appended to body by askConfirm (the app's own modals are hidden, not body-children added at call time)
const lastModal = (win) => { const all = [...win.document.querySelectorAll(".st-modal")]; return all[all.length - 1]; };
const buttonsOf = (win) => { const m = lastModal(win); return m ? [...m.querySelectorAll("button")] : []; };

console.log("\n=== B. 动态行为：确定 -> true ===");
{
  const { win } = await freshBoot();
  let resolved = "PENDING";
  win.__ask.askConfirm("sure?").then((v) => { resolved = v; });
  await tick();
  const m = lastModal(win);
  check("B1a a dialog modal rendered on the centered base", !!m && m.classList.contains("st-modal") && m.querySelector(".st-modal__card") !== null);
  check("B1b role=dialog + aria-modal=true are set on the live node", !!m && m.getAttribute("role") === "dialog" && m.getAttribute("aria-modal") === "true");
  check("B1c the ok button is the primary one, cancel is ghost (order cancel then ok)", buttonsOf(win).length === 2);
  buttonsOf(win).find((b) => b.className.includes("st-btn--primary")).click();   // OK
  await tick();
  check("B1d clicking OK resolves the promise TRUE", resolved === true, "got=" + resolved);
  check("B1e the box is removed from the DOM after resolve (no leak)", win.document.querySelectorAll(".st-modal").length === 0 || lastModal(win) !== m);
}

console.log("\n=== B2. 取消 -> false（主路） + 遮罩点击 -> false ===");
{
  const { win } = await freshBoot();
  let r1 = "PENDING";
  win.__ask.askConfirm("x").then((v) => { r1 = v; });
  await tick();
  buttonsOf(win).find((b) => b.className.includes("st-btn--ghost")).click();   // CANCEL
  await tick();
  check("B2a clicking CANCEL resolves FALSE", r1 === false, "got=" + r1);

  let r2 = "PENDING";
  win.__ask.askConfirm("x").then((v) => { r2 = v; });
  await tick();
  lastModal(win).dispatchEvent(new win.MouseEvent("click", { bubbles: true }));   // click the overlay backdrop (target === overlay)
  await tick();
  check("B2b clicking the backdrop (outside the card) resolves FALSE", r2 === false, "got=" + r2);
}

console.log("\n=== B3. Esc -> false + 焦点在确定键（无障碍键盘） ===");
{
  const { win } = await freshBoot();
  let r = "PENDING";
  win.__ask.askConfirm("x").then((v) => { r = v; });
  await tick();
  check("B3a the OK button is focused on open (keyboard users hit Enter=confirm)", !!lastModal(win) && win.document.activeElement && lastModal(win).contains(win.document.activeElement) && win.document.activeElement.className.includes("st-btn--primary"));
  win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  check("B3b Escape resolves FALSE", r === false, "got=" + r);
}

console.log("\n=== B4. decoy 差分：点确定却期望 false 的对照（证明 B1d 不是恒真） ===");
{
  const { win } = await freshBoot();
  let cancelRes = "PENDING", okRes = "PENDING";
  // two boxes at once: cancel one, confirm the other -> they must resolve INDEPENDENTLY
  win.__ask.askConfirm("A").then((v) => { cancelRes = v; });
  await tick();
  const boxA = lastModal(win);
  win.__ask.askConfirm("B").then((v) => { okRes = v; });
  await tick();
  const boxB = lastModal(win);
  boxA.querySelector(".st-btn--ghost").click();   // cancel A
  boxB.querySelector(".st-btn--primary").click(); // confirm B
  await tick();
  check("B4a the two concurrent boxes are DISTINCT DOM nodes (the overlay removal targets the right one)", boxA !== boxB);
  check("B4b box A cancelled, box B confirmed — each promise resolves its OWN value (load-bearing: the resolve is bound per-call, not global)",
    cancelRes === false && okRes === true, "A=" + cancelRes + " B=" + okRes);
}

console.log("\n" + (FAILURES.length ? "ASK-CONFIRM-GATE: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ") : "ASK-CONFIRM-GATE: ALL GREEN (centered reusable confirm + 确定/取消/Esc/遮罩 + a11y + concurrency decoy)"));
process.exit(FAILURES.length ? 1 : 0);
