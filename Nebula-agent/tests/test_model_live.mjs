/* LIVE browser test for the model-status light (real server on 8099, real renderer, real timers).
 *
 * The complaint this exists to prevent: the dot only corrected itself after CLICKING the chip.
 * A status light you must poke is not a status light. So:
 *
 *   T1  page load -> chip reads the live engine (green "on", name = the model the engine holds)
 *   T2  the engine state changes under an IDLE page -> the dot changes by itself, no click,
 *       dropdown never opened
 *   T3  the poll really is running at the 4s cadence (counted requests, not a timer object)
 *
 * /models/config is intercepted only to DRIVE the engine state (route.fetch() passes the real
 * payload through), so the server, the probe and the renderer are all the real ones.
 *
 * Run: node tests/test_model_live.mjs      (needs the gateway on 127.0.0.1:8099)
 */
import { createRequire } from "module";

// Resolve Playwright LOCALLY first (Node walks up from this file into the repo-root
// node_modules, the same one the jsdom recovery channel uses) so a plain `npm i playwright`
// is enough on any machine. Only if that misses do we fall back to the legacy managed
// workspace; a real miss prints the exact fix command. The chromium.launch() below is left
// as-is (these smoke tests target a running gateway and their own browser).
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)("playwright"));
} catch (e) {
  try {
    ({ chromium } = createRequire("E:/Nebula/NebulaBaize/")("playwright"));
  } catch (e2) {
    console.error(
      "playwright is not installed here. From the repo root run:\n" +
      "    npm i playwright\n" +
      "(a pure-JS package, a few MB; it does NOT pull a browser). Then run this test again.");
    process.exit(2);
  }
}

const BASE = process.env.BASE || "http://127.0.0.1:8099";
const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

let phase = "real";                 // "real" | "down" | "sibling" | "unknown"
let polls = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const jsErrors = [];
page.on("pageerror", (e) => jsErrors.push(String(e)));
page.on("request", (r) => { if (r.url().includes("models/config") && r.method() === "GET") polls++; });

// --- dynamic detection: what is the selected model and its kind? ---
let selectedId = "";
let selectedKind = "";   // "local" or "custom"
let selectedName = "";   // display name fragment for assertions

// The fake world must be consistent across BOTH verbs: the client replaces its whole doc with
// whatever a write returns, so a POST that still reported the real engine would contradict the
// GET we are simulating (right after auto-align: selected=s while the probe still says xxs).
const applyPhase = (doc) => {
  // Dynamic detection from the first real response (do not mutate during detection)
  if (!selectedId && phase === "real") {
    selectedId = doc.selected || "";
    const entry = (doc.models || []).find(m => m.id === selectedId);
    selectedKind = entry ? (entry.kind || "local") : "local";
    selectedName = entry ? (entry.name || entry.model || entry.id || "") : "";
    return doc;  // pass through untouched on first detection pass
  }

  if (phase === "down") {
    if (selectedKind === "custom") {
      // For custom: probe[selectedId].ok drives the dot, not __engine__
      if (doc.probe && doc.probe[selectedId]) doc.probe[selectedId] = { ...doc.probe[selectedId], ok: false };
      doc.probe = Object.fromEntries(Object.keys(doc.probe || {}).map((k) => [k, { ...doc.probe[k], ok: false, loaded: null }]));
    } else {
      doc.probe = Object.fromEntries(Object.keys(doc.probe || {}).map((k) => [k, { ...doc.probe[k], ok: false, loaded: null }]));
    }
  } else if (phase === "unknown") {           // port answers, but holds weights no entry names
    if (doc.probe && doc.probe.__engine__) doc.probe.__engine__ = { ...doc.probe.__engine__, ok: true, loaded: "some-unlisted-weights" };
    if (selectedKind === "custom") {
      if (doc.probe && doc.probe[selectedId]) doc.probe[selectedId] = { ...doc.probe[selectedId], ok: true };
    }
  } else if (phase === "sibling") {           // same port answers, but it holds the OTHER weights
    const other = (doc.models || []).map((m) => m.model).filter(Boolean).find((n) => !/iq3_xxs/.test(n)) || "swift-1.5-iq3_s";
    if (doc.probe && doc.probe.__engine__) doc.probe.__engine__ = { ...doc.probe.__engine__, ok: true, loaded: other };
    if (selectedKind === "custom") {
      if (doc.probe && doc.probe[selectedId]) doc.probe[selectedId] = { ...doc.probe[selectedId], ok: true };
    }
  }
  return doc;
};

await page.route("**/models/config", async (route) => {
  const resp = await route.fetch();
  const doc = applyPhase(await resp.json());
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(doc) });
});

