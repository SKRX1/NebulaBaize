/* Tools tab: manage MCP servers and skills — a pure same-origin MCP client.
 *
 * The old version probed for a management API: same-origin first, then the
 * standalone gateway's port, remembering what worked. That existed because the
 * management API (/api/*) only ever lived on the gateway, while this page is
 * served by whoever serves the web app — the Strata host in parasitic mode, the
 * gateway in standalone mode. In parasitic mode the tab was therefore dead.
 *
 * The fix is to stop looking for a second origin. BOTH modes expose the same
 * two same-origin endpoints, and they carry everything this tab needs:
 *
 *   GET  mcp        every server, its live state and its tools (the Monitor card
 *                   already uses it) — the runtime overlay here;
 *   POST mcp/call   direct tool invocation — the read/write path here, against
 *                   the `registry` MCP server (servers/registry_server.py),
 *                   which wraps runtime/registry.py with its atomic writes,
 *                   backups and audit trail.
 *
 * When the registry tools are missing (an older host, or a direct-mode gateway
 * whose upstream has no MCP), the tab degrades to read-only: the live list from
 * GET mcp still renders, and the reason is stated instead of a dead form.
 *
 * Note the response contract of POST /mcp/call: it answers
 * {server, tool, ok, text, chars, ...} — the tool's payload is JSON inside
 * `text`. Consumers that read `content[0].text` (or expect the raw array) get
 * nothing; mcpCall() below is the single place that knows this.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // i18n.js loads before this file in the normal case. If it didn't (e.g. a stale cached
  // page), fall back to the raw key so the Tools tab still renders instead of throwing.
  const t = (key, params) => {
    if (window.i18n) return window.i18n.t(key, params);
    if (!params) return key;
    return key.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
  };
  // app.js owns headers() (it attaches the API key when the server wants one). In the
  // render tests app.js is not loaded, so fall back to a plain JSON header there.
  const hdrs = (json) => (typeof headers === "function" ? headers(json)
    : (json ? { "Content-Type": "application/json" } : {}));

  // ─── the one channel ────────────────────────────────────────────────────────

  function payload(text) {
    const s = String(text == null ? "" : text).trim();
    if (!s) return {};
    try { return JSON.parse(s); } catch (e) { return { text: s }; }
  }

  async function mcpCall(server, tool, args) {
    let r;
    try {
      r = await fetch("mcp/call", { method: "POST", headers: hdrs(true),
        body: JSON.stringify({ server, tool, args: args || {} }) });
    } catch (e) {
      throw new Error(t("adm.err.unreachable"));
    }
    let data = {};
    try { data = await r.json(); } catch (e) { /* an HTML error page, say so below */ }
    if (!r.ok) throw new Error((data.error && data.error.message) || `HTTP ${r.status}`);
    if (!data.ok) {
      throw new Error(String(data.text || "the tool call failed").replace(/^error:\s*/, ""));
    }
    return payload(data.text);
  }

  // ─── state ─────────────────────────────────────────────────────────────────

  let servers = [];        // registry summaries (or live-derived when read-only)
  let skills = [];         // registry summaries
  let live = {};           // name -> live server object from GET mcp (best-effort overlay)
  let serverCache = {};    // name -> full spec, fetched on selection (list stays a summary)
  let skillCache = {};     // name -> full skill, same reason
  let canWrite = true;     // false once the registry tools are known to be missing
  let readonlyWhy = "";
  let sel = null;          // {kind:'server'|'skill', name, isNew}
  let notice = null;       // {kind:'ok'|'err', text}
  let loaded = false;

  async function loadLive() {
    try {
      const r = await fetch("mcp", { headers: hdrs() });
      if (!r.ok) return;
      const j = await r.json();
      live = {};
      for (const s of (j.servers || [])) live[s.name] = s;
    } catch (e) {
      live = {};           // the overlay is best-effort: management works without it
    }
  }

  async function refresh() {
    serverCache = {};      // specs are stale the moment the config changed
    skillCache = {};
    await loadLive();
    try {
      const [s, k] = await Promise.all([
        mcpCall("registry", "list_servers", {}),
        mcpCall("registry", "list_skills", {}),
      ]);
      servers = s.servers || [];
      skills = k.skills || [];
      canWrite = true;
    } catch (e) {
      // No registry tools on this server: keep showing what IS running, but every
      // edit path is off, with the reason on screen rather than a dead form.
      canWrite = false;
      readonlyWhy = e.message;
      servers = Object.values(live).map((s) => ({ name: s.name, command: "", origin: "",
                                                  skill: null, n_args: (s.tools || []).length }));
      skills = [];
    }
    renderList();
    renderDetail();
    renderNotice();
  }

  // ─── Left column ─────────────────────────────────────────────────────────────

  const liveBadge = (name) => {
    const s = live[name];
    if (!s) return "";
    const cls = { ready: "st-badge--generating", starting: "st-badge--reading",
                  failed: "st-badge--error", stopped: "st-badge--queued" }[s.status] || "";
    const label = t("mcp.state." + s.status) === "mcp.state." + s.status
      ? s.status : t("mcp.state." + s.status);
    return `<span class="st-badge ${cls}" title="${esc(t("adm.live.tip"))}">${esc(label)}</span>`;
  };

  function renderList() {
    $("adm-servers").innerHTML = servers.length
      ? servers.map((s) => `
        <button class="adm-item${isSel("server", s.name) ? " is-sel" : ""}"
                data-kind="server" data-name="${esc(s.name)}">
          <span class="adm-item__name">${esc(s.name)}</span>
          ${liveBadge(s.name)}
          ${s.origin ? `<span class="adm-tag adm-tag--${esc(s.origin)}">${esc(s.origin)}</span>` : ""}
        </button>`).join("")
      : `<p class="muted small">${esc(t("adm.none"))}</p>`;

    $("adm-skills").innerHTML = skills.length
      ? skills.map((s) => `
        <button class="adm-item${isSel("skill", s.name) ? " is-sel" : ""}"
                data-kind="skill" data-name="${esc(s.name)}">
          <span class="adm-item__name">${esc(s.name)}</span>
          <span class="adm-tag adm-tag--skill">${esc(t("adm.srv", { n: (s.servers || []).length }))}</span>
        </button>`).join("")
      : `<p class="muted small">${canWrite ? esc(t("adm.none")) : esc(t("adm.unavailable"))}</p>`;
    bindList();
  }

  // Bound here rather than in bindDetail(): the empty-state branch of renderDetail()
  // returns early, so list clicks would never get wired if they lived there.
  function bindList() {
    for (const b of document.querySelectorAll("#adm-servers .adm-item, #adm-skills .adm-item")) {
      b.onclick = () => {
        notice = null;
        sel = { kind: b.dataset.kind, name: b.dataset.name };
        renderList();
        renderDetail();
        renderNotice();
      };
    }
  }

  const isSel = (kind, name) => !!sel && sel.kind === kind && sel.name === name;

  // ─── Right column ───────────────────────────────────────────────────────────

  function renderDetail() {
    const host = $("adm-detail");
    if (!sel) {
      host.innerHTML = `<div class="st-card adm-card adm-empty">
        <span class="card-title">${esc(t("tab.tools"))}</span>
        <p class="muted">${esc(t("adm.pick"))}</p></div>`;
      return;
    }
    if (sel.kind === "server") {
      if (sel.isNew || !canWrite) { host.innerHTML = serverForm(null); bindDetail(); return; }
      const full = serverCache[sel.name];
      if (full) { host.innerHTML = serverForm(full); bindDetail(); return; }
      host.innerHTML = `<div class="st-card adm-card"><p class="muted small">${esc(t("adm.testing"))}</p></div>`;
      loadServerDetail(sel.name);               // re-renders when the spec arrives
      return;
    }
    // skill
    if (sel.isNew || !canWrite) { host.innerHTML = skillForm(null); bindDetail(); return; }
    const full = skillCache[sel.name];
    if (full) { host.innerHTML = skillForm(full); bindDetail(); return; }
    host.innerHTML = `<div class="st-card adm-card"><p class="muted small">${esc(t("adm.testing"))}</p></div>`;
    loadSkillDetail(sel.name);
  }

  // list_* returns summaries; the editor needs the full spec, so it is fetched on
  // selection and cached until the next refresh (which invalidates it).
  async function loadServerDetail(name) {
    try {
      const r = await mcpCall("registry", "get_server", { name });
      serverCache[name] = r.server || {};
      if (sel && sel.kind === "server" && sel.name === name) renderDetail();
    } catch (e) {
      if (!(sel && sel.kind === "server" && sel.name === name)) return;
      $("adm-detail").innerHTML = `<div class="st-card adm-card">
        <span class="card-title">${esc(name)}</span>
        <p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  async function loadSkillDetail(name) {
    try {
      const r = await mcpCall("registry", "get_skill", { name });
      skillCache[name] = r.skill || {};
      if (sel && sel.kind === "skill" && sel.name === name) renderDetail();
    } catch (e) {
      if (!(sel && sel.kind === "skill" && sel.name === name)) return;
      $("adm-detail").innerHTML = `<div class="st-card adm-card">
        <span class="card-title">${esc(name)}</span>
        <p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  // Notices render in their own slot above the detail pane, not inside it: import and
  // reload are global actions, and the detail pane shows an empty state when nothing is
  // selected — a notice embedded there would vanish exactly when it matters most.
  function setNotice(kind, text) {
    notice = { kind, text };
    renderNotice();
  }

  function renderNotice() {
    const host = $("adm-notice");
    if (!host) return;
    host.innerHTML = notice
      ? `<div class="adm-note adm-note--${notice.kind === "err" ? "err" : "ok"}">${esc(notice.text)}</div>`
      : "";
  }

  const dis = (on) => (on ? " disabled" : "");

  function serverForm(full) {
    const ro = !canWrite;
    // read-only mode has no spec to edit: show what is running instead of an empty form
    if (ro && !sel.isNew) {
      const lv = live[sel.name];
      return `<div class="st-card adm-card">
        <div class="adm-head"><span class="card-title">${esc(sel.name)}</span>
          ${liveBadge(sel.name)}</div>
        <div class="adm-note adm-note--warn">${esc(t("adm.readonly.title"))} — ${esc(t("adm.readonly.body", { why: readonlyWhy }))}</div>
        ${lv ? `<p class="muted small">${esc(lv.transport)} · ${esc(t("unit.tools", { n: (lv.tools || []).length }))}</p>` : ""}
        ${lv && (lv.tools || []).length
          ? `<div class="mcp-server__tools">${lv.tools.map((tl) =>
              `<span class="chip" title="${esc(tl.description || "")}">${esc(tl.tool)}</span>`).join("")}</div>`
          : ""}
      </div>`;
    }
    const s = full || { name: "", command: "", args: [], cwd: "", env: {}, origin: "user" };
    const locked = !!full && s.origin === "skill";
    return `<div class="st-card adm-card">
      <div class="adm-head"><span class="card-title">${sel.isNew ? esc(t("adm.new.server.title")) : esc(sel.name)}</span>
        ${liveBadge(sel.name)}
        <span class="adm-tag adm-tag--${esc(s.origin)}">${esc(s.origin)}</span></div>
      ${ro ? `<div class="adm-note adm-note--warn">${esc(t("adm.readonly.body", { why: readonlyWhy }))}</div>` : ""}
      ${locked ? `<div class="adm-note adm-note--warn">${esc(t("adm.locked", { name: s.skill || "" }))}</div>` : ""}
      <div class="adm-form">
        <label class="st-field"><span class="st-label">${esc(t("adm.name"))}</span>
          <input class="st-input" id="f-name" ${sel.isNew ? "" : "readonly"} value="${esc(s.name)}"
                 placeholder="${esc(t("adm.name.ph"))}"${dis(ro || locked)}></label>
        <label class="st-field"><span class="st-label">${esc(t("adm.command"))}</span>
          <input class="st-input" id="f-command" value="${esc(s.command)}"
                 placeholder="${esc(t("adm.command.ph"))}"${dis(ro || locked)}></label>
        <label class="st-field"><span class="st-label">${esc(t("adm.args"))} <output>${esc(t("adm.args.hint"))}</output></span>
          <textarea class="st-input" id="f-args" rows="3"${dis(ro || locked)}>${esc((s.args || []).join("\n"))}</textarea></label>
        <label class="st-field"><span class="st-label">${esc(t("adm.cwd"))} <output>${esc(t("adm.cwd.hint"))}</output></span>
          <input class="st-input" id="f-cwd" value="${esc(s.cwd)}"${dis(ro || locked)}></label>
        <label class="st-field"><span class="st-label">${esc(t("adm.env"))} <output>${esc(t("adm.env.hint"))}</output></span>
          <textarea class="st-input" id="f-env" rows="2"${dis(ro || locked)}>${esc(
            Object.entries(s.env || {}).map(([k, v]) => `${k}=${v}`).join("\n"))}</textarea></label>
      </div>
      <div class="adm-actions">
        <button class="st-btn st-btn--primary" id="f-save"${dis(ro || locked)}>${sel.isNew ? esc(t("adm.create")) : esc(t("adm.save"))}</button>
        <button class="st-btn st-btn--secondary" id="f-test"${dis(ro)}>${esc(t("adm.test"))}</button>
        ${sel.isNew ? "" : `<button class="st-btn st-btn--danger" id="f-del"
          ${locked ? `disabled title="${esc(t("adm.del.skill.hint"))}"` : dis(ro)}>${esc(t("adm.delete"))}</button>`}
      </div>
      <div id="f-result" class="adm-result"></div>
    </div>`;
  }

  function skillForm(full) {
    const k = full || { name: "", description: "", tools: [{}], triggers: [], permissions: {} };
    const ro = !canWrite;
    return `<div class="st-card adm-card">
      <div class="adm-head"><span class="card-title">${sel.isNew ? esc(t("adm.new.skill.title")) : esc(sel.name)}</span>
        <span class="adm-tag adm-tag--skill">skill</span></div>
      <div class="adm-note adm-note--info">${t("adm.skill.intro")}</div>
      ${ro ? `<div class="adm-note adm-note--warn">${esc(t("adm.readonly.title"))} — ${esc(t("adm.readonly.body", { why: readonlyWhy }))}</div>` : ""}
      <div class="adm-form">
        <label class="st-field"><span class="st-label">${esc(t("adm.name"))}</span>
          <input class="st-input" id="f-name" ${sel.isNew ? "" : "readonly"} value="${esc(k.name)}"${dis(ro)}></label>
        <label class="st-field"><span class="st-label">${esc(t("adm.skill.desc"))}</span>
          <input class="st-input" id="f-desc" value="${esc(k.description)}"${dis(ro)}></label>
      </div>
      <div class="adm-sub"><span class="st-label">${esc(t("adm.skill.tools"))}</span>
        <button class="st-btn st-btn--secondary adm-mini" id="f-add-tool"${dis(ro)}>${esc(t("adm.skill.addtool"))}</button></div>
      <div id="f-tools">${(k.tools || [{}]).map(toolRow).join("")}</div>
      <div class="adm-form">
        <label class="st-field"><span class="st-label">${esc(t("adm.skill.triggers"))} <output>${esc(t("adm.skill.triggers.hint"))}</output></span>
          <textarea class="st-input" id="f-trig" rows="2"${dis(ro)}>${esc((k.triggers || []).join("\n"))}</textarea></label>
      </div>
      <div class="adm-actions">
        <button class="st-btn st-btn--primary" id="f-save"${dis(ro)}>${sel.isNew ? esc(t("adm.create")) : esc(t("adm.save"))}</button>
        ${sel.isNew ? "" : `<button class="st-btn st-btn--danger" id="f-del"${dis(ro)}>${esc(t("adm.delete"))}</button>`}
      </div>
      <div id="f-result" class="adm-result"></div>
    </div>`;
  }

  // The param is `tool`, not `t`: `t` is the i18n helper and this row needs it for the
  // placeholders below.
  const toolRow = (tool) => `<div class="adm-tool">
    <input class="st-input" data-k="mcp" placeholder="${esc(t("adm.tool.mcp.ph"))}" value="${esc(tool.mcp || "")}"${dis(!canWrite)}>
    <input class="st-input" data-k="command" placeholder="${esc(t("adm.tool.cmd.ph"))}" value="${esc(tool.command || "")}"${dis(!canWrite)}>
    <textarea class="st-input" data-k="args" rows="2"${dis(!canWrite)}
      placeholder="${esc(t("adm.tool.args.ph"))}">${esc((tool.args || []).join("\n"))}</textarea>
    <button class="st-btn st-btn--danger adm-mini" data-rmtool="1"${dis(!canWrite)}>${esc(t("adm.tool.remove"))}</button>
  </div>`;

  // ─── Form plumbing ──────────────────────────────────────────────────────────

  function bindDetail() {
    const save = $("f-save");
    if (save) save.onclick = sel.kind === "server" ? saveServer : saveSkill;
    const del = $("f-del");
    if (del) del.onclick = sel.kind === "server" ? deleteServer : deleteSkill;
    const test = $("f-test");
    if (test) test.onclick = testServer;
    const addTool = $("f-add-tool");
    if (addTool) addTool.onclick = () => {
      $("f-tools").insertAdjacentHTML("beforeend", toolRow({}));
      bindTools();
    };
    bindTools();
  }

  function bindTools() {
    for (const b of document.querySelectorAll("#f-tools [data-rmtool]")) {
      b.onclick = () => {
        if (document.querySelectorAll("#f-tools .adm-tool").length <= 1) return;
        b.closest(".adm-tool").remove();
      };
    }
  }

  const lines = (v) => String(v || "").split("\n").map((x) => x.trim()).filter(Boolean);

  function collectServer() {
    const env = {};
    for (const l of lines($("f-env").value)) {
      const i = l.indexOf("=");
      if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    const spec = { command: $("f-command").value.trim(), args: lines($("f-args").value) };
    const cwd = $("f-cwd").value.trim();
    if (cwd) spec.cwd = cwd;
    if (Object.keys(env).length) spec.env = env;
    return { name: $("f-name").value.trim(), spec };
  }

  function collectSkill() {
    const tools = [];
    for (const row of document.querySelectorAll("#f-tools .adm-tool")) {
      const get = (k) => (row.querySelector(`[data-k="${k}"]`) || {}).value || "";
      const mcp = get("mcp").trim();
      if (!mcp) continue;
      tools.push({ mcp, command: get("command").trim(), args: lines(get("args")) });
    }
    return {
      name: $("f-name").value.trim(),
      spec: { description: $("f-desc").value.trim(), tools, triggers: lines($("f-trig").value) },
    };
  }

  // A config edit reaches a running system only at its next start: the Strata host
  // reads mcp_servers.json once at startup, and so does the gateway's executor. Say
  // that on every save instead of letting the change look broken.

  async function saveServer() {
    const { name, spec } = collectServer();
    try {
      if (!canWrite) throw new Error(t("adm.readonly.title"));
      if (!name) throw new Error(t("adm.err.name"));
      const r = sel.isNew ? await mcpCall("registry", "add_server", { name, spec })
                          : await mcpCall("registry", "update_server", { name, spec });
      const warns = r.warnings || [];
      setNotice("ok", t("adm.applied")
        + (warns.length ? " " + t("adm.warn", { w: warns.join("; ") }) : ""));
      sel = { kind: "server", name };
      await refresh();
    } catch (e) { setNotice("err", e.message); }
  }

  async function saveSkill() {
    const { name, spec } = collectSkill();
    try {
      if (!canWrite) throw new Error(t("adm.readonly.title"));
      if (!name) throw new Error(t("adm.err.name"));
      if (!spec.tools.length) throw new Error(t("adm.err.tool"));
      if (sel.isNew) await mcpCall("registry", "add_skill", { name, spec });
      else await mcpCall("registry", "update_skill", { name, spec });
      setNotice("ok", t("adm.applied"));
      sel = { kind: "skill", name };
      await refresh();
    } catch (e) { setNotice("err", e.message); }
  }

  async function testServer() {
    const { spec } = collectServer();
    const box = $("f-result");
    box.innerHTML = `<p class="muted small">${esc(t("adm.testing"))}</p>`;
    try {
      const r = await mcpCall("registry", "test_server", { spec });
      box.innerHTML = r.ok
        ? `<div class="adm-note adm-note--ok">${esc(t("adm.connected", { n: r.tools.length }))}
             ${esc((r.tools || []).map((tl) => tl.name).join(", "))}</div>`
        : `<div class="adm-note adm-note--err">${esc(r.error || t("adm.test.failed"))}</div>`;
    } catch (e) {
      box.innerHTML = `<div class="adm-note adm-note--err">${esc(e.message)}</div>`;
    }
  }

  async function deleteServer() {
    if (!confirm(t("adm.confirm.server", { name: sel.name }))) return;
    try {
      if (!canWrite) throw new Error(t("adm.readonly.title"));
      await mcpCall("registry", "delete_server", { name: sel.name });
      setNotice("ok", t("adm.applied"));
      sel = null;
      await refresh();
    } catch (e) { setNotice("err", e.message); }
  }

  async function deleteSkill() {
    if (!confirm(t("adm.confirm.skill", { name: sel.name }))) return;
    try {
      if (!canWrite) throw new Error(t("adm.readonly.title"));
      await mcpCall("registry", "delete_skill", { name: sel.name });
      setNotice("ok", t("adm.applied"));
      sel = null;
      await refresh();
    } catch (e) { setNotice("err", e.message); }
  }

  // ─── Import ────────────────────────────────────────────────────────────────

  async function importJson() {
    const box = $("adm-import");
    let payload;
    try {
      payload = JSON.parse(box.value);
    } catch (e) {
      setNotice("err", t("adm.import.badjson", { err: e.message }));
      return;
    }
    const entries = (payload && (payload.mcpServers || payload.mcp_servers)) || {};
    const names = Object.keys(entries);
    if (!names.length) {
      setNotice("err", t("adm.import.noblock"));
      return;
    }
    let added = 0;
    const problems = [];
    for (const n of names) {
      try {
        await mcpCall("registry", "add_server", { name: n, spec: entries[n] });
        added++;
      } catch (e) { problems.push(`${n}: ${e.message}`); }
    }
    box.value = "";
    notice = {
      kind: problems.length ? "err" : "ok",
      text: t("adm.import.done", { added, total: names.length })
            + (problems.length ? " " + problems.join(" | ") : " " + t("adm.applied")),
    };
    renderNotice();
    await refresh();
  }

  // ─── Entry point (called by app.js on tab switch) ───────────────────────────

  async function loadAdmin() {
    const host = $("adm-detail");
    if (!host) return;
    if (loaded && sel) { renderDetail(); return; }   // a re-visit keeps the selection
    try {
      await refresh();
      loaded = true;
    } catch (e) {
      host.innerHTML = `<div class="st-card adm-card">
        <span class="card-title">${esc(t("adm.loadfailed"))}</span>
        <p class="muted">${esc(e.message)}</p></div>`;
    }
  }

  window.loadAdmin = loadAdmin;

  // This tab builds all of its own labels, so the static [data-i18n] pass is not enough —
  // repaint from the cached data (or re-run loadAdmin when there is nothing cached).
  document.addEventListener("strata:langchange", () => {
    const root = document.getElementById("view-tools");
    if (root) window.i18n.applyI18n(root);
    if (!loaded) loadAdmin();
    else { renderList(); renderDetail(); renderNotice(); }
  });

  if (document.getElementById("adm-detail")) {
    const wire = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    wire("adm-new-server", () => { notice = null; sel = { kind: "server", name: "", isNew: true }; renderList(); renderDetail(); renderNotice(); });
    wire("adm-new-skill", () => { notice = null; sel = { kind: "skill", name: "", isNew: true }; renderList(); renderDetail(); renderNotice(); });
    wire("adm-import-btn", importJson);
    if (location.hash.slice(1) === "tools") loadAdmin();
  }
})();
