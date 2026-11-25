/* Contract gate: the sidebar context menu (right-click + "..." buttons) must NOT auto-close
 * while the user is trying to use it during a streaming answer.
 *
 * Root cause this locks (user report): popMenu dismissed itself on ANY scroll because it had
 *   document.addEventListener("scroll", () => hide(), true)   // capture, fires for every scrollable
 * During a model answer the chat container (#chat-scroll) auto-scrolls, so the just-opened
 * left-sidebar menu was closed instantly. The fix scopes the scroll-dismiss to the menu's own
 * anchor container (#session-list) - the only scroll that would strand a fixed-position menu.
 *
 * This gate boots the real app.js and drives popMenu through REAL DOM events:
 *   - right-clicking a workspace header opens it;
 *   - scrolling the CHAT must leave it open (the fix);
 *   - scrolling the SIDEBAR LIST itself closes it (still desirable);
 *   - clicking outside / Escape still close it (the existing paths stay intact).
 *
 * Run standalone: node tests/test_sidebar_menu_scroll.mjs
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

// ---- boot the real app.js in jsdom (mirrors the group-card gate's harness) -------------------
const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
                      { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){return false;} });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (!doc.getElementById("toasts")) { const d = doc.createElement("div"); d.id = "toasts"; doc.body.appendChild(d); }
win.confirm = () => true;
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok:true, status:200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8"));

// The popMenu element has NO id (the message menu is #ctx-menu-msg, a different owner). Querying
// `.st-ctx-menu` but excluding #ctx-menu-msg uniquely resolves the sidebar popMenu's element.
const popEl = () => doc.querySelector('.st-ctx-menu:not(#ctx-menu-msg)');
const isOpen = () => { const e = popEl(); return !!e && e.hidden === false; };

// Provide a real anchor inside #session-list (a workspace header) + a chat scroll container.
const list = doc.getElementById("session-list");
check("#session-list exists (popMenu anchors here)", !!list);
const chat = doc.getElementById("chat-scroll");
check("#chat-scroll exists (the streaming answer scrolls here)", !!chat);

const head = doc.createElement("div");
head.setAttribute("data-ws-head", "/tmp/menu-probe");
list.appendChild(head);

// open via right-click on the workspace header -> popMenu.open(wsMenuItems(...)) at line 1942.
head.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles:true, clientX: 40, clientY: 60 }));
check("right-clicking a workspace header OPENS the sidebar menu", isOpen() === true);

// THE FIX: scrolling the CHAT container must NOT close it. The old capture listener fired on this.
if (chat) {
  chat.dispatchEvent(new win.Event("scroll", { bubbles:true }));
  check("streaming CHAT scroll does NOT close the sidebar menu (the reported bug)", isOpen() === true);
} else {
  // even without #chat-scroll, a generic document scroll (e.g. documentElement) must not close it
  doc.documentElement.dispatchEvent(new win.Event("scroll", { bubbles:true }));
  check("a non-sidebar scroll does NOT close the sidebar menu", isOpen() === true);
}

// Still-desirable: scrolling the menu's OWN anchor list dismisses the now-stranded menu.
list.dispatchEvent(new win.Event("scroll", { bubbles:true }));
check("scrolling the SIDEBAR LIST itself still closes the menu", isOpen() === false);

// The other close paths must remain intact: re-open, then Escape.
head.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles:true, clientX: 40, clientY: 60 }));
check("menu re-opens for the Escape check", isOpen() === true);
doc.dispatchEvent(new win.KeyboardEvent("keydown", { key:"Escape", bubbles:true }));
check("Escape still closes the menu", isOpen() === false);

// Re-open, then a click OUTSIDE the menu still closes it (existing outside-close path).
head.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles:true, clientX: 40, clientY: 60 }));
check("menu re-opens for the outside-click check", isOpen() === true);
doc.body.dispatchEvent(new win.MouseEvent("click", { bubbles:true }));
check("a click outside the menu still closes it", isOpen() === false);

// ---------------- 9) the opened menu shows 工作区 in Chinese (the term-unification acceptance) ----
// Drives the REAL right-click render path (wsMenuItems -> t("side.renamews")) and asserts the menu
// text uses the unified term. Guards against the "重命名空间" wording ever regressing.
win.i18n.setLang("zh");
check("we are in Chinese for the menu-text check", win.i18n.lang === "zh", "lang=" + win.i18n.lang);
// setLang re-rendered the sidebar; add a fresh workspace header to act as the right-click anchor.
const head9 = doc.createElement("div");
head9.setAttribute("data-ws-head", "/tmp/menu-probe-zh");
doc.getElementById("session-list").appendChild(head9);
head9.dispatchEvent(new win.MouseEvent("contextmenu", { bubbles:true, clientX: 40, clientY: 60 }));
check("right-click opens the menu in Chinese", isOpen() === true);
const menuText = popEl().textContent;
check("the menu shows 重命名工作区 (unified term)  " + JSON.stringify(menuText),
      menuText.includes("重命名工作区"));
check("the menu shows NO stale 重命名空间", !menuText.includes("重命名空间"));

console.log("");
if (FAILURES.length) { console.log("SIDEBAR MENU SCROLL: FAIL (" + FAILURES.length + ")"); process.exit(1); }
console.log("SIDEBAR MENU SCROLL: ALL GREEN");
process.exit(0);