const chip = () => page.evaluate(() => {
  const b = document.getElementById("model-btn");
  return b ? { hidden: b.hidden, dot: b.dataset.dot || "", name: document.getElementById("model-name").textContent,
               popHidden: document.getElementById("model-pop").hidden } : null;
});
const waitDot = async (want, ms = 9000) => {
  try {
    await page.waitForFunction((w) => {
      const b = document.getElementById("model-btn");
      return b && !b.hidden && b.dataset.dot === w;
    }, want, { timeout: ms });
    return true;
  } catch (e) { return false; }
};

console.log("=== T1: a fresh page tells the truth about the engine ===");
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await waitDot("on", 6000);
const c1 = await chip();
console.log("  chip:", JSON.stringify(c1));
console.log("  detected: selected=" + selectedId + " kind=" + selectedKind + " name=" + selectedName);
check("chip is visible", c1 && !c1.hidden);
check("dot is green (on)", c1 && c1.dot === "on", c1 && c1.dot);
// Dynamic: accept any model name that matches the detected selected model
const nameMatch = selectedKind === "custom"
  ? (selectedName ? c1.name.includes(selectedName) : true)
  : /iq3_xxs/.test(c1 ? c1.name : "");
check("name matches the selected model", nameMatch, c1 && c1.name);
const build = await page.evaluate(() => window.__strataBuild || "(unset)");
console.log("  build:", build);
check("new build is loaded (hard-refresh marker)", build !== "(unset)", build);

console.log("\n=== T2: engine state changes on an IDLE page — no click, no dropdown ===");
phase = "down";
check("dot goes out by itself", await waitDot("off", 9000), await chip().then((c) => JSON.stringify(c)));
const c2 = await chip();
check("dropdown was never opened", c2 && c2.popHidden === true);

phase = "unknown";
// The port is alive again but the engine names weights nobody configured: amber (up, unusable).
// For custom kind: the endpoint is back online → dot should go green (on), not amber
const expectedDot = selectedKind === "custom" ? "on" : "mismatch";
const dotAfterUnknown = await waitDot(expectedDot, 9000);
const c3 = await chip();
console.log("  chip:", JSON.stringify(c3));
check("dot turns " + expectedDot + " after endpoint recovers", dotAfterUnknown, c3 && c3.dot);
// For custom, name should stay the same (not auto-align)
const nameCheckT2 = selectedKind === "custom"
  ? (selectedName ? c3.name.includes(selectedName) : true)
  : /iq3_xxs/.test(c3 ? c3.name : "");
check("selection name unchanged for custom / stays on xxs for local", nameCheckT2, c3 && c3.name);

phase = "sibling";
// Now the engine really holds the sibling: the UI must follow the weights, still without a click.
// For custom kind: dot stays green (probe ok=true), name unchanged
let followed = false;
if (selectedKind === "custom") {
  // For custom models, sibling swap on the shared engine does not affect the selected custom model's dot
  followed = true;  // it stays "on" which is the correct behavior
  const c4check = await waitDot("on", 3000);
  followed = c4check;
} else {
  try {
    await page.waitForFunction(() => {
      const n = document.getElementById("model-name");
      return n && /iq3_s\b/.test(n.textContent) && document.getElementById("model-btn").dataset.dot === "on";
    }, null, { timeout: 9000 });
    followed = true;
  } catch (e) { followed = false; }
}
const c4 = await chip();
console.log("  chip:", JSON.stringify(c4));
check("selection follows the swapped-in weights by itself (or stays for custom)", followed, c4 && (c4.name + " " + c4.dot));
check("still no click involved", c4 && c4.popHidden === true);

phase = "real";
// And back again: the engine now really holds xxs (local) / custom endpoint is live, so the UI returns to it.
let returned = false;
if (selectedKind === "custom") {
  // For custom: phase=real means probe restored → dot should be green
  returned = await waitDot("on", 9000);
} else {
  try {
    await page.waitForFunction(() => {
      const n = document.getElementById("model-name");
      return n && /iq3_xxs/.test(n.textContent) && document.getElementById("model-btn").dataset.dot === "on";
    }, null, { timeout: 9000 });
    returned = true;
  } catch (e) { returned = false; }
}
const c5 = await chip();
console.log("  chip:", JSON.stringify(c5));
check("follows back when the original engine answers again", returned, c5 && (c5.name + " " + c5.dot));

console.log("\n=== T3: the poll cadence is live (not just a one-off repaint) ===");
const before = polls;
await page.waitForTimeout(13000);
const ticks = polls - before;
console.log("  GET /models/config in 13s:", ticks);
check("polls run every ~4s", ticks >= 2 && ticks <= 6, String(ticks));

check("no page errors", jsErrors.length === 0, jsErrors.slice(0, 3).join(" | "));
await page.screenshot({ path: "tests/_scratch_ux_shots/model_live.png" }).catch(() => {});
await browser.close();
console.log(FAILURES.length ? "\nMODEL LIVE: " + FAILURES.length + " FAILED" : "\nMODEL LIVE: ALL PASSED");
process.exit(FAILURES.length ? 1 : 0);
