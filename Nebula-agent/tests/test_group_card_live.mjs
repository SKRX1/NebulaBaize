/* LIVE e2e for the group spec card, against the running 8099 gateway (real Edge, real
 * backend, real disk). Verifies the behaviour the user asked to eyeball:
 *   1) set this workspace's group to "frontend" (click the real button + accept the prompt);
 *   2) the group card appears and shows that group's RULES.md;
 *   3) edit + Save posts a REAL filesystem write whose path is that group's RULES.md
 *      (captured from the real network request, not assumed);
 *   4) a SECOND real tab reads the saved bytes back (cross-tab consistency).
 *
 * The group feature keys off the active session's workspace, so each tab is seeded (before any
 * app script runs) with a single session whose workspace is THIS workspace and marked active.
 * That makes activeSession().workspace resolve to the real path; clicking "set this workspace
 * group" then writes <ws>/.Nebula-memory/group.txt and loadMemoryState() activates currentGroup.
 *
 * It restores the group RULES.md from an in-memory snapshot and removes any group.txt it
 * created, so the live probe leaves the disk exactly as it found it.
 *
 * Run: node tests/test_group_card_live.mjs   (needs the 8099 gateway up; skip-exit=2 if down)
 */
import { createRequire } from "module";
import fs from "fs";

