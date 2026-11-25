/* Static + jsdom lock (2026-10-30): the top-bar tabs and their view panels (count grows as
 * tabs are added -- do NOT hard-code 8; this test is count-agnostic) must stay SAME-LEVEL
 * siblings, with the aria pairing intact, so a future tab addition cannot ship un-paired.
 * A static tag-stack parse can be fooled when the HTML parser un-nests a button inside a
 * button -- jsdom's REAL parse is what settles the level question, so the lock boots
 * index.html and walks parentElement chains.
 * ADDING A TOP TAB = THREE PLACES THAT MUST MOVE TOGETHER (2026-11 rule, schedule tab taught
 * this the hard way): (1) index.html tab button data-tab, (2) index.html view panel id + the
 * aria-controls/aria-labelledby pair, (3) app.js showTab whitelist. Miss the whitelist and the
 * tab silently bounces back to chat -- L4 below locks all three sets agreeing. NOTE: showTab
 * ALSO has a visibility for-of array (the 4th load-bearing place, NOT directly locked by L4);
 * if a tab is whitelisted but missing there its view stays hidden on the default-hidden markup.
 * Contract:
 *   L1  every .st-tab button is a DIRECT child of nav[role=tablist] (count >= 8, all paired)
 *   L2  every view panel is a DIRECT child of <main>
 *   L3  aria-controls <-> aria-labelledby bijection, every target exists
 *   L4  app.js showTab whitelist == panel ids (== button data-tab values): the three sets
 *       must agree, or a whitelist entry renders nothing and a tab silently dies
 * Run standalone: node tests/test_nav_tabs_level.mjs
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

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const appSrc = fs.readFileSync(path.join(WEB, "app.js"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/" });
const doc = dom.window.document;

const nav = doc.querySelector("nav[role=tablist]");
const main = doc.querySelector("main");
check("nav[role=tablist] and <main> exist", !!nav && !!main);
if (!nav || !main) { console.log("ABORT"); process.exit(1); }

const tabs = [...nav.children].filter((n) => n.matches("button.st-tab"));
const allBtns = [...doc.querySelectorAll("button.st-tab")];
const panels = [...main.children].filter((n) => n.matches('[role=tabpanel]'));
const allPanels = [...doc.querySelectorAll('[role=tabpanel]')];

check("L1 every .st-tab button is a DIRECT child of the tablist", allBtns.length === tabs.length,
      "direct=" + tabs.length + " total=" + allBtns.length);
check("L2 every tabpanel is a DIRECT child of <main>", allPanels.length === panels.length,
      "direct=" + panels.length + " total=" + allPanels.length);

// L3 aria pairing bijection
const ctrl = tabs.map((b) => b.getAttribute("aria-controls"));
check("L3 every tab button carries aria-controls", ctrl.every(Boolean), ctrl.join(","));
const byId = (id) => doc.getElementById(id);
check("L3 every aria-controls target exists", ctrl.map(byId).every(Boolean), ctrl.join(","));
const back = panels.map((p) => p.getAttribute("aria-labelledby"));
check("L3 every panel carries aria-labelledby", back.every(Boolean), back.join(","));
check("L3 every aria-labelledby target exists", back.map(byId).every(Boolean), back.join(","));
const pair = new Set(tabs.map((b) => b.getAttribute("aria-controls") + "|" + byId(b.getAttribute("aria-controls"))?.getAttribute("aria-labelledby")));
check("L3 controls<->labelledBy bijection (no half pairs)", tabs.length === panels.length &&
      ctrl.map((id) => byId(id).getAttribute("aria-labelledby")).sort().join(",") ===
      [...tabs].map((b) => b.id).sort().join(","),
      "tabs=" + tabs.length + " panels=" + panels.length);

// L4 the three name sets must agree: html buttons, html panels, app.js whitelist
const btnTabs = tabs.map((b) => b.dataset.tab).filter(Boolean).sort();
const panelIds = panels.map((p) => p.id.replace(/^view-/, "")).sort();
const m = appSrc.match(/function showTab\(name\)[^{]*{[\s\S]{0,200}?tab = \[([^\]]+)\]\.includes\(name\)/);
check("L4 app.js showTab whitelist found", !!m, m ? m[1].slice(0, 60) : "");
const wl = m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).sort() : [];
check("L4 button data-tab set == whitelist", JSON.stringify(btnTabs) === JSON.stringify(wl), btnTabs.join(",") + " VS " + wl.join(","));
check("L4 panel id set == whitelist", JSON.stringify(panelIds) === JSON.stringify(wl), panelIds.join(",") + " VS " + wl.join(","));

console.log("\n" + (FAILURES.length ? "NAV-TABS-LEVEL: " + FAILURES.length + " FAILED -> " + FAILURES.join(" | ")
                                    : "NAV-TABS-LEVEL: ALL GREEN"));
process.exit(FAILURES.length ? 1 : 0);
