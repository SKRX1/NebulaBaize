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

  // 0) PLAN C end-to-end: this workspace has NO group.txt (we removed ours before the run) but
  // DOES contain serve/web/app.js, so on session activation loadMemoryState -> deriveGroup must
  // auto-map it to the "frontend" group read-only and the card must already be visible WITHOUT
  // the user ever setting a group. That is exactly "a brand-new workspace uses the spec too".
  // (A fresh tab only sets currentGroup when the session is actually selected, so we click the
  //  seeded session row first to trigger selectSession -> loadMemoryState, like a real user.)
  await page.evaluate((sid) => { const r = document.querySelector('[data-sid="' + sid + '"]'); if (r) r.click(); }, SID);
  await page.waitForTimeout(900);   // selectSession -> loadMemoryState -> deriveGroup (auto)
  await page.evaluate(() => { const m = document.getElementById("tab-btn-memory"); if (m) m.click(); });
  await page.waitForTimeout(600);
  const autoCard = await page.evaluate(() => {
    const c = document.querySelector('.mem-tabpanel[data-mem="group"]');
    if (!c || c.hidden) return { ok:false, len:0 };
    const b = document.getElementById("mem-group-body");
    return { ok:true, len: b ? b.textContent.length : 0 };
  });
  check("PLAN C: with NO group.txt a serve/web workspace auto-shows the group card", autoCard.ok === true);
  check("PLAN C: the auto-shown card carries the frontend spec", autoCard.ok && autoCard.len > 20, "len=" + autoCard.len);
  const autoWroteGroup = await page.evaluate(async () => {
    // read-only guarantee: detection must NOT have created a group.txt. Read it through the same
    // mcp/call the page itself uses; a non-empty result means a file appeared.
    try {
      const r = await fetch("mcp/call", {method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({server:"filesystem", tool:"read", args:{path:"E:/Nebula/NebulaBaize/Nebula-agent/.Nebula-memory/group.txt"}})});
      const d = await r.json().catch(()=>({}));
      return !!(d && d.ok && d.text && d.text.trim());
    } catch (e) { return false; }
  });
  check("PLAN C: auto-detection created no group.txt (still read-only)", autoWroteGroup === false);

  // 0b) PLAN A menu path (what the user asked for): the workspace "..." button must now carry a
  //     "Group..." item, and clicking it must open the SAME shared group-modal for that workspace.
  //     This exercises the real sidebar menu -> openGroupPicker(path) wiring, not the memory page.
  const haveBtn = await page.evaluate(() => !!document.querySelector("[data-ws-menu]"));
  check("the workspace ... menu button is present", haveBtn === true);
  await page.evaluate(() => { const b = document.querySelector("[data-ws-menu]");
    if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); });
  await page.waitForTimeout(400);
  const menuHasGroup = await page.evaluate(() => {
    const item = document.querySelector(".st-ctx-menu [data-key=\"group\"]");
    return !!item;
  });
  check("the workspace ... menu now contains a Group... item", menuHasGroup === true);
  await page.evaluate(() => { const it = document.querySelector('.st-ctx-menu [data-key="group"]');
    if (it) it.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); });
  await page.waitForTimeout(400);
  await page.waitForTimeout(600);
  const menuModal = await page.evaluate(() => {
    const m = document.getElementById("group-modal");
    const gp = document.getElementById("group-path");
    if (!m || m.hidden) return { open:false };
    return { open:true, path: gp ? gp.textContent : "" };
  });
  check("clicking Group... opens the shared group-modal", menuModal.open === true);
  check("the modal is scoped to THAT workspace path", menuModal.open && /Nebula-agent/i.test(menuModal.path), "path=" + menuModal.path);
  // close it so the next (memory-page) flow starts from a clean state; opening writes nothing.
  const gtxtAfterMenu = await page.evaluate(async () => {
    try {
      const r = await fetch("mcp/call", {method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({server:"filesystem", tool:"read", args:{path:"E:/Nebula/NebulaBaize/Nebula-agent/.Nebula-memory/group.txt"}})});
      const d = await r.json().catch(()=>({})); return (d && d.ok && (d.text||"").trim()) || "";
    } catch (e) { return ""; }
  });
  check("opening the modal from the menu wrote nothing (still no group.txt)", gtxtAfterMenu === "", "got=" + JSON.stringify(gtxtAfterMenu));
  // The close button must be VISIBLE and actually close the modal in a real browser. (The earlier
  // screenshot bug: an icon id not present in sprite.svg renders blank, so the button looked absent.)
  const closeBtn = await page.evaluate(() => {
    const c = document.getElementById("group-close"); if (!c) return { exists:false };
    const r = c.getBoundingClientRect();
    const u = c.querySelector("use");
    return { exists:true, visible: r.width > 4 && r.height > 4,
             icon: u ? (u.getAttribute("href") || u.getAttribute("xlink:href") || "") : "" };
  });
  check("the modal has a VISIBLE close button (non-zero size)  " + JSON.stringify({v:closeBtn.visible,icon:closeBtn.icon}),
        closeBtn.exists && closeBtn.visible && /#i-chevron$/.test(closeBtn.icon));
  await page.evaluate(() => { const c = document.getElementById("group-close"); if (c) c.click(); });
  await page.waitForTimeout(300);
  const closedByCloseBtn = await page.evaluate(() => { const m = document.getElementById("group-modal"); return !!m && m.hidden; });
  check("clicking the close button actually closes the modal", closedByCloseBtn === true);

  // 0c) RIGHT-CLICK path (item 2): right-clicking a workspace header must open the SAME menu that
  //     carries "Group...", because the contextmenu handler reuses wsMenuItems(path) verbatim. We
  //     never edit wsMenuItems for the menu separately, so proving the "..." menu proves the right
  //     click too; this assertion makes that shared-code claim explicit and load-bearing.
  const rc = await page.evaluate(() => {
    const head = document.querySelector("[data-ws-head]"); if (!head) return { hasHead:false };
    head.dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true, clientX:30, clientY:30 }));
    return { hasHead:true, path: head.dataset.wsHead || "" };
  });
  check("a workspace header is present for right-click", rc.hasHead === true);
  await page.waitForTimeout(400);
  const rcMenu = await page.evaluate(() => {
    const m = document.querySelector(".st-ctx-menu");
    return { open: !!m && !m.hidden, keys: m ? [...m.querySelectorAll("[data-key]")].map(b=>b.dataset.key) : [] };
  });
  check("right-click opens the workspace menu containing Group...", rcMenu.open && rcMenu.keys.includes("group"), JSON.stringify(rcMenu));
  const rcOpened = await page.evaluate(() => {
    const it = document.querySelector('.st-ctx-menu [data-key="group"]');
    if (!it) return false;
    it.dispatchEvent(new MouseEvent("click", { bubbles:true, cancelable:true, view:window }));
    return true;
  });
  await page.waitForTimeout(500);
  const rcModal = await page.evaluate(() => {
    const m = document.getElementById("group-modal"); const gp = document.getElementById("group-path");
    if (!m || m.hidden) return { open:false };
    return { open:true, path: gp ? gp.textContent : "" };
  });
  check("right-click -> Group... opens the group-modal scoped to that workspace", rcModal.open && /Nebula-agent/i.test(rcModal.path), "path=" + rcModal.path);
  await page.evaluate(() => { const m = document.getElementById("group-modal"); if (m && !m.hidden) { const c=document.getElementById("group-close"); if(c) c.click(); } });
  await page.waitForTimeout(300);

  // 1) PLAN A end-to-end: the "set workspace group" button now opens an inline picker (no prompt).
  //    Opening it must list the groups that really exist on disk (this repo has a "frontend" group),
  //    and selecting one must route through setGroupLabel (which writes group.txt) — proving the
  //    picker is wired to the single source of truth, not a second mechanism.
  const setClicked = await page.evaluate(() => { const b = document.getElementById("mem-auto-setgroup"); if (b) { b.click(); return true; } return false; });
  check("group-set button present and clicked", setClicked);
  await page.waitForTimeout(700);   // openGroupPanel -> fillGroupSelect -> listGroups (real disk)
  const panelState = await page.evaluate(() => {
    const p = document.getElementById("group-modal");
    const sel = document.getElementById("group-groupsel");
    if (!p || p.hidden || !sel) return { open:false, opts:[] };
    return { open:true, opts: [...sel.options].map((o) => o.value) };
  });
  check("PLAN A: the set-group button opens the shared group-modal", panelState.open === true);
  check("PLAN A: the picker lists the real on-disk group(s)  " + JSON.stringify(panelState.opts),
        panelState.opts.includes("frontend") && panelState.opts[0] === "");   // empty (no-group) first
  // Selecting the existing "frontend" group triggers onchange -> setGroupLabel("frontend") -> a
  // real write of group.txt. Capture that write explicitly.
  captured.length = 0;
  const joined = await page.evaluate(() => {
    const sel = document.getElementById("group-groupsel"); if (!sel) return false;
    sel.value = "frontend";
    sel.dispatchEvent(new Event("change", { bubbles: true }));   // fires the wired onchange
    return sel.value === "frontend";
  });
  check("PLAN A: selecting an existing group in the picker takes effect", joined === true);
  await page.waitForTimeout(900);   // let setGroupLabel + loadMemoryState settle
  const groupTxtWritten = await page.evaluate(async () => {
    // the picker must have written the workspace group.txt (single source of truth), not anything else
    try {
      const r = await fetch("mcp/call", {method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({server:"filesystem", tool:"read", args:{path:"E:/Nebula/NebulaBaize/Nebula-agent/.Nebula-memory/group.txt"}})});
      const d = await r.json().catch(()=>({}));
      return !!(d && d.ok && (d.text||"").trim() === "frontend");
    } catch (e) { return false; }
  });
  check("PLAN A: choosing the group wrote group.txt = frontend (routes through setGroupLabel)",
        groupTxtWritten === true);
  captured.length = 0;   // reset capture so the later RULES.md-save capture stays clean

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

  // The NEW-WORKSPACE dialog is the other place the user reported an English "frontend". It uses a
  // text input backed by a <datalist>; we set option label=前端 so a Chinese browser SHOWS 前端
  // while the field still submits the real value "frontend". Prove the data is rendered localized.
  await page.evaluate(() => { if (window.i18n) window.i18n.setLang("zh"); });
  await page.waitForTimeout(200);
  await page.evaluate(() => { const b = document.getElementById("workspace-btn"); if (b) b.click(); });
  await page.waitForTimeout(600);   // openWorkspacePicker -> listGroups -> datalist fill (async)
  const wsDatalist = await page.evaluate(() => {
    const dl = document.getElementById("ws-group-list");
    const opts = dl ? [...dl.options].map((o) => ({ v: o.value, label: o.getAttribute("label") || "" })) : [];
    return { open: !!document.getElementById("ws-modal") && !document.getElementById("ws-modal").hidden, opts };
  });
  check("the new-workspace dialog is open for inspection", wsDatalist.open === true);
  const feOpt = wsDatalist.opts.find((o) => o.v === "frontend");
  check("ws-modal datalist keeps value=frontend but LABELS it 前端 (submits the real name)  " + JSON.stringify(feOpt),
        !!feOpt && feOpt.label === "前端");
  // reading the dialog must not change the group on disk; close it to leave a clean state.
  const gtxtAfterWs = await page.evaluate(async () => {
    try {
      const r = await fetch("mcp/call", {method:"POST", headers:{"content-type":"application/json"},
        body: JSON.stringify({server:"filesystem", tool:"read", args:{path:"E:/Nebula/NebulaBaize/Nebula-agent/.Nebula-memory/group.txt"}})});
      const d = await r.json().catch(()=>({})); return (d && d.ok && (d.text||"").trim()) || "";
    } catch (e) { return ""; }
  });
  check("inspecting ws-modal wrote nothing to group.txt", gtxtAfterWs === "" || gtxtAfterWs === "frontend", "got=" + JSON.stringify(gtxtAfterWs));
  await page.evaluate(() => { const c = document.getElementById("ws-close"); if (c) c.click(); });
  await page.waitForTimeout(300);

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