let chromium;
try { ({ chromium } = createRequire(import.meta.url)("playwright")); }
catch (e) {
  try { ({ chromium } = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/")("playwright")); }
  catch (e2) { console.error("playwright missing: from repo root run  npm i playwright"); process.exit(2); }
}

const BASE = "http://127.0.0.1:8099";
const WS = "E:/Nebula/NebulaBaize/Nebula-agent";          // the live workspace we attribute the group to
const GRP_RULES_WIN = "E:\\Nebula\\NebulaBaize\\.Nebula-memory\\groups\\frontend\\RULES.md";
const GRP_TXT_WIN = "E:\\Nebula\\NebulaBaize\\Nebula-agent\\.Nebula-memory\\group.txt";
const SID = "live-probe-sess";

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

// snapshot the real files so we can restore the disk byte-for-byte afterwards.
const hadRules = fs.existsSync(GRP_RULES_WIN);
const origRules = hadRules ? fs.readFileSync(GRP_RULES_WIN) : null;
const hadGroupTxt = fs.existsSync(GRP_TXT_WIN);
const origGroupTxt = hadGroupTxt ? fs.readFileSync(GRP_TXT_WIN) : null;

const main = async () => {
  const browser = await chromium.launch({ channel: "msedge" });

  // Seed a session whose workspace is this workspace + mark it active (real store keys).
  // NOTE: addInitScript serialises the function, so WS/SID must come in as an explicit payload
  // argument — closing over them would silently drop them to undefined in the page.
  const SEED_DATA = { ws: WS, sid: SID };
  const seed = (data) => {
    const s = [{ id: data.sid, title: "live-probe", workspace: data.ws, permission: "auto", persona: "", messages: [], updatedAt: Date.now() }];
    try {
      localStorage.setItem("strata.sessions", JSON.stringify(s));
      localStorage.setItem("strata.session.active", JSON.stringify(data.sid));
    } catch (e) {}
  };
  const captured = [];
  const newTab = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(seed, SEED_DATA);
    const p = await ctx.newPage();
    p.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("mcp/call")) {
        try { const b = JSON.parse(r.postData() || "{}");
          if (b.tool === "write" && b.args && /RULES\.md$/i.test(b.args.path || "")) captured.push(b.args.path);
        } catch (e) {}
      }
    });
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    return p;
  };

  const page = await newTab();
  await page.waitForTimeout(1200);

  // confirm the seeded session is active before relying on it
  const wsActive = await page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem("strata.sessions")||"[]")[0].workspace; } catch (e) { return null; }
  });
  check("workspace session seeded  " + JSON.stringify(wsActive), wsActive === WS);

  // open the memory tab
  const opened = await page.evaluate(() => {
    const mem = document.getElementById("tab-btn-memory"); if (mem) { mem.click(); return true; } return false;
  });
  check("memory tab opened", opened);

  // 1) set group = frontend (real button + auto-accept prompt with "frontend")
  page.once("dialog", (d) => d.accept("frontend"));
  await page.waitForTimeout(200);
  const setClicked = await page.evaluate(() => { const b = document.getElementById("mem-auto-setgroup"); if (b) { b.click(); return true; } return false; });
  check("group-set button present and clicked", setClicked);
  await page.waitForTimeout(900);   // let setGroupLabel + loadMemoryState settle

  // re-render the memory tab so renderGroupCard() runs against the now-active currentGroup
  await page.evaluate(() => { const mem = document.getElementById("tab-btn-memory"); if (mem) mem.click(); });
  await page.waitForTimeout(500);

  // 2) the group card must now be visible and show that group's rules.
  const card = await page.evaluate(() => {
    const c = document.querySelector('.mem-tabpanel[data-mem="group"]');
    if (!c || c.hidden) return { ok:false, len:0 };
    const b = document.getElementById("mem-group-body");
    return { ok:true, len: b ? b.textContent.length : 0 };
  });
  check("the group card is now visible", card.ok === true);
  check("the card shows that group's RULES.md content", card.ok && card.len > 20, "len=" + card.len);

  // 3) real edit + Save -> capture the REAL write path from the wire.
  captured.length = 0;
  const edited = "frontend rules LIVE-" + Date.now();
  await page.evaluate(() => { const eb = document.querySelector("[data-group-edit]"); if (eb) eb.click(); });
  await page.waitForSelector("#mem-group-save", { state: "attached", timeout: 4000 }).catch(() => {});
  const taReady = await page.evaluate(() => !!document.querySelector("#mem-group-body textarea"));
  check("the real edit flow produced an editable textarea", taReady);
  if (taReady) {
    await page.evaluate((v) => { const ta = document.querySelector("#mem-group-body textarea"); if (ta) ta.value = v; }, edited);
    await page.evaluate(() => { const s = document.getElementById("mem-group-save"); if (s) s.click(); });
    await page.waitForTimeout(900);
  }
  const paths = captured.slice();
  check("a real filesystem write was posted on Save", paths.length >= 1, "n=" + paths.length);
  const groupScoped = paths.some((p) => /groups[\/\\]frontend[\/\\]RULES\.md$/i.test(p));
  check("the write path is the group's frontend RULES.md  " + JSON.stringify(paths[paths.length-1]), groupScoped);

  // 4) a fresh second tab reads it back. A real new tab restores the session list but only
  // sets currentGroup when the user actually selects that workspace's session (selectSession ->
  // loadMemoryState), exactly like a human switching workspaces. So we open a sibling tab in
  // the SAME context (shared storage), let it boot, then click that session row.
  await page.waitForTimeout(400);
  const ctx2 = page.context();
  const page2 = await ctx2.newPage();
  await page2.goto(BASE, { waitUntil: "domcontentloaded" });
  await page2.waitForTimeout(1000);
  const clickedRow = await page2.evaluate((sid) => {
    const row = document.querySelector('[data-sid="' + sid + '"]');
    if (row) { row.click(); return true; } return false;
  }, SID);
  check("the second tab could select the workspace session row", clickedRow);
  await page2.waitForTimeout(700);   // let selectSession -> loadMemoryState set currentGroup
  await page2.evaluate(() => { const mem = document.getElementById("tab-btn-memory"); if (mem) mem.click(); });
  await page2.waitForTimeout(700);
  const back = await page2.evaluate(() => {
    const c = document.querySelector('.mem-tabpanel[data-mem="group"]');
    if (!c || c.hidden) return { visible:false, text:"" };
    const b = document.getElementById("mem-group-body");
    return { visible:true, text: b ? b.textContent : "" };
  });
  check("the second tab shows the group card (read its group from disk)", back.visible === true);
  check("the second tab reads back the saved bytes  " + JSON.stringify((back.text||"").slice(0,40)),
        (back.text || "").includes(edited));

  await browser.close();

  // ---- restore the disk exactly as found ----
  const restore = (win, had, orig) => {
    try {
      if (had) fs.writeFileSync(win, orig);
      else if (fs.existsSync(win)) fs.unlinkSync(win);
    } catch (e) { console.error("RESTORE FAILED", win, String(e)); }
  };
  restore(GRP_RULES_WIN, hadRules, origRules);
  restore(GRP_TXT_WIN, hadGroupTxt, origGroupTxt);
  console.log("\nrestored group RULES.md bytes:", hadRules ? origRules.length : 0,
              "| removed created group.txt:", !hadGroupTxt);

  if (FAILURES.length) { console.log("GROUP-CARD-LIVE: FAIL (" + FAILURES.length + ")"); process.exit(1); }
  console.log("GROUP-CARD-LIVE: ALL GREEN");
  process.exit(0);
};

main().catch((e) => { console.error("GROUP-CARD-LIVE crashed:", String(e)); process.exit(3); });
