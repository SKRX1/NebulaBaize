// serve/web/app.js - the Strata web app: Chat, Monitor, About. No framework, no network beyond this server.
// The Monitor tab rebuilds PR #22's dashboard idea (code-martin) on the server's own /metrics.
"use strict";

const $ = (id) => document.getElementById(id);
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
// i18n.js loads before this file in the normal case, so window.i18n is present. But if a
// stale cached index.html (one without the i18n.js tag) is paired with a newer app.js, or
// i18n.js fails to load for any reason, window.i18n can be undefined. Fall back to the key
// itself so a missing translation layer can NEVER crash the whole app (chat, saves, …).
const t = (key, params) => {
  if (window.i18n) return window.i18n.t(key, params);
  if (!params) return key;
  return key.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
};
const SPRITE = "web/sprite.svg";
const icon = (name, cls = "st-icon") => `<svg class="${cls}" aria-hidden="true"><use href="${SPRITE}#i-${name}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmt = (n, d = 0) => (n == null || Number.isNaN(n) ? "–" : Number(n).toLocaleString(undefined, {maximumFractionDigits: d, minimumFractionDigits: d}));
const kfmt = (n) => (n == null ? "–" : n >= 1000 ? `${fmt(n / 1000, n >= 10000 ? 0 : 1)}k` : fmt(n));
// a context size: 32768 -> "32K" (powers of two), else like kfmt
const ctxfmt = (n) => (n && n % 1024 === 0 ? `${fmt(n / 1024)}K` : kfmt(n));
// task duration -> "1分23秒" / "23秒" (the "几分几秒" the user asked for)
const fmtDur = (secs) => {
  if (secs == null) return "–";
  const s = Math.max(0, Math.round(secs));
  if (s < 1) return "1秒";
  const m = Math.floor(s / 60), r = s % 60;
  return m === 0 ? `${r}秒` : `${m}分${String(r).padStart(2, "0")}秒`;
};
// a one-decimal seconds readout for tooltips
const fmtDurLong = (secs) => {
  if (secs == null) return "–";
  const s = Math.max(0, secs), m = Math.floor(s / 60), r = s - m * 60;
  return `${m}分${r.toFixed(1)}秒`;
};
// live ticking clock while a turn streams: "M:SS"
const fmtClock = (ms) => {
  const s = Math.max(0, ms / 1000), m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const gb = (b, d = 1) => (b == null ? "–" : fmt(b / 1073741824, d));   // memory: binary GB, as Windows shows it

// Abort-aware delay for the network-retry backoff. Resolves after `ms`, or rejects with AbortError
// the instant the user hits Stop — so a pending retry aborts cleanly instead of firing.
function sleep(ms, signal) {
  return new Promise((res, rej) => {
    if (signal && signal.aborted) { rej(new DOMException("Aborted", "AbortError")); return; }
    const id = setTimeout(() => { cleanup(); res(); }, ms);
    const onAbort = () => { cleanup(); rej(new DOMException("Aborted", "AbortError")); };
    function cleanup() { clearTimeout(id); if (signal) signal.removeEventListener("abort", onAbort); }
    if (signal) signal.addEventListener("abort", onAbort, {once: true});
  });
}
// A client error (4xx) must never be retried; a typed error lets the retry loop bail out immediately.
class ClientError extends Error {}

// A dropped CONNECTION is not a failed REQUEST -- and the difference decides what the user sees.
// When the response body is cut mid-stream there is no HTTP status and no gateway error chunk to
// read: the browser itself rejects `reader.read()` with a TypeError whose text differs per engine
// ("network error" in Chrome/Edge, "NetworkError when attempting to fetch resource." in Firefox,
// "Load failed" in Safari). It used to be funnelled into `m.error`, i.e. the "fatal" bucket, which
// silently disabled BOTH recovery paths (markTruncatedIfCut skips a message that already has an
// error, and maybeAutoResume refuses to retry one) -- so a pure transport hiccup parked a red
// banner on a half-finished task and the user had to notice and press Continue by hand. A real
// upstream `{"error": ...}` chunk is thrown as a plain Error and stays fatal: retrying that would
// only repeat the failure.
const TRANSPORT_RE = /network\s*error|failed to fetch|networkerror|load failed|connection (was )?(reset|aborted|lost|closed|refused)|err_connection|err_network|err_internet|econn(reset|aborted|refused)|epipe|socket hang up|internet connection appears to be offline|unexpected end of/i;
function isTransportError(e) {
  if (!e || e.name === "AbortError" || e instanceof ClientError) return false;   // Stop / 4xx are not transport
  if (e instanceof TypeError) return true;      // only fetch() and the body stream reject with TypeError
  return TRANSPORT_RE.test(String(e.message || e));
}

// POST to the chat endpoint with exponential backoff. Retries ONLY transient failures: network
// errors and 5xx / 429. Does NOT retry on 4xx (e.g. 401/403/404) or on abort (user Stop).
async function fetchWithRetry(url, init, {retries = 3, base = 800} = {}) {
  let attempt = 0;
  for (;;) {
    attempt++;
    if (init.signal && init.signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      if (r.status >= 400 && r.status < 500 && r.status !== 429) {     // client error: not transient
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error.message || msg; } catch (e) {}
        if (r.status === 401) msg = t("toast.keyneeded.msg");
        throw new ClientError(msg);
      }
      if (attempt > retries) { let msg = `HTTP ${r.status}`; try { msg = (await r.json()).error.message || msg; } catch (e) {} throw new Error(msg); }
    } catch (e) {
      if (e.name === "AbortError" || e instanceof ClientError) throw e; // no retry
      if (attempt > retries) throw e;
    }
    const wait = Math.min(8000, base * 2 ** (attempt - 1)) + Math.random() * 250;   // 0.8s → 1.6s → 3.2s, capped
    toast("warn", t("toast.retry.title"), t("toast.retry.msg", {n: attempt, max: retries, s: Math.round(wait / 1000)}), 4000);
    await sleep(wait, init.signal);
  }
}

const store = {
  get(k, d) { try { const v = localStorage.getItem("strata." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) {
    try {
      localStorage.setItem("strata." + k, JSON.stringify(v));
      return true;
    } catch (e) {
      // Swallowing every error hid the worst one: once the ~5 MB quota is reached
      // (two pasted images are enough) every later save failed silently, so the chat
      // was gone on reload with no warning. Private mode stays quiet; quota does not.
      const quota = e && (e.name === "QuotaExceededError" || e.code === 22 || e.code === 1014);
      if (quota && !store._quotaWarned) {
        store._quotaWarned = true;
        toast("error", t("toast.storage.full.title"), t("toast.storage.full.msg"), 12000);
      }
      return false;
    }
  },
};

// ------------------------------------------------------------------ toasts
function toast(kind, title, text = "", ms = 3500, action = null) {
  const names = {info: "info", success: "check", warn: "warning", error: "error"};
  const el = document.createElement("div");
  el.className = `st-toast st-toast--${kind}`;
  el.innerHTML = `${icon(names[kind] || "info")}<div><div class="st-toast__title"></div><div class="t-text"></div></div>`;
  el.querySelector(".st-toast__title").textContent = title;
  el.querySelector(".t-text").textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.className = "st-btn st-btn--secondary";
    b.style.height = "32px";
    b.style.marginLeft = "auto";
    b.textContent = action.label;
    b.onclick = () => { action.run(); el.remove(); };
    el.appendChild(b);
  }
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {                                   // http on another host: no async clipboard
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
  }
  if (btn) {
    const use = btn.querySelector("use");
    use.setAttribute("href", `${SPRITE}#i-check`);
    setTimeout(() => use.setAttribute("href", `${SPRITE}#i-copy`), 1500);
  }
  toast("success", t("toast.copied.title"), "", 1800);
}

// ------------------------------------------------------------------ theme and tabs
// dark is the app default; the user's click is the only thing that gets saved
// (a saved choice always wins — otherwise the app stays dark regardless of the OS,
// which is why the old "follow prefers-color-scheme when nothing is saved" listener
// was removed: it would flip dark-default users back to light on a light-themed OS)
// NOTE: the parameter is `theme`, not `t` — `t` is the i18n helper defined at the
// top of this file, and shadowing it here would silently break any translation added later.
function setTheme(theme, save) {
  document.documentElement.dataset.theme = theme;
  if (save) try { localStorage.setItem("strata.theme", theme); } catch (e) { /* ignore */ }
  $("theme-icon").setAttribute("href", `${SPRITE}#i-${theme === "dark" ? "sun" : "moon"}`);
  $("dark-toggle").setAttribute("aria-checked", String(theme === "dark"));
}
const flipTheme = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
$("theme-btn").onclick = flipTheme;
$("dark-toggle").onclick = flipTheme;
setTheme(document.documentElement.dataset.theme || "dark", false);

let tab = "chat";
let inspectorOpen = store.get("inspector.open", true);   // declared early: applyInspector() runs before this line's original spot
function showTab(name) {
  tab = ["chat", "images", "monitor", "tools", "about", "memory", "spark", "debug"].includes(name) ? name : "chat";
  // the left sidebar (task list) shows on chat / spark / debug; every other tab lets
  // the view take the full width. The class is added for the full-width tabs (never
  // removed by default), so a JS-less first paint still shows the sidebar — fail
  // visible, not hidden. `#rh-left` (the sidebar's resize handle) is bound to the same
  // class in CSS:630 on purpose — a visible sidebar should ship with its resize handle.
  document.body.classList.toggle("no-sidebar", tab !== "chat" && tab !== "spark" && tab !== "debug");
  for (const b of document.querySelectorAll(".st-tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const v of ["chat", "images", "monitor", "tools", "about", "memory", "spark", "debug"]) $(`view-${v}`).hidden = v !== tab;
  if (tab === "images") $("img-prompt").focus();
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", tab === "chat" ? location.pathname : `#${tab}`);
  if (tab === "chat") $("input").focus();
  if (tab === "monitor") loadMcp();
  if (tab === "tools" && typeof loadAdmin === "function") loadAdmin();
  if (tab === "about") { loadConfig(); loadRuntimeConfig(); loadInterruptLog(); }
  if (tab === "memory") { renderMemory(); applyMemSubTab(); }
  if (tab === "debug") { renderDebug(); renderGatewayDebug(); renderBugBox(); renderRecycle(); applyDebugSubTab(); }
  if (tab === "spark") renderSpark();
  if (lastMetrics) render(lastMetrics);
  applyInspector();
  if (tab === "chat" || tab === "spark") renderInspector();
}
for (const b of document.querySelectorAll(".st-tab")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

// ------------------------------------------------------------------ server access
function headers(json = false) {
  const h = {};
  const key = store.get("apikey", "");
  if (key) h.Authorization = "Bearer " + key;
  if (json) h["Content-Type"] = "application/json";
  return h;
}
$("api-key").value = store.get("apikey", "");
$("api-key").onchange = () => { store.set("apikey", $("api-key").value.trim()); toast("success", t("toast.keysaved.title"), t("toast.keysaved.msg")); };

// ------------------------------------------------------------------ the one MCP tool channel
// POST /mcp/call is same-origin in BOTH modes (the host serves it in parasitic mode;
// the gateway proxies it in standalone mode). Its contract, measured live:
//     {"server": ..., "tool": ..., "ok": true, "text": "<the tool's payload>", ...}
// The payload rides inside `text` — the response body is NOT the MCP result. Every
// consumer goes through mcpCall(); code that reads `content[0].text` or awaits
// r.text() gets the envelope and silently breaks (that bug shipped once already).
// `text` is JSON-parsed when it can be, else returned as {text: ...}.
async function mcpCall(server, tool, args) {
  const _tk = nebTaskFromTool(tool);
  if (_tk) setNebTask(_tk);          // 跑工具时让星云亮出对应任务的表情/道具
  const r = await fetch("mcp/call", {method: "POST", headers: headers(true),
    body: JSON.stringify({server, tool, args: args || {}})});
  let d = {};
  try { d = await r.json(); } catch (e) { /* an HTML error page: reported below */ }
  if (!r.ok) throw new Error((d.error && d.error.message) || `HTTP ${r.status}`);
  if (!d.ok) throw new Error(String(d.text || t("mcp.err.toolcall")).replace(/^error:\s*/, ""));
  const s = String(d.text == null ? "" : d.text).trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch (e) { return {text: s}; }
}
// The raw text of a tool result, for tools that answer in plain lines rather than JSON.
async function mcpText(server, tool, args) {
  const d = await mcpCall(server, tool, args);
  return typeof d === "string" ? d : (d.text || "");
}

let health = {model: "strata", images: false, max_context: 0};
async function loadHealth() {
  try {
    health = await (await fetch("health")).json();
    $("attach-btn").title = health.images ? t("chat.attach.images") : t("chat.attach");
    $("chat-empty-sub").textContent = t("chat.empty.sub.model", {model: health.model});
    $("tab-btn-images").hidden = !health.image_generation;
    if (location.hash === "#images" && health.image_generation) showTab("images");
  } catch (e) {
    setTimeout(loadHealth, 2000);
  }
}

// ------------------------------------------------------------------ Monitor
/* Labels are resolved through t() at render time (not captured into the array at
 * load) so switching language repaints them without rebuilding this list. */
const METRICS = [
  {key: "speed", i18n: "metric.speed", icon: "gauge", unit: "t/s", series: "tok_s"},
  {key: "gpu", i18n: "metric.gpu", icon: "gpu", unit: "%", series: "gpu_util", max: 100},
  {key: "vram", i18n: "metric.vram", icon: "layers", unit: "GB", series: "gpu_mem_used"},
  {key: "temp", i18n: "metric.temp", icon: "thermometer", unit: "°C", series: "gpu_temp", tone: "warn"},
  {key: "power", i18n: "metric.power", icon: "bolt", unit: "W", series: "gpu_power"},
  {key: "pcie", i18n: "metric.pcie", icon: "link", unit: "", series: "gpu_pcie_rx_mb", tone: "info"},
  {key: "cpu", i18n: "metric.cpu", icon: "cpu", unit: "%", series: "cpu", max: 100},
  {key: "disk", i18n: "metric.disk", icon: "disk", unit: "MB/s", series: "disk_read_mb", tone: "info"},
];
$("metrics").innerHTML = METRICS.map((m) => `
  <div class="st-card metric-card"><div class="st-metric">
    <span class="st-metric__label">${icon(m.icon, "st-icon st-icon--sm")}${esc(t(m.i18n))}</span>
    ${m.key === "speed" ? `<div class="speed-values">
      <div><span class="st-metric__value" id="mv-speed">-</span><span class="st-metric__sub" id="ms-speed">${esc(t("mon.btn.decode"))}</span></div>
      <div class="speed-prefill"><span class="st-metric__value" id="mv-prefill">-</span><span class="st-metric__sub" id="ms-prefill">${esc(t("mon.btn.prefill"))}</span></div>
    </div>` : `<span class="st-metric__value" id="mv-${m.key}">–</span>
    <span class="st-metric__sub" id="ms-${m.key}"></span>`}
    <svg class="st-metric__spark" id="sp-${m.key}" viewBox="0 0 100 32" preserveAspectRatio="none"${m.tone ? ` data-tone="${m.tone}"` : ""}>
      <path class="area" fill="currentColor" opacity=".12"/><path class="line" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      ${m.key === "speed" ? `<g id="sp-prefill" class="speed-prefill"><path class="area" fill="currentColor" opacity=".12"/>
        <path class="line" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
        stroke-linecap="round" vector-effect="non-scaling-stroke"/></g>` : ""}</svg>
  </div></div>`).join("");

function spark(id, values, max) {
  const svg = $(id);
  const v = (values || []).map((x) => (x == null ? 0 : x));
  if (v.length < 2) { svg.querySelector(".line").setAttribute("d", ""); svg.querySelector(".area").setAttribute("d", ""); return; }
  const top = Math.max(max || 0, ...v, 1);
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 30 - (x / top) * 26]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("");
  svg.querySelector(".line").setAttribute("d", line);
  svg.querySelector(".area").setAttribute("d", `${line}L100,32L0,32Z`);
}
function setMetric(key, value, unit, sub) {
  $(`mv-${key}`).innerHTML = value == null ? "–" : `${esc(value)}${unit ? `<small>${esc(unit)}</small>` : ""}`;
  $(`ms-${key}`).textContent = sub || "";
}

let lastMetrics = null, metricsFailures = 0, keyWarned = false, mcpTick = 0; let monTick = 0, engineMonitor = null;
let reqShowAll = false;   // the Monitor's request table: the last 12, or every one the server keeps (issue #35)
// 方案A 真多态共享 helper（2026-11）：当前模型是 custom 且在线时，按客户端 streamAssistant
// 已知的 m._phase 走四态（CSS 支持 reading/generating/tool）；思考中借用 reading 视觉态配独立文案。
// render() 成功分支顶部与 poll catch 兜底分支都调用本 helper（单一来源），命中返回 true。
function paintCustomPill() {
  const sel = currentModel();
  if (!(sel && sel.kind === "custom" && modelOnline(sel) === true)) return false;
  const cm = busy && busy.msg;
  const p = cm ? cm._phase : null;
  const tk = cm ? cm._liveTokS : null;
  if (busy && p === "reading") {
    setPill("reading", t("mon.state.reading"), true);
  } else if (busy && p === "thinking") {
    setPill("reading", tk != null ? `${t("mon.state.thinking")} · ${fmt(tk, 1)} tok/s` : t("mon.state.thinking"), true);
    if (tk != null) setNebSpin(tk);
  } else if (busy && p === "answering") {
    setPill("generating", tk != null ? `${t("mon.state.generating")} · ${fmt(tk, 1)} tok/s` : t("mon.state.generating"), true);
    if (tk != null) setNebSpin(tk);
  } else if (busy && p === "tool") {
    setPill("tool", tk != null ? `${t("tool.state.running")} · ${fmt(tk, 1)} tok/s` : t("tool.state.running"), true);
    if (tk != null) setNebSpin(tk);
  } else {
    setPill("idle", busy ? t("mon.state.working") : t("mon.pill.endpoint.idle"), !!busy);
  }
  return true;
}

// Engine-side context pool (shared KV, real n_ctx) for the selected custom endpoint, proxied
// by the gateway at /api/monitor. Polled every 5 s: it is a coarse capacity signal, not a
// per-token fill, so a slower cadence than the 1 s metrics poll is enough.
async function pollEngineMonitor() {
  try {
    const r = await fetch("api/monitor", {headers: headers()});
    if (r.ok) { engineMonitor = await r.json(); if (tab === "chat" || tab === "spark") renderInspector(); }
  } catch (e) { /* best-effort: a missing/legacy endpoint keeps the chip hidden */ }
}
async function poll() {
  try {
    const r = await fetch(reqShowAll ? "metrics?requests=all" : "metrics", {headers: headers()});
    if (r.status === 401) {
      setPill("error", "API key needed");
      if (!keyWarned) { keyWarned = true; toast("warn", t("toast.keyneeded.title"), t("toast.keyneeded.msg"), 6000); }
    } else if (r.ok) {
      lastMetrics = await r.json();
      metricsFailures = 0;
      render(lastMetrics);
    } else {
      throw new Error(`HTTP ${r.status}`);
    }
  } catch (e) {
    // The health poll measures the DEFAULT upstream (the 8080 engine). When a CUSTOM model is
    // selected, its own endpoint liveness — the same one the switcher dot uses — is what decides
    // whether a message can actually reach it, so the top pill follows the selection instead of
    // blaming a dead default upstream the message never goes through (2026-10-31).
    if (paintCustomPill()) {
      metricsFailures = 0;
    } else if (++metricsFailures === 3) setPill("error", t("mon.pill.serverdown"));
  }
  if (tab === "monitor" && ++mcpTick % 10 === 0) loadMcp();       // server states change rarely: every 10 s
  if (++monTick % 5 === 0) pollEngineMonitor();   // engine pool: every 5 s
  setTimeout(poll, 1000);
}

// `working` = a turn of ours is in flight. It matters because the engine's own metric reads "idle"
// whenever it is between requests (a tool call executing, the prompt being assembled) — the green dot
// used to go quiet exactly then, so a slow tool looked like a dead agent. The mark keeps orbiting,
// just slower, instead.
function setPill(state, text, working) {
  // Closeout alignment: when a turn just finished cleanly (bumpNebDone window), show the pill as
  // done/idle NOW instead of waiting for the next 1 s poll frame to carry live.state off "generating".
  if (!working && Date.now() < nebDoneUntil) { state = "done"; text = t("mon.state.idle"); }   // 文字与图标同步翻完成/空闲
  $("pill").dataset.state = state === "error" ? "queued" : state;
  $("pill-text").textContent = text;
  const neb = $("pill-neb");
  if (!neb) return;
  const shown = state === "error" ? "queued" : state;
  let mark = working && shown === "idle" ? "tool" : shown;
  if (Date.now() < nebDoneUntil) mark = "done";                 // 回合刚收尾：先庆祝一下
  // 工具正在跑时（回合还活着、引擎在等工具 = mark "tool"），叠加该任务的表情/形态
  const taskActive = mark === "tool" && Date.now() < nebTaskUntil;
  const task = taskActive ? nebTaskKind : "";
  if (neb.dataset.task !== task) neb.dataset.task = task;
  if (neb.dataset.state !== mark) neb.dataset.state = mark;
  if (mark !== "generating") neb.style.removeProperty("--neb-spin");   // back to the state's own tempo
}

// Orbit tempo tracks measured throughput: ~5.2 s a lap at a crawl, ~2.6 s when she is writing fast.
// Clamped at 160 tok/s (was 40) so real readings (~51 end-to-end, ~81 engine-peak)
function setNebSpin(tokS) {
  const neb = $("pill-neb");
  if (!neb) return;
  const v = Math.max(0, Math.min(160, Number(tokS) || 0));
  neb.style.setProperty("--neb-spin", (5.2 - (v / 160) * 2.6).toFixed(2) + "s");
}

// Turn-level real throughput accumulator (single source, shared by all four states). Times from
// the first token; reasoning AND content chunks both feed the numerator, so thinking/generating/
// tool read off the same real speed curve. Below a 250 ms window it returns null (kills the
// first-frame Infinity and noise); once valid it caches on m._liveTokS, and a tool round with no
// new token shows the frozen-but-real last cumulative value.
function bumpLiveSpeed(m, dtok) {
  const now = performance.now();
  if (m._speedStartMs == null) { m._speedStartMs = now; m._speedTokens = dtok; }
  else { m._speedTokens += dtok; }
  const elapsed = (now - m._speedStartMs) / 1000;
  if (elapsed < 0.25) return null;
  m._liveTokS = m._speedTokens / elapsed;
  return m._liveTokS;
}

// 星云酱的「表情/形态」扩展：工具运行时亮出对应任务的表情；回合收尾闪一下「完成」。
let nebTaskKind = null, nebTaskUntil = 0, nebDoneUntil = 0;
function setNebTask(kind) {                       // 由 mcpCall 调用，4.5s 内有效
  if (!kind) return;
  nebTaskKind = kind; nebTaskUntil = Date.now() + 4500;
}
function bumpNebDone() { nebDoneUntil = Date.now() + 1300; }   // 回合正常收尾的瞬时庆祝
function nebTaskFromTool(tool) {
  const n = String(tool || "").toLowerCase();
  if (/search|web|fetch|http|browser|nav|wiki|google|duck|bing|url/.test(n)) return "search";
  if (/code|edit|write|patch|sed|diff|format|create|fs_write|fs_edit|file_write|refactor/.test(n)) return "code";
  if (/shell|exec|run|terminal|bash|cmd|powershell|python|node|command/.test(n)) return "shell";
  if (/image|img|draw|paint|generate|diffus|sdxl|dalle|art|photo/.test(n)) return "image";
  if (/read|open|cat|get|load|view|fetch_file/.test(n)) return "read";
  return null;
}

function render(m) {
  const live = m.live || {}, hw = m.hardware || {}, st = m.hardware_static || {}, eng = m.engine || {}, h = m.history || {};
  const last = (m.requests || [])[0];
  // the header pill
  if (!paintCustomPill()) {   // custom 在线时优先走客户端已知四态，否则落回 native live.state 原逻辑
  if (live.state === "reading") {
    const pct = live.prompt_total ? Math.round((100 * live.prompt_read) / live.prompt_total) : null;
    setPill("reading", pct != null ? `${t("mon.state.reading")} · ${pct}%` : t("mon.state.reading"), !!busy);
  } else if (live.state === "generating") {
    setPill("generating", `${t("mon.state.generating")} · ${fmt(live.tok_s, 1)} tok/s`, !!busy);
    setNebSpin(live.tok_s);
  } else {
    // The engine sits at "idle" whenever it is between requests — a tool is running, the prompt is
    // being assembled, or our request has not landed yet. Calling that "空闲" next to a spinning
    // nebula reads like a lie, so say what is actually true: the turn is still executing.
    setPill("idle", busy ? t("mon.state.working") : t("mon.state.idle"), !!busy);
  }
  if (live.queued > 0) setPill("queued", `${live.queued} ${t("mon.state.queued")}`, !!busy);
  }
  if (tab === "monitor") renderMonitor(live, hw, st, eng, h, last, m.requests || [], m.totals, m.requests_kept);
  if (tab === "monitor") renderConvCache(m.conversation_cache);
  if (tab === "about") renderAbout(eng, hw, st);
  maxCtx = eng.max_context || maxCtx;          // R5: context window for the inspector fill bar
  const _selW = currentModel(); const _declW = _selW ? (+( _selW.context_window || 0) || +( _selW.native_ctx || 0)) : 0; if (_declW > 0) maxCtx = _declW;
  // Live context occupancy: while a turn runs the engine reports the prompt length it is reading (and re-reads
  // an even bigger prompt after every tool round). Reading it here makes the fill bar climb during the task
  // instead of jumping once, at the end, when the turn's final `usage` chunk arrives.
  const _lp = live.prompt_tokens;
  if (busy && _lp) lastPromptTokens = _lp;
  if (tab === "chat" || tab === "spark") renderInspector();
}

// #596: the conversation cache - the prompt's state the engine keeps between requests (always), and the whole
// conversations it parks in RAM when "--conversation-cache-mib N" is in the run config's args (opt-in)
function since(t) {
  if (!t) return "";
  const s = Math.max(0, Date.now() / 1000 - t);
  return s < 60 ? "just now" : s < 3600 ? `${fmt(s / 60)} min ago` : `${fmt(s / 3600, 1)} h ago`;
}
function renderConvCache(c) {
  $("cc-card").hidden = !c;
  if (!c) return;                                  // an older server
  const pct = (a, b) => (b ? `${Math.min(100, (100 * a) / b)}%` : "0%");
  $("cc-bars").hidden = !c.enabled;
  if (c.enabled) {
    $("cc-slots-text").textContent = `${fmt(c.parked)} / ${fmt(c.slots)}`;
    $("cc-slots-bar").style.width = pct(c.parked, c.slots);
    const budget = c.budget_mib * 1048576;
    $("cc-mem-text").textContent = `${gb(c.bytes)} / ${gb(budget)} GB`;
    $("cc-mem-bar").style.width = pct(c.bytes, budget);
  }
  $("cc-sum").textContent = c.requests ? t("mon.cc.sum", {reused: fmt(c.requests_reused), requests: fmt(c.requests)}) : "";
  const share = c.prompt_tokens ? t("mon.cc.share", {pct: fmt((100 * c.reused_tokens) / c.prompt_tokens)}) : "";
  const event = c.last_event ? `${c.last_event === "parked" ? t("mon.cc.event.parked") : t("mon.cc.event.restored")} ${fmt(c.last_tokens)} tokens, ${since(c.last_at)}` : null;
  facts($("cc-facts"), [
    [t("mon.cc.facts.lastreq"), c.last_prompt != null ? `${fmt(c.last_reused || 0)} of ${fmt(c.last_prompt)} prompt tokens reused` : null],
    [t("mon.cc.facts.reused"), c.requests ? `${fmt(c.reused_tokens)} tokens${share}` : null],
    [t("mon.cc.facts.parked"), c.enabled ? `${fmt(c.parks)} / ${fmt(c.restores)}${c.evictions ? ` · ${fmt(c.evictions)} evicted` : ""}` : null],
    [t("mon.cc.facts.lastswitch"), c.enabled ? event : null],
  ]);
  $("cc-note").textContent = c.enabled
    ? t("mon.cc.note.on")
    : t("mon.cc.note.off");
}

function renderTotals(t) {
  if (!t || !t.requests) return "";
  const since = new Date(t.since * 1000).toLocaleString([], {weekday: "short", hour: "2-digit", minute: "2-digit"});
  const read = t.prompt_tokens - t.reused;
  const pSpeed = t.prompt_ms > 0 && read > 0 ? ` at ${fmt(read / (t.prompt_ms / 1000))} tok/s` : "";
  const oSpeed = t.decode_ms > 0 && t.output_tokens > 0 ? ` at ${fmt(t.output_tokens / (t.decode_ms / 1000), 1)} tok/s` : "";
  return `Since ${since}: ${fmt(t.requests)} requests · ${fmt(read)} prompt tokens read${pSpeed} (${fmt(t.reused)} reused) · ` +
         `${fmt(t.output_tokens)} written${oSpeed}`;
}
function renderMonitor(live, hw, st, eng, h, last, requests, totals, kept) {
  // model state
  const on = live.queued > 0 ? "queued" : live.state;
  for (const b of document.querySelectorAll("#state-badges .st-badge")) b.classList.toggle("on", b.dataset.s === on || b.dataset.s === live.state);
  const prog = $("state-progress");
  let label = t("mon.state.waiting"), detail = "", pct = 0;
  if (live.state === "reading") {
    label = t("mon.state.reading");
    prog.dataset.tone = "info";
    if (live.prompt_total) {
      pct = (100 * live.prompt_read) / live.prompt_total;
      detail = `${fmt(live.prompt_read)} / ${fmt(live.prompt_total)} tokens · ${fmt(pct)}%`;
    } else {
      detail = `${fmt(live.prompt_tokens)} tokens`;
    }
  } else if (live.state === "generating") {
    label = live.phase ? live.phase[0].toUpperCase() + live.phase.slice(1) : t("mon.state.generating");
    delete prog.dataset.tone;
    pct = live.max_tokens ? Math.min(100, (100 * live.generated) / live.max_tokens) : 0;
    detail = `${fmt(live.generated)} tokens · ${fmt(live.tok_s, 1)} tok/s`;
  } else if (last) {
    delete prog.dataset.tone;
    detail = `${t("mon.detail.last")}${fmt(last.output_tokens)} tokens${last.decode_tok_s ? ` at ${fmt(last.decode_tok_s, 1)} tok/s` : ""}`;
  }
  $("state-label").textContent = label;
  $("state-detail").textContent = detail;
  $("state-bar").style.width = `${pct}%`;

  // the eight cards
  const speed = live.state === "generating" ? live.tok_s : last ? last.decode_tok_s : null;
  setMetric("speed", speed == null ? null : fmt(speed, 1), "t/s",
            live.state === "generating" ? t("mon.btn.decode.now") : last ? t("mon.btn.decode.last") : t("mon.btn.decode"));
  const prefill = live.state !== "idle" ? live.prefill_tok_s_mean
                : last && last.prompt_ms > 0 ? Math.max(0, last.prompt_tokens - (last.reused || 0)) / (last.prompt_ms / 1000) : null;
  setMetric("prefill", prefill == null ? null : fmt(prefill), "t/s",
            live.state === "reading" ? t("mon.btn.prefill.now") : live.state === "generating" ? t("mon.btn.prefill.this") : last ? t("mon.btn.prefill.last") : t("mon.btn.prefill"));
  spark("sp-speed", h.tok_s);
  spark("sp-prefill", h.prefill_tok_s_mean);
  // a model split across several cards (issue #112): the cards show their total / mean / hottest, and each card's own
  const per = (f) => (hw.gpus || []).map((g) => `GPU ${g.index} ${f(g)}`).join(" · ");
  const multi = (hw.gpus || []).length > 1;
  setMetric("gpu", hw.gpu_util == null ? null : fmt(hw.gpu_util), "%",
            multi ? per((g) => (g.util == null ? "–" : `${fmt(g.util)}%`)) : st.gpu_name || (st.gpu_note ? t("mon.fact.gpu.na") : ""));
  spark("sp-gpu", h.gpu_util, 100);
  setMetric("vram", hw.gpu_mem_used == null ? null : gb(hw.gpu_mem_used), hw.gpu_mem_total ? `/ ${gb(hw.gpu_mem_total, 0)} GB` : "GB",
            multi ? per((g) => (g.mem_used == null ? "–" : `${gb(g.mem_used)} GB`))
                  : eng.expert_slots ? t("mon.fact.experts.cached", {n: fmt(eng.expert_slots)}) : (st.gpu_note ? t("mon.fact.gpu.na.amd") : ""));
  spark("sp-vram", h.gpu_mem_used, hw.gpu_mem_total);
  setMetric("temp", hw.gpu_temp == null ? null : fmt(hw.gpu_temp), "°C",
            multi ? per((g) => (g.temp == null ? "–" : `${fmt(g.temp)}°`)) : "");
  spark("sp-temp", h.gpu_temp, 90);
  setMetric("power", hw.gpu_power == null ? null : fmt(hw.gpu_power), "W", hw.gpu_power_limit ? t("mon.fact.gpu.powerlimit", {n: fmt(hw.gpu_power_limit)}) : "");
  spark("sp-power", h.gpu_power, hw.gpu_power_limit);
  const gen = hw.gpu_pcie_gen_max || hw.gpu_pcie_gen;
  setMetric("pcie", gen ? `Gen${gen}` : null, hw.gpu_pcie_width ? `x${hw.gpu_pcie_width}` : "",
            hw.gpu_pcie_rx_mb == null ? "" : `${t("mon.fact.pcie.to", {n: fmt(hw.gpu_pcie_rx_mb, hw.gpu_pcie_rx_mb < 10 ? 1 : 0)})} MB/s` +
            (hw.gpu_pcie_gen && gen && hw.gpu_pcie_gen < gen ? ` · idle Gen${hw.gpu_pcie_gen}` : ""));
  spark("sp-pcie", h.gpu_pcie_rx_mb);
  setMetric("cpu", hw.cpu == null ? null : fmt(hw.cpu), "%", st.threads ? `${st.cores ? `${st.cores} cores · ` : ""}${st.threads} threads` : "");
  spark("sp-cpu", h.cpu, 100);
  if (hw.disk_read_mb == null) {
    setMetric("disk", null, "", st.psutil ? "" : t("mon.fact.psutil"));
  } else {
    const big = hw.disk_read_mb >= 1000;
    setMetric("disk", big ? fmt(hw.disk_read_mb / 1024, 2) : fmt(hw.disk_read_mb, hw.disk_read_mb < 10 ? 1 : 0), big ? "GB/s" : "MB/s",
              hw.disk_write_mb == null ? "" : `write ${fmt(hw.disk_write_mb, 1)} MB/s`);
  }
  spark("sp-disk", h.disk_read_mb);

  // context fill: the running request, else the last one
  const ctx = eng.max_context || 0;
  let used = 0;
  if (live.state !== "idle") used = (live.prompt_tokens || 0) + (live.generated || 0);
  else if (last) used = (last.prompt_tokens || 0) + (last.output_tokens || 0);
  const frac = ctx ? Math.min(1, used / ctx) : 0;
  $("ctx-fill").setAttribute("stroke-dasharray", `${(235.6 * frac).toFixed(1)} 314.2`);
  $("ctx-fill").style.opacity = 235.6 * frac >= 3 ? "1" : "0";         // a near-zero arc would draw just its round cap
  $("ctx-pct").textContent = `${Math.round(frac * 100)}%`;
  $("ctx-sub").textContent = ctx ? `${kfmt(used)} / ${ctxfmt(ctx)}` : "–";
  const cacheBytes = (eng.expert_cache_mib || 0) * 1048576;
  const _sl = $("slots-text");
  if (eng.expert_slots) { _sl.textContent = `${fmt(eng.expert_slots)} · ${gb(cacheBytes)} GB`; delete _sl.title; }
  else { _sl.textContent = "–"; _sl.title = t("mon.fact.experts.api_na"); }
  $("slots-bar").style.width = hw.gpu_mem_total ? `${Math.min(100, (100 * cacheBytes) / hw.gpu_mem_total)}%` : "0%";
  $("ram-text").textContent = hw.ram_total ? `${gb(hw.ram_used)} / ${gb(hw.ram_total, 0)} GB` : "–";
  const ramPct = hw.ram_total ? (100 * hw.ram_used) / hw.ram_total : 0;
  $("ram-bar").style.width = `${ramPct}%`;
  if (ramPct > 92) $("ram-progress").dataset.tone = "danger"; else delete $("ram-progress").dataset.tone;
  $("temp-text").textContent = hw.gpu_temp == null ? "–" : `${fmt(hw.gpu_temp)} °C`;
  $("temp-bar").style.width = hw.gpu_temp == null ? "0%" : `${Math.min(100, hw.gpu_temp)}%`;

  // recent requests
  const body = $("req-body");
  if (!requests.length) {
    body.innerHTML = `<tr><td colspan="9" class="muted">${esc(t("mon.req.none"))}</td></tr>`;
  } else {
    const badge = {stop: ["", t("req.finish.done")], length: ["", t("req.finish.max")], cancel: ["st-badge--queued", t("stat.stopped")],
                   disconnect: ["st-badge--queued", t("req.finish.closed")], error: ["st-badge--error", t("mon.state.error")]};
    body.innerHTML = requests.slice(0, reqShowAll ? requests.length : 12).map((r) => {
      const [cls, text] = badge[r.finish] || ["", r.finish || "–"];
      // NB: the local is `ts`, not `t` — `t` is the i18n helper at the top of this
      // file, and shadowing it here made every t(...) below throw "t is not a
      // function", which blanked the whole Monitor request table (#588 era bug).
      const ts = new Date(r.time * 1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit", second: "2-digit"});
      const proj = r.projection == null ? "" : ` <span class="st-badge${r.projection ? " st-badge--reading" : ""}" title="${esc(t(r.projection ? "req.proj.tip.on" : "req.proj.tip.off"))}">${r.projection ? "ESP" : esc(t("mon.req.proj.stock"))}</span>`;
      // #588: the VRAM share; the PCIe share (--pcie-frac) beside it when there is one
      const hit = r.hit_rate == null ? "–" : `${(r.hit_rate * 100).toFixed(1)}%` +
        (r.pcie_share ? ` <span class="muted" title="${esc(t("req.pcie.tip"))}">+${(r.pcie_share * 100).toFixed(1)}% PCIe</span>` : "");
      // Reused tokens are not prefetched again. Match the Monitor's existing Prefill metric.
      const fresh = r.prompt_tokens == null ? null : Math.max(0, r.prompt_tokens - (r.reused || 0));
      const prefillRate = fresh > 0 && r.prompt_ms > 0 ? fresh / (r.prompt_ms / 1000) : null;
      return `<tr><td>${esc(ts)}</td><td><span class="st-badge ${cls}">${esc(text)}</span>${proj}</td><td class="num">${fmt(r.prompt_tokens)}</td>
        <td class="num">${fmt(r.reused)}</td><td class="num">${fmt(r.output_tokens)}</td><td class="num">${fmt(prefillRate)}</td><td class="num"${r.est ? ` title="${esc(t("mon.fact.decode_est"))}"` : ""}>${r.decode_tok_s == null ? "–" : (r.est ? `≈${fmt(r.decode_tok_s, 1)}` : fmt(r.decode_tok_s, 1))}</td>
        <td class="num">${hit}</td><td class="num">${fmt(r.duration_s, 1)} s</td></tr>`;
    }).join("");
  }
  const all = $("req-all");
  kept = kept == null ? requests.length : kept;
  all.hidden = kept <= 12;
  all.textContent = reqShowAll ? t("mon.req.fewer") : t("mon.req.all_n", {n: kept});
  $("req-wrap").classList.toggle("all", reqShowAll);
  $("req-totals").textContent = renderTotals(totals);
}

function facts(el, rows) {
  el.innerHTML = rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v, copy]) =>
    `<dt>${esc(k)}</dt><dd>${copy ? `<code>${esc(v)}</code><button class="st-btn st-btn--icon" data-copy="${esc(v)}" aria-label="${esc(t("ctx.copy"))}">${icon("copy")}</button>` : esc(v)}</dd>`).join("");
}
// INFO cvec=project:4-44[:singleL] | add:A-B | 0
function projectionText(c) {
  if (!c || c === "0" || c === 0) return null;
  const [mode, range, single] = String(c).split(":");
  const [a, b] = (range || "").split("-");
  const modeTxt = mode === "project" ? t("mon.fact.proj.mode.project") : t("mon.fact.proj.mode.additive");
  const singleTxt = single ? t("mon.fact.proj.single", {n: single.replace("single", "")}) : "";
  return t("mon.fact.proj.desc", {mode: modeTxt, a, b, single: singleTxt});
}
function renderAbout(eng, hw, st) {
  const kv = {int8: "8-bit", q4_0: "4-bit (Hadamard-rotated)", fp16: "16-bit"}[eng.kv] || eng.kv;
  facts($("facts-engine"), [
    [t("mon.fact.model"), eng.model],
    [t("mon.fact.engine"), eng.version ? `v${eng.version}` : t("mon.fact.builtfromsrc")],
    [t("mon.fact.context"), eng.max_context ? `${fmt(eng.max_context)} tokens` : null],
    [t("mon.fact.kvcache"), kv ? `${kv}${eng.kv_resident ? t("mon.fact.kv.streamed", {n: fmt(eng.kv_resident)}) : t("mon.fact.kv.allvram")}` : null],
    [t("mon.fact.experts"), eng.expert_slots ? `${fmt(eng.expert_slots)} (${gb((eng.expert_cache_mib || 0) * 1048576)} GB)` : null],
    [t("mon.spec.title"), eng.spec ? `${t("mon.spec.mtp", {n: Math.max(0, (eng.mtp_max || eng.spec) - 1)})}${eng.lookup ? t("mon.spec.lookup") : ""}` : null],
    [t("mon.fact.images"), eng.images ? t("mon.fact.on") : t("mon.fact.off")],
    [t("mon.fact.proj"), projectionText(eng.cvec)],
  ]);
  facts($("facts-hw"), [
    ["GPU", st.gpu_name ? `${st.gpu_name}${hw.gpu_mem_total ? `, ${gb(hw.gpu_mem_total, 0)} GB` : ""}` : (st.gpu_note || t("mon.fact.gpu.noread"))],
    ["CPU", st.cpu_name ? `${st.cpu_name}${st.threads ? `, ${st.threads} threads` : ""}` : null],
    ["RAM", hw.ram_total ? `${gb(hw.ram_total, 0)} GB` : null],
  ]);
  const base = location.origin;
  facts($("facts-api"), [
    [t("mon.fact.openai_url"), `${base}/v1`, true],
    [t("mon.fact.anthropic_url"), base, true],
    [t("mon.fact.model_name"), eng.model, true],
  ]);
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (b) copyText(b.dataset.copy, b);
});
$("req-all").addEventListener("click", () => { reqShowAll = !reqShowAll; if (lastMetrics) render(lastMetrics); });

// ------------------------------------------------------------------ MCP servers (GET /mcp)
// Tools from the MCP servers in the run config: the chat offers them to the model (opt-in per request,
// "strata_mcp": true, which only this page sends); the Monitor lists the servers and what they offer.
let mcpInfo = {servers: [], tools: 0}, mcpRetry = null;
async function loadMcp() {
  try {
    const r = await fetch("mcp", {headers: headers()});
    if (!r.ok) return;
    mcpInfo = await r.json();
  } catch (e) { return; /* an older server: no MCP */ }
  renderMcp();
  clearTimeout(mcpRetry);                          // right after the start, servers may still be starting (npx downloads)
  if ((mcpInfo.servers || []).some((s) => s.status === "starting")) mcpRetry = setTimeout(loadMcp, 3000);
}
/* class + i18n key; the label is resolved at render time so it follows the language. */
const MCP_STATE = {ready: ["st-badge--generating", "mcp.state.ready"], starting: ["st-badge--reading", "mcp.state.starting"],
                   failed: ["st-badge--error", "mcp.state.failed"], stopped: ["st-badge--queued", "mcp.state.stopped"], idle: ["", "mcp.state.idle"]};
function renderMcp() {
  const servers = mcpInfo.servers || [];
  $("mcp-card").hidden = !servers.length;
  $("mcp-row").hidden = !servers.length;
  const ready = servers.filter((s) => s.status === "ready" || s.status === "stopped");
  $("mcp-sum").textContent = servers.length
    ? t("mon.mcp.sum", {tools: fmt(mcpInfo.tools), ready: ready.length, total: servers.length}) : "";
  $("mcp-row-sub").textContent = mcpInfo.tools
    ? t("drawer.mcp.hint.tools", {tools: fmt(mcpInfo.tools), names: ready.map((s) => s.name).join(", ")})
    : t("drawer.mcp.hint.none");
  $("mcp-list").innerHTML = servers.map((s) => {
    const [cls, key] = MCP_STATE[s.status] || ["", ""];
    const label = key ? t(key) : s.status;
    const info = s.info && s.info.name ? ` · ${s.info.name}${s.info.version ? ` ${s.info.version}` : ""}` : "";
    return `<div class="mcp-server"><div class="mcp-server__head"><span class="st-badge ${cls}">${esc(label)}</span>` +
      `<strong>${esc(s.name)}</strong><span class="muted small">${esc(s.transport)} · ${esc(t("unit.tools", {n: fmt(s.tools.length)}))}${esc(info)}</span></div>` +
      (s.error ? `<div class="msg-error">${esc(s.error)}</div>` : "") +
      (s.tools.length ? `<div class="mcp-server__tools">${s.tools.map((tl) => `<span class="chip" title="${esc(tl.description || "")}">${esc(tl.tool)}</span>`).join("")}</div>` : "") +
      `</div>`;
  }).join("");
}

// ------------------------------------------------------------------ Model settings (GET / POST /config, #564)
// A few documented keys of the run config (strata-<model>.json), for every client, from the next start on.  The
// server lists them, checks every value and keeps every other key of the file as it is.
let cfgKeys = [];
// Localized help for a run-config key. The server's help text is the English
// source of truth and always fresh; the zh dictionary is the translation layer.
// The English UI reads the server text directly — routing it through t() would
// fall back to the zh default dictionary and show Chinese (that is why the en
// dictionary carries no cfg.* keys). With i18n.js missing, t() returns the key
// itself and we land on the same English fallback.
function cfgHelp(k) {
  if (!window.i18n || window.i18n.lang !== "zh") return k.help;
  const loc = t("cfg." + k.key);
  return loc === "cfg." + k.key ? k.help : loc;   // t() returns the key when the zh dict lacks it
}
// An enum's values are ENGINE TOKENS ("none", "on_request") -- they get saved verbatim, so only the
// visible label is localized. Unknown pairs fall back to the raw token (never invent a label).
function cfgChoice(key, val) {
  if (!window.i18n || window.i18n.lang !== "zh") return val;
  const k = "cfg.val." + key + "." + val;
  const loc = t(k);
  return loc === k ? val : loc;
}
async function loadConfig() {
  let r;
  try { r = await fetch("config", {headers: headers()}); } catch (e) { return; }
  if (!r.ok) { $("cfg-card").hidden = true; return; }       // no run config, an older server, or no key yet
  const c = await r.json();
  cfgKeys = c.keys || [];
  $("cfg-file").textContent = c.file || "";
  $("cfg-form").innerHTML = cfgKeys.map((k, i) => {
    const id = `cfg-${i}`, v = k.value;
    let input;
    if (k.kind === "bool" || k.kind === "enum") {
      const opts = k.kind === "bool" ? [["true", "on"], ["false", "off"]] : k.choices.map((x) => [x, cfgChoice(k.key, x)]);
      const cur = v == null ? "" : String(v);
      input = `<select class="st-input" id="${id}"><option value=""${cur === "" ? " selected" : ""}>${t("about.cfg.default")}</option>` +
        opts.map(([val, text]) => `<option value="${esc(val)}"${cur === val ? " selected" : ""}>${esc(text)}</option>`).join("") + `</select>`;
    } else {
      const text = v == null ? "" : Array.isArray(v) ? v.join(", ") : String(v);
      // size="2" keeps the intrinsic width tiny so the fit-content fallback (no
      // field-sizing support) stays compact; with field-sizing the size attribute
      // is ignored and the box tracks the value itself.
      input = `<input class="st-input" id="${id}" size="2" ${k.kind === "number" ? 'type="number" step="any" min="0"' : 'type="text"'} ` +
        `value="${esc(text)}" placeholder="${t("about.cfg.default")}" autocomplete="off">`;
    }
    // label: the localized help; the title tooltip keeps the server's original
    // English, and the key itself stays in mono below the text.
    return `<label for="${id}" title="${esc(k.help)}">${esc(cfgHelp(k))}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("cfg-card").hidden = false;
}
function configValue(k, el) {
  const s = el.value.trim();
  if (s === "") return null;
  if (k.kind === "bool") return s === "true";
  if (k.kind === "number") return Number(s);
  return s;                                         // enum, or names (the server splits them at commas)
}
$("cfg-save").addEventListener("click", async () => {
  const set = {};
  cfgKeys.forEach((k, i) => {
    const v = configValue(k, $(`cfg-${i}`));
    const old = Array.isArray(k.value) ? k.value.join(", ") : k.value;
    if (JSON.stringify(v) !== JSON.stringify(old ?? null)) set[k.key] = v;
  });
  if (!Object.keys(set).length) { $("cfg-msg").textContent = t("toast.cfg.nothing"); return; }
  try {
    const r = await fetch("config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("cfg-msg").textContent = b.changed.length
      ? t("toast.cfg.saved", {changed: b.changed.join(", "), file: b.file})
      : t("toast.cfg.nothing");
    loadConfig();
  } catch (e) {
    $("cfg-msg").textContent = "";
    toast("error", t("toast.cfg.notsaved.title"), String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Runtime config (GET / POST /api/runtime-config)
// The gateway's own agent-loop + executor caps (max_rounds, timeouts, truncation). Unlike
// the engine's /config above, these take effect immediately (no restart) and are read live
// by the loop/executor. Only the direct-mode gateway exposes this endpoint; if it 404s the
// card is hidden. Mirrors the cfg section's form rendering for number-only keys.
let rtKeys = [];
// Pull only the live idle-timeout value from the gateway's runtime config and stash it for the tool timer.
// DOM-free on purpose: it can run at boot / on an interval without touching the About card. Falls back to
// the module default (180s) if the endpoint 404s (proxy mode) or the key is missing.
async function refreshIdleTimeout() {
  try {
    const r = await fetch("api/runtime-config", {headers: headers()});
    if (!r.ok) return;
    const c = await r.json();
    const k = (c.keys || []).find((x) => x.key === "idle_timeout_s");
    if (k != null && Number.isFinite(Number(k.value)) && Number(k.value) > 0) idleTimeoutS = Number(k.value);
  } catch (e) { /* keep current value */ }
}
function rtHelp(k) {
  if (!window.i18n || window.i18n.lang !== "zh") return k.help;   // en UI reads the server's English
  const loc = t("rt." + k.key);
  return loc === "rt." + k.key ? k.help : loc;                    // zh translation, English fallback
}
async function loadRuntimeConfig() {
  let r;
  try { r = await fetch("api/runtime-config", {headers: headers()}); } catch (e) { return; }
  if (!r.ok) { $("rt-card").hidden = true; return; }              // not direct mode, or an older server
  const c = await r.json();
  rtKeys = c.keys || [];
  const ik = rtKeys.find((x) => x.key === "idle_timeout_s");
  if (ik != null && Number.isFinite(Number(ik.value)) && Number(ik.value) > 0) idleTimeoutS = Number(ik.value);
  $("rt-file").textContent = c.file || "";
  $("rt-form").innerHTML = rtKeys.map((k, i) => {
    const id = `rt-${i}`, v = k.value;
    const text = v == null ? "" : String(v);
    const input = `<input class="st-input" id="${id}" size="6" type="number" step="any" min="0" ` +
      `value="${esc(text)}" placeholder="${t("about.cfg.default")}" autocomplete="off">`;
    return `<label for="${id}" title="${esc(k.help)}">${esc(rtHelp(k))}<code>${esc(k.key)}</code></label>${input}`;
  }).join("");
  $("rt-card").hidden = false;
}
$("rt-save").addEventListener("click", async () => {
  const set = {};
  let bad = false;
  rtKeys.forEach((k, i) => {
    const el = $(`rt-${i}`);
    const s = el.value.trim();
    if (s === "") return;                                         // leave as-is → server default
    const num = Number(s);
    if (!isFinite(num) || num < 0) { bad = true; return; }
    if (num !== k.value) set[k.key] = num;                        // only the values that changed
  });
  if (bad) { toast("error", t("toast.rt.bad.title"), t("toast.rt.bad.msg"), 6000); return; }
  if (!Object.keys(set).length) { $("rt-msg").textContent = t("toast.cfg.nothing"); return; }
  try {
    const r = await fetch("api/runtime-config", {method: "POST", headers: headers(true), body: JSON.stringify({set})});
    const b = await r.json();
    if (!r.ok) throw new Error((b.error || {}).message || `HTTP ${r.status}`);
    $("rt-msg").textContent = b.changed.length
      ? t("toast.rt.saved", {changed: b.changed.join(", "), file: b.file})
      : t("toast.cfg.nothing");
    loadRuntimeConfig();
  } catch (e) {
    $("rt-msg").textContent = "";
    toast("error", t("toast.rt.notsaved.title"), String(e.message || e), 6000);
  }
});

// ------------------------------------------------------------------ Markdown (escaped first, then formatted)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code class="inline">${esc(codes[+i])}</code>`);
}
// ------------------------------------------------------------------ syntax highlight (tiny, no deps)
// A single-pass tokeniser instead of pulling in highlight.js: the app ships offline and a 100 KB grammar
// bundle is a poor trade for a chat transcript. Branch ORDER matters — strings are tried first so a "//"
// inside a string is never mistaken for a comment, and comments come before operators for the same reason.
// Every token is escaped exactly once, so `pre.textContent` still equals the original source; the copy
// button (and every test that reads textContent) keeps working with highlighting on.
// Deliberately conservative: a word only earns keyword colour if it is reserved in some popular language
// AND is rarely used as an identifier in the others (so `arr.map(…)` / `range(…)` keep their call colour
// instead of turning into keywords). The call-name branch runs after this one, so a collision loses.
const HL_KW = new Set((
  // js / ts
  "const let var function return if else for while do break continue new class extends super this throw " +
  "try catch finally switch case default typeof instanceof in of async await yield delete void static " +
  "import export from as null true false undefined NaN interface type enum implements declare namespace " +
  "public private protected readonly abstract " +
  // c / c++ / java / c# / go / rust
  "struct impl fn pub mut crate unsafe where match loop defer chan nil func package " +
  "int float double char bool string long short unsigned signed template typename virtual override " +
  // python
  "def lambda pass raise except with global nonlocal assert del is not and or elif None True False " +
  // shell
  "then fi esac done"
).split(/\s+/).filter(Boolean));

const HL_KW_RE = [...HL_KW].join("|");

function hlFamily(lang) {
  const l = String(lang || "").trim().toLowerCase();
  if (/^(html|xml|svg|vue|htm)/.test(l)) return "html";                       // <!-- --> comments
  if (/^(py|python|sh|bash|zsh|shell|yaml|yml|toml|ini|conf|cfg|rb|ruby|pl|perl|r|dockerfile|makefile|ps1|powershell|sql|gitignore|env)/.test(l)) return "hash";  // # comments
  return "c";                                                                  // // and /* */ comments
}
const _hlRe = {};                                                              // family -> RegExp (built once)
function hlRegex(fam) {
  if (_hlRe[fam]) return _hlRe[fam];
  const kw = HL_KW_RE;
  const branches = fam === "html"
    ? [
      `("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')`,                   // 1 string
      `(<!--[\\s\\S]*?-->)`,                                                   // 2 comment
      `(<\\/?[A-Za-z][\\w:.-]*)`,                                              // 3 tag
      `(\\b(?:${kw})\\b)`,                                                     // 4 keyword
    ]
    : [
      `("(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*\`)`,   // 1 string
      fam === "hash" ? `(#[^\\n]*)` : `(\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*)`,          // 2 comment
      `(\\b(?:0[xX][0-9a-fA-F]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b)`,          // 3 number
      `(\\b(?:${kw})\\b)`,                                                     // 4 keyword
      `(\\b[A-Za-z_$][\\w$]*(?=\\s*\\())`,                                     // 5 call / definition name
      `([+\\-*/%=<>!&|^~?:]+)`,                                                // 6 operator
    ];
  return (_hlRe[fam] = new RegExp(branches.join("|"), "g"));
}
const HL_MAX = 60000;                                    // above this, skip colour: a 200 KB paste would jank a frame
function hl(code, lang) {
  const src = String(code == null ? "" : code);
  if (src.length > HL_MAX) return esc(src);
  const re = hlRegex(hlFamily(lang));
  re.lastIndex = 0;
  let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    if (!m[0]) { re.lastIndex++; continue; }                                   // zero-length guard
    if (m.index > last) out += esc(src.slice(last, m.index));
    const kind = m[1] !== undefined ? "str" : m[2] !== undefined ? "com" : m[3] !== undefined
      ? (/^</.test(m[0]) ? "tag" : "num") : m[4] !== undefined ? "kw" : m[5] !== undefined ? "fn" : "op";
    out += `<span class="hl-${kind}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  out += esc(src.slice(last));
  return out;
}
function codeBlock(lang, code) {
  const l = String(lang || "").trim();
  return `<div class="st-code"><div class="st-code__head">` +
    `<span class="st-code__lang">${esc(l || "code")}</span>` +
    `<button class="st-btn st-btn--icon st-code__copy" data-code-copy aria-label="${esc(t("ctx.copy.code"))}">${icon("copy")}</button>` +
    `</div><pre><code>${hl(code, l)}</code></pre></div>`;
}
// Defense against a known model hallucination: the model sometimes writes the ```plan``` markdown
// checklist as a TOOL-CALL XML scaffold (<function=plan> ... </function>, <parameter=...>,
// <tool_call>), which the action parser discards, so the raw XML tags render as English litter
// in the chat. We strip scaffold tags that occupy their OWN line and keep the content between them
// (the checklist lines), so the text still renders as a checklist. Only whole-line tags from the
// closed tool-call vocabulary are removed; inline angle brackets in prose and fenced code (which
// never reaches blocks()) are untouched. Idempotent: cleaned text matches nothing on a second pass.
const TOOLCALL_TAG_RE = /^<\/?(?:antml:)?(?:function|parameter|tool_call)[^>]*>\s*$/i;
function stripToolCallScaffolding(text) {
  const src = String(text == null ? "" : text);
  if (src.indexOf("<") < 0) return src;                          // fast path: no angle brackets
  const lines = src.split("\n");
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    if (TOOLCALL_TAG_RE.test(lines[i].trim())) { lines[i] = ""; touched = true; }
  }
  if (!touched) return src;                                      // nothing matched -> original
  return lines.join("\n");
}
function blocks(text, inlineFlow) {
  text = stripToolCallScaffolding(text);
  const out = [], lines = text.split("\n");
  let para = [], list = null;
  // inlineFlow (the mixed text+image bubble path): paragraphs stay INLINE -- content is joined
  // with <br> and gets no block wrapper, so a message the user typed as ONE line renders as
  // one line with the thumbnail sitting in the text flow, and a message typed with real
  // newlines breaks exactly where the user broke it (a blank line counts as one break).
  // Non-inlineFlow callers (every other path) stay on the old <p>-block layout.
  const wrapP = (inner) => (inlineFlow ? inner : `<p>${inner}</p>`);
  const flushPara = () => { if (para.length) out.push(wrapP(para.map(inline).join("<br>"))); para = []; };
  const flushList = () => { if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (!l.trim()) { flushPara(); flushList(); if (inlineFlow && out.length) out.push("<br>"); continue; }
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<${m[1].length <= 2 ? "h3" : "h4"}>${inline(m[2])}</${m[1].length <= 2 ? "h3" : "h4"}>`); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { flushPara(); flushList(); out.push("<hr>"); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push(`<blockquote>${inline(m[1])}</blockquote>`); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1])) {
      flushPara(); flushList();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
      let html = `<table><thead><tr>${cells(l).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) html += `<tr>${cells(lines[i++]).map((c) => `<td>${c}</td>`).join("")}</tr>`;
      i--;
      out.push(html + "</tbody></table>");
      continue;
    }
    if ((m = l.match(/^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/))) {
      flushPara();
      const tag = m[1] ? "ol" : "ul";
      if (!list || list.tag !== tag) { flushList(); list = {tag, items: []}; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s{2,}\S/.test(l)) { list.items[list.items.length - 1] += " " + l.trim(); continue; }
    flushList();
    para.push(l);
  }
  flushPara(); flushList();
  return out.join("");
}
function markdown(text, inlineFlow) {
  let html = "", rest = text;
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += blocks(rest, inlineFlow); break; }
    html += blocks(rest.slice(0, m.index), inlineFlow);
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { html += codeBlock(m[2].trim(), rest); break; }         // still streaming
    html += codeBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}
// C8: long streaming outputs must not be re-parsed in full every frame. Below MARKDOWN_LONG we
// render the whole text (cheap enough); above it we freeze a committed prefix (re-parsed only when
// the live-window boundary moves) and re-parse only a trailing window each frame.
const STREAM_RENDER_MS = 100;   // throttle streaming markdown to ~10 fps
const MARKDOWN_LONG = 24000;    // chars above which we switch to incremental rendering
const MARKDOWN_TAIL = 9000;     // size of the live trailing window we re-parse each frame
// Nearest render-safe boundary at/before `minStart`: a complete block (blank-line edge, no open fence),
// so the incremental tail renderer never splits a paragraph or a code block (C10 fence fallback).
function safeCut(text, minStart) {
  let cut = minStart;
  while (cut > 0 && text[cut - 1] !== "\n") cut--;                 // back to a line start
  if (cut > 0) {                                                  // back to a blank-line edge if mid-block
    const prev = text.lastIndexOf("\n\n", cut - 1);
    if (prev >= 0) cut = prev + 2; else cut = 0;
  }
  const pref = text.slice(0, cut);
  if ((pref.match(/```/g) || []).length % 2 === 1) {              // odd -> an open fence; cut before its opener
    const open = pref.lastIndexOf("```");
    cut = open >= 0 ? open : 0;
  }
  return Math.max(0, cut);
}
// Reconcile the bubble's segment nodes (see answerSpec/patchTool). Nothing is destroyed unless it really
// changed, so a running badge keeps blinking smoothly and the frame cost stays proportional to the new text.
// Work-log folding: when the turn used tools, every segment BEFORE the trailing markdown (intermediate
// prose, thoughts, tool calls) is tucked into one <details> group (stepsNode/patchSteps); only the final
// answer stays fully expanded. streaming=true keeps the group open for the live view, the finished turn
// auto-collapses it. Turn it off with the 执行过程折叠 setting.
function latestMsg(m, streaming) {                              // the newest assistant answer keeps its thoughts open while show is on
  if (streaming) return false;   // segment scroll: while streaming only the live segment speaks
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i] === m;
  return false;
}
function paintBubble(bubble, m, streaming) {
  let wrap = bubble.firstElementChild;
  if (!wrap || !wrap.classList.contains("ans")) {
    wrap = document.createElement("div");
    wrap.className = "ans";
    for (const n of [...bubble.childNodes]) if (!(n.classList && n.classList.contains("msg-error"))) n.remove();
    bubble.appendChild(wrap);
  }
  const spec = answerSpec(m);
  const fold = !!settings.stepsFold && (m.tools || []).length > 0 && spec.length > 1;
  const view = fold ? [{slot: "steps", group: spec.slice(0, spec.length - 1)}].concat(spec.slice(spec.length - 1)) : spec;
  let liveSlot = null;                       // the LAST thought can still be growing: it stays open while streaming
  for (let i = spec.length - 1; i >= 0; i--) if (spec[i].think != null) { liveSlot = spec[i].slot; break; }
  reconcileSegs(wrap, view, m, streaming, liveSlot, latestMsg(m, streaming));
}
// One reconcile step for a segment list, shared by paintBubble (top level) and patchSteps (inside the
// work-log group). Slots decide identity: a moved boundary swaps just that node, a fold toggle swaps the
// whole run once — never a full innerHTML wipe, so badges/animations and text selections survive.
function reconcileSegs(host, segs, m, streaming, liveSlot, isLatest) {
  for (let i = 0; i < segs.length; i++) {
    const sp = segs[i];
    let kid = host.children[i];
    if (kid && kid.dataset.slot !== sp.slot) {              // a segment boundary moved: swap just this one
      const fresh = segMake(sp);
      host.replaceChild(fresh, kid);
      kid = fresh;
    } else if (!kid) {
      kid = segMake(sp);
      host.appendChild(kid);
    }
  segPaint(kid, sp, m, streaming, liveSlot, isLatest);
  }
  while (host.children.length > segs.length) host.lastElementChild.remove();
}
function segMake(sp) {
  return sp.group ? stepsNode()
       : sp.tool ? toolNode(sp.tool, sp.k, sp.slot, sp.seq)
       : sp.think != null ? thinkNode(sp.think, sp.slot)
       : mdNode(sp.src, sp.slot);
}
function segPaint(kid, sp, m, streaming, liveSlot, isLatest) {
  if (sp.group) patchSteps(kid, sp.group, m, streaming, liveSlot, isLatest);
  else if (sp.tool) patchTool(kid, sp.tool, sp.k, sp.seq);
  else if (sp.think != null) patchThink(kid, sp.think, m, sp.slot, streaming && sp.slot === liveSlot, isLatest)   // the live segment stays live for the whole stream;
  else paintMd(kid, sp.src, streaming);
}
// The work-log group: one <details> holding everything before the final answer. Summary reads
// "执行过程 · 5 步 · 2 个工具 · 12.3 s" (duration = sum of the tools' own ms). Open state: while the
// turn streams it follows the live view; once finished it auto-collapses. A user toggle wins over the
// automatic behaviour for as long as this DOM node lives (state is render-local, not persisted — a
// re-render just folds again, which matches how st-think treats the same problem).
function stepsNode() {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<details class="st-collapse st-steps" data-slot="steps" open>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="st-steps__label">${esc(t("steps.label"))}</span>` +
    `<span class="muted small st-steps__meta"></span>` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary>` +
    `<div class="st-collapse__body st-steps__body"></div></details>`;
  const node = tpl.content.firstElementChild;
  // User intent via summary click, NOT a toggle listener: patchSteps also flips node.open
  // programmatically every frame, and programmatic changes fire toggle too — the flag would
  // immediately poison itself. Click fires before the default action, so the new state is !open.
  node.querySelector("summary").addEventListener("click", () => { node._user = true; node._open = !node.open; });
  return node;
}
function patchSteps(node, group, m, streaming, liveSlot) {
  const nTools = group.reduce((a, s) => a + (s.tool ? 1 : 0), 0);
  const secs = group.reduce((a, s) => a + (s.tool && s.tool.ms ? s.tool.ms : 0), 0) / 1000;
  const wantOpen = node._user ? !!node._open : streaming;
  const meta = t("steps.meta", {n: fmt(group.length), m: fmt(nTools)}) + (secs >= 0.1 ? ` · ${fmt(secs, 1)} s` : "");
  const sig = `${group.length}|${nTools}|${secs}|${wantOpen ? 1 : 0}|${meta}`;
  if (node._sig !== sig) {
    node._sig = sig;
    if (node.open !== wantOpen) node.open = wantOpen;
    const mt = node.querySelector(".st-steps__meta");
    if (mt && mt.textContent !== meta) mt.textContent = meta;
  }
  reconcileSegs(node.querySelector(".st-steps__body"), group, m, streaming, liveSlot);
}

// ------------------------------------------------------------------ Chat
const DEFAULTS = {thinking: "low", temperature: 1.0, top_p: 0.95, top_k: 20, max: "", seed: "", show: true, esp: true, mcp: true,
                  recall: true, autolearn: true, autocompact: true, compactPct: 0, compactTarget: 25, precondenseMax: 2, speedDropPct: 50, archiveOn: true, memCompactLLM: false, cnThink: false, designLang: "auto", persona: "",
                  maxCeiling: "", thinkBudget: "", answerFloor: "16384",
                  autoMemory: false, autosteps: false, autostepsRec: true, autoresume: true, stepsFold: true,
                  autoresumeMax: 24, emptyRoundMax: 2};
// F1: always-on base system prompt. Fixes the gap where, with no workspace selected, the model got
// NO system prompt at all; and pins the "answer in Chinese" rule so pasted English errors don't make
// the model reply in English. cnThink appends a reasoning-language rule (off by default — forcing
// Chinese reasoning can slow the model and isn't a clear quality win, so it's a measurable opt-in).
const BASE_SYSTEM = "你是一个名为 Strata 的本地智能体助手，运行在用户自己的机器上，帮助用户完成编程、文件处理与自动化任务。\n" +
  "【语言】始终使用简体中文撰写你的最终回答（代码、命令、变量名、技术专有名词可保留原文）。即使用户用其他语言提问，或粘贴了英文报错/文档，你也要用中文向用户解释与总结。\n" +
  "【工作准则】\n" +
  "1. 遇到歧义或关键信息不足时，先提出澄清问题，不要替用户假设关键前提。\n" +
  "2. 涉及读文件、写文件或运行命令，优先调用工具去实际执行，而不是只口头描述做法。\n" +
  "3. 写代码或改文件后，自查语法与明显错误；能用工具验证（读回文件、运行看输出）就用工具验证。\n" +
  "4. 回答先给结论再展开，结构化呈现；优先给出可运行的最小方案。\n" +
  "5. 若引用了【已检索到的相关经验知识】，请标明它来自经验库，并自行判断是否与当前问题相关，不相关就忽略。\n" +
  "6. 调用工具后必须基于工具的真实返回继续，禁止编造、臆测或伪造工具输出（不得虚构工具返回的结果）。\n" +
  "7. 任务未真正完成前应持续调用工具推进，不要在中间步骤停下只做口头描述；若无法继续或任务确已完成，再给出简洁的最终回答。";
// 强制中文思考（cnThink 开启时注入）：强措辞 + 首因/近因双位置（见 apiMessages）。
// 首因版：放在 BASE_SYSTEM 之前，抢占注意力锚点（方案 A），解决「多轮后大多不中文思考」的漂移。
const CN_THINK_RULE =
  "【思考语言·强制】无论用户使用何种语言、无论上下文中出现多少英文代码/报错/文档/技术名词，你的全部内部思考（reasoning / 思维链）都必须且只能使用简体中文进行推导、解释与自我提问。" +
  "仅以下「标识符」允许保留英文：变量名、函数名、类名、API 或库名、命令与缩写；除此之外所有说明、推理、举例、反思维持用中文。最终回答也须保持简体中文。\n";
// 近因版：作为系统消息数组末条（RAG 之后、历史之前），紧贴生成位置，避免被多轮历史稀释（方案 B）。
let settings = {...DEFAULTS, ...store.get("sampling", {})};
let messages = store.get("chat", []);
let undoStack = null;                 // {at, removed:[...], editedFrom, editedTo} — last soft/hard delete, for undo
let branches = store.get("branches", []);            // [{id, label, messages:[...], at}] saved branch snapshots
let branchSeq = branches.reduce((m, b) => Math.max(m, b.id || 0), 0);
let liveMessages = null;              // stash of the live thread while a saved branch is being viewed
let activeBranchId = store.get("activeBranch", null);
let attachments = [];                 // {name, url}
let pendingPastes = new Set();         // 2026-11: promises that RESOLVE once a paste's DOM node +
// array entry have landed (before any upload). A send/confirmEdit that fires the instant you pasted
// awaits these so the empty-array/empty-text guard never trips on a paste still mid-flight.
let busy = null;                      // {controller, msg}
// autonomous auto-drive (AI 自动续跑建议): chain bookkeeping so the feature can run on its own yet
// always yield back to the human on demand.
let autoDriveDepth = 0;               // how many AI-initiated steps in the current chain (capped)
let autoDriveAbort = false;           // user stopped the chain; swallow the next queued run
let autoDriveTimer = null;            // pending auto-drive fire (so the pill's Stop can cancel it)
const AUTO_DRIVE_MAX = 5;             // chain depth cap: hand back to the human after this many auto steps

// ------------------------------------------------------------------ Tasks & workspaces (sidebar tree)
// Two levels: a **workspace** (a folder on disk) owns the **tasks** started inside it.
//
//   task      {id, title, workspace, permission, persona, messages, pinned?, archived?, updatedAt?}
//   workspace {path, name, collapsed}     ← sidebar-only extras, keyed by path
//
// `sessions` stays the flat storage format (every other part of the app reads it); the sidebar
// groups it by `workspace`. The registry only stores what a task can't express: the display name a
// workspace was renamed to, its collapsed state, and spaces that have no task yet. A workspace is
// auto-registered the first time a task points at it, so an old flat task list needs no migration.
//
// `permission` is the per-workspace approval tier sent to the server on every chat request:
//   full   - no review, the model runs every tool freely
//   auto   - autonomous, but the server blocks clearly destructive shell commands
//   manual - every MCP tool call is paused for the user to approve/deny
const PERM_DESCS = {
  full: "完全访问：模型自由调用所有工具，无需确认。",
  auto: "自动审核：自动运行，但服务端会拦截明显危险的 shell 命令（如 rm -rf）。",
  manual: "手动审批：每次工具调用都会弹出审批框，由你确认或拒绝。",
};
const PERM_ORDER = ["full", "auto", "manual"];
const PERM_LABEL_KEYS = {full: "side.perm.full", auto: "side.perm.auto", manual: "side.perm.manual"};
let sessions = store.get("sessions", []);
let activeId = store.get("session.active", null);
let workspaces = store.get("workspaces", []);              // sidebar registry (see the note above)
let looseCollapsed = store.get("side.loose.collapsed", false);
let batchMode = false;                                     // multi-select mode for batch actions
const batchSel = new Set();                                // task ids picked in batch mode
const newSessionId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
                                                               : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
function findSession(id) { return sessions.find((s) => s.id === id) || null; }
function activeSession() { return activeId ? findSession(activeId) : null; }
function sessionPerm(s) { return s.permission || "full"; }   // missing -> full (unchanged old behaviour)
function saveSessions() { store.set("sessions", sessions); store.set("session.active", activeId); }
function setSessionPerm(sid, perm) {
  const s = findSession(sid);
  if (!s) return;
  s.permission = perm;
  saveSessions(); renderSessions();
  if (sid === activeId) syncPermSelect();
}
function sessionTitle(s) {
  if (s.title) return s.title;
  const first = (s.messages || []).find((m) => m.role === "user");
  return (first && first.text) ? first.text.slice(0, 60) : "New task";
}
// ---- workspace registry helpers ------------------------------------------------
// Windows paths are case-insensitive and users paste them with or without a trailing slash, so
// identity is "normalised + lower-cased"; the original string stays for display/opening.
const wsNorm = (p) => String(p || "").replace(/[\\/]+$/, "");
const wsKey = (p) => wsNorm(p).toLowerCase();
const wsLeaf = (p) => { const n = wsNorm(p); return n.split(/[\\/]/).filter(Boolean).pop() || ""; };
function wsFind(p) { const k = wsKey(p); return workspaces.find((w) => wsKey(w.path) === k) || null; }
function wsLabel(p) { const w = wsFind(p); return (w && w.name) || wsLeaf(p) || t("side.noworkspace"); }
function saveWorkspaces() { store.set("workspaces", workspaces); }
function registerWorkspace(p) {
  const path = wsNorm(p);
  if (!path) return null;                    // "no workspace" tasks have no parent row of their own
  let w = wsFind(path);
  if (!w) { w = {path, name: wsLeaf(path) || path, collapsed: false, pinned: false}; workspaces.push(w); saveWorkspaces(); }
  return w;
}
// "3分钟前" on the row's right edge. Tasks saved before this feature carry no timestamp, so they
// show nothing until their next turn instead of a made-up time.
function timeAgo(ts) {
  if (!ts) return "";
  const d = Date.now() - ts;
  if (d < 60e3) return t("side.time.now");
  if (d < 36e5) return t("side.time.min", {n: Math.floor(d / 60e3)});
  if (d < 864e5) return t("side.time.hour", {n: Math.floor(d / 36e5)});
  if (d < 30 * 864e5) return t("side.time.day", {n: Math.floor(d / 864e5)});
  return t("side.time.month", {n: Math.floor(d / (30 * 864e5))});
}
function taskOrder(a, b) {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;   // pinned tasks float to the top of their group
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}
function workspaceGroups() {
  sessions.forEach((s) => registerWorkspace(s.workspace));    // legacy flat tasks grow a parent row
  const groups = workspaces.map((w) => ({
    path: w.path, name: w.name || wsLeaf(w.path), collapsed: !!w.collapsed, pinned: !!w.pinned,
    tasks: sessions.filter((s) => wsKey(s.workspace) === wsKey(w.path)),
  }));
  const loose = sessions.filter((s) => !wsNorm(s.workspace));
  if (loose.length) groups.push({path: "", name: t("side.noworkspace"), collapsed: looseCollapsed, pinned: false, tasks: loose});
  groups.forEach((g) => g.tasks.sort(taskOrder));
  // Pinned workspaces float to the top; the "no workspace" bucket always sits at the bottom so it
  // never gets promoted above real folders. Within each tier we keep the registration order.
  groups.sort((a, b) => {
    if (!a.path) return 1;                 // a is loose → push to the end
    if (!b.path) return -1;                // b is loose → push to the end
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return 0;
  });
  return groups;
}
// A task row. It is a div (not a button) on purpose: it hosts its own "···" button, and a nested
// <button> inside a <button> is invalid HTML the parser silently un-nests.
function taskRow(s) {
  const perm = sessionPerm(s);
  const cls = "st-session" + (s.id === activeId ? " on" : "") + (s.archived ? " archived" : "")
            + (s.pinned ? " pinned" : "") + (batchMode ? " batch" : "") + (batchSel.has(s.id) ? " sel" : "")
            + ((busy && s.id === busy.sessionId) ? " running" : "");
  return `
    <div class="${cls}" data-sid="${esc(s.id)}" role="button" tabindex="0"
         title="${esc(s.workspace || t("side.noworkspace"))}">
      ${batchMode ? `<span class="st-session__check">${icon("check", "st-icon st-icon--sm")}</span>` : ""}
      <span class="perm-dot perm-dot--${perm}" data-perm-cycle="${esc(s.id)}" title="${esc(PERM_DESCS[perm])}"></span>
      ${s.pinned ? `<span class="st-session__pin" title="${esc(t("side.pin"))}">${icon("pin", "st-icon st-icon--sm")}</span>` : ""}
      <span class="st-session__title">${esc(sessionTitle(s))}</span>
      <span class="st-session__time">${esc(timeAgo(s.updatedAt))}</span>
      <button class="st-btn st-btn--icon st-session__more" data-task-menu="${esc(s.id)}"
              title="${esc(t("side.more"))}" aria-label="${esc(t("side.more"))}">${icon("more", "st-icon st-icon--sm")}</button>
    </div>`;
}
// A workspace row: chevron + folder + name + task count, with "chat in this space" and "···".
function wsRow(g) {
  const loose = !g.path;                     // the "no workspace" bucket has no folder to manage
  return `
    <div class="st-ws${g.collapsed ? " collapsed" : ""}${loose ? " st-ws--loose" : ""}" data-ws="${esc(g.path)}">
      <div class="st-ws__head" data-ws-head="${esc(g.path)}">
        <button class="st-ws__toggle" data-ws-toggle="${esc(g.path)}" aria-expanded="${g.collapsed ? "false" : "true"}"
                aria-label="${esc(g.name)}">${icon("chevron", "st-icon")}</button>
        ${icon("folder", "st-icon st-icon--sm")}
        <span class="st-ws__name" data-ws-name="${esc(g.path)}" title="${esc(g.path || t("side.noworkspace"))}">${esc(g.name)}</span>
        <span class="st-ws__count">${g.tasks.length}</span>
        ${g.pinned ? `<span class="st-ws__pin" title="${esc(t("side.pin"))}">${icon("pin", "st-icon st-icon--sm")}</span>` : ""}
        <span class="st-ws__actions">
          <button class="st-btn st-btn--icon" data-ws-chat="${esc(g.path)}" title="${esc(t("side.newtaskhere"))}"
                  aria-label="${esc(t("side.newtaskhere"))}">${icon("new-chat", "st-icon st-icon--sm")}</button>
          <button class="st-btn st-btn--icon" data-ws-menu="${esc(g.path)}" title="${esc(t("side.more"))}"
                  aria-label="${esc(t("side.more"))}">${icon("more", "st-icon st-icon--sm")}</button>
        </span>
      </div>
      <div class="st-ws__tasks">${g.tasks.map(taskRow).join("") || `<div class="st-ws__empty">${esc(t("side.notasks"))}</div>`}</div>
    </div>`;
}
function renderSessions() {
  const list = $("session-list");
  if (!list) return;
  list.innerHTML = workspaceGroups().map(wsRow).join("");
  renderBatchBar();
  const s = activeSession();
  $("workspace-name").textContent = (s && s.workspace) ? wsLabel(s.workspace) : t("side.noworkspace");
  $("workspace-name").title = (s && s.workspace) || "";
  const on = list.querySelector(".st-session.on");
  if (on && on.scrollIntoView) { try { on.scrollIntoView({block: "nearest"}); } catch (e) { /* jsdom */ } }
}
function renderBatchBar() {
  const bar = $("batch-bar");
  if (!bar) return;
  bar.hidden = !batchMode;
  if (!batchMode) return;
  $("batch-count").textContent = t("side.batch.count", {n: batchSel.size});
  const sel = $("batch-move");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">${esc(t("side.batch.move"))}</option>` +
    workspaces.map((w) => `<option value="${esc(w.path)}">${esc(w.name || wsLeaf(w.path))}</option>`).join("");
  sel.value = cur;
}
// One delegated router for the whole tree: workspace head buttons, task menus, and row selection.
$("session-list").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-ws-toggle]");
  if (toggle) { toggleWorkspace(toggle.dataset.wsToggle); return; }
  const chat = e.target.closest("[data-ws-chat]");
  if (chat) { e.stopPropagation(); newTaskInWorkspace(chat.dataset.wsChat); return; }
  const wsMenuBtn = e.target.closest("[data-ws-menu]");
  if (wsMenuBtn) {
    e.stopPropagation();
    const path = wsMenuBtn.dataset.wsMenu;
    popMenu.openAt(wsMenuBtn, wsMenuItems(path), (k) => onWorkspaceAction(path, k));
    return;
  }
  const taskMenuBtn = e.target.closest("[data-task-menu]");
  if (taskMenuBtn) {
    e.stopPropagation();
    const sid = taskMenuBtn.dataset.taskMenu;
    popMenu.openAt(taskMenuBtn, taskMenuItems(findSession(sid)), (k) => onTaskAction(sid, k));
    return;
  }
  const cycle = e.target.closest("[data-perm-cycle]");
  if (cycle) { e.stopPropagation(); cyclePerm(cycle.dataset.permCycle); return; }
  const row = e.target.closest("[data-sid]");
  if (!row) return;
  if (batchMode) { toggleBatchSel(row.dataset.sid); return; }
  selectSession(row.dataset.sid);
});
// Keyboard access for the rows (they are divs with role="button").
$("session-list").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest && e.target.closest("[data-sid]");
  if (!row) return;
  e.preventDefault();
  if (batchMode) toggleBatchSel(row.dataset.sid); else selectSession(row.dataset.sid);
});
// The batch bar's own actions.
$("batch-bar").addEventListener("click", (e) => {
  const b = e.target.closest("[data-batch]");
  if (!b) return;
  const act = b.dataset.batch;
  if (act === "all") batchSelectAll();
  else if (act === "pin") batchPin(true);
  else if (act === "unpin") batchPin(false);
  else if (act === "del") batchDelete();
  else if (act === "done") setBatchMode(false);
});
$("batch-move").addEventListener("change", (e) => {
  const path = e.target.value;
  e.target.value = "";
  if (path) batchMove(path);
});
// ---- row identity ---------------------------------------------------------------
// Workspace paths contain \ and :, which cannot go inside a querySelector attribute selector
// without escaping, so rows are looked up by scanning the list instead.
function taskRowEl(sid) {
  const list = $("session-list");
  return list ? [...list.querySelectorAll(".st-session")].find((n) => n.dataset.sid === sid) || null : null;
}
function wsRowEl(path) {
  const list = $("session-list");
  return list ? [...list.querySelectorAll(".st-ws")].find((n) => n.dataset.ws === path) || null : null;
}
// Inline rename, triggered by the "···" menu or a double-click on the title.
function startRename(sid) {
  const s = findSession(sid);
  const row = taskRowEl(sid);
  const titleEl = row && row.querySelector(".st-session__title");
  if (!s || !titleEl) return;
  const input = document.createElement("input");
  input.type = "text"; input.value = sessionTitle(s);
  input.className = "st-input st-inline-edit";
  titleEl.replaceWith(input);
  input.focus(); input.select();
  const save = () => { s.title = input.value.trim() || ""; saveSessions(); renderSessions(); };
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } if (ev.key === "Escape") renderSessions(); });
  input.addEventListener("blur", save);
}
// Renaming a workspace only changes the sidebar label — the folder on disk keeps its name.
function startWsRename(path) {
  const w = wsFind(path) || registerWorkspace(path);
  const row = wsRowEl(wsNorm(path));
  const nameEl = row && row.querySelector(".st-ws__name");
  if (!w || !nameEl) return;
  const input = document.createElement("input");
  input.type = "text"; input.value = w.name || wsLeaf(path);
  input.className = "st-input st-inline-edit";
  nameEl.replaceWith(input);
  input.focus(); input.select();
  const save = () => {
    w.name = input.value.trim() || wsLeaf(w.path) || w.path;
    saveWorkspaces(); renderSessions();
  };
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); save(); } if (ev.key === "Escape") renderSessions(); });
  input.addEventListener("blur", save);
}
function selectSession(sid) {
  const s = findSession(sid);
  if (!s) return;
  // 2026-10-21: viewing another task while one streams is allowed -- the stream keeps
  // running in the background and writes back to its OWN session at its finish (see
  // streamAssistant's tail). Hand the originating session its live array BY REFERENCE
  // before we switch: saveChat's shallow copy would orphan the streaming message.
  if (busy && busy.sessionId && activeId === busy.sessionId) {
    const owner = findSession(busy.sessionId);
    if (owner) { owner.messages = messages; busy.origin = owner; }
  }
  activeId = s.id; messages = s.messages || [];
  loadMemoryState(s.workspace);          // H2: switch the injected rules to this session's workspace
  saveSessions(); renderSessions(); renderChat(); syncPermSelect(); syncCtxFromSession(); $("input").focus();
}
function cyclePerm(sid) {
  const s = findSession(sid);
  if (!s) return;
  const next = PERM_ORDER[(PERM_ORDER.indexOf(sessionPerm(s)) + 1) % PERM_ORDER.length];
  setSessionPerm(s.id, next);
  toast("info", t("side.permset", {perm: t(PERM_LABEL_KEYS[next])}));
}
function deleteTask(sid) {
  const s = findSession(sid);
  if (!s) return;
  if (sessions.length <= 1) { toast("warn", t("toast.lasttask.title"), t("toast.lasttask.msg")); return; }
  if (busy && sid === busy.sessionId) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  if (!confirm(t("side.deltask.confirm", {name: sessionTitle(s)}))) return;
  sessions = sessions.filter((x) => x.id !== sid);
  batchSel.delete(sid);
  if (activeId === sid) { activeId = sessions[0].id; messages = sessions[0].messages || []; renderChat(); syncCtxFromSession(); }
  saveSessions(); renderSessions(); syncPermSelect();
}
// The chat button on a workspace row: a fresh task that already lives inside that folder, no picker.
function newTaskInWorkspace(path) {
  const p = wsNorm(path);
  saveChat();                                  // persist the task we are leaving first
  if (busy && busy.sessionId && activeId === busy.sessionId) {
    const owner = findSession(busy.sessionId);
    if (owner) { owner.messages = messages; busy.origin = owner; }
  }
  registerWorkspace(p);
  const siblings = sessions.filter((s) => wsKey(s.workspace) === wsKey(p)).sort(taskOrder);
  const last = siblings[0];
  const s = {id: newSessionId(), title: "", workspace: p, messages: [], updatedAt: Date.now(),
             permission: last ? sessionPerm(last) : "auto",          // safe default for a brand-new space
             persona: (last && last.persona) || ""};
  sessions.unshift(s);
  activeId = s.id; messages = [];
  loadMemoryState(p);
  saveSessions(); renderSessions(); renderChat(); syncPermSelect(); syncCtxFromSession(); $("input").focus();
}
// Reveal a folder in Explorer/Finder. The server owns the actual launch (POST /workspace/open);
// an older server without that route degrades to "copy the path" instead of failing silently.
async function openFolder(path) {
  const p = wsNorm(path);
  if (!p) { toast("warn", t("toast.nows.title"), t("toast.nows.msg")); return; }
  try {
    const r = await fetch("workspace/open", {method: "POST", headers: headers(true), body: JSON.stringify({path: p})});
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    toast("info", t("toast.opened.title"), j.path || p, 2500);
  } catch (e) {
    try {
      await navigator.clipboard.writeText(p);
      toast("warn", t("toast.openfallback.title"), t("toast.openfallback.msg", {path: p}), 6000);
    } catch (e2) { toast("error", t("toast.openfailed.title"), e.message, 5000); }
  }
}
function toggleWorkspace(path) {
  if (!path) {                                   // the "no workspace" bucket
    looseCollapsed = !looseCollapsed;
    store.set("side.loose.collapsed", looseCollapsed);
    renderSessions();
    return;
  }
  const w = registerWorkspace(path);
  if (!w) return;
  w.collapsed = !w.collapsed;
  saveWorkspaces(); renderSessions();
}
// "Remove from list": the folder on disk is untouched; the sidebar entry (and the tasks that lived
// in it, after an explicit confirm) are dropped. The confirm names the count so nobody loses a chat
// history by accident.
function removeWorkspace(path) {
  const tasks = sessions.filter((s) => wsKey(s.workspace) === wsKey(path));
  const name = wsLabel(path);
  const msg = tasks.length ? t("side.removews.confirm", {name, n: tasks.length})
                           : t("side.removews.confirm0", {name});
  if (!confirm(msg)) return;
  if (busy && tasks.some((s) => s.id === activeId)) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  sessions = sessions.filter((s) => wsKey(s.workspace) !== wsKey(path));
  workspaces = workspaces.filter((w) => wsKey(w.path) !== wsKey(path));
  if (!sessions.length) sessions.push({id: newSessionId(), title: "", workspace: "", messages: [],
                                       permission: "auto", updatedAt: Date.now()});
  if (!findSession(activeId)) { activeId = sessions[0].id; messages = sessions[0].messages || []; renderChat(); syncCtxFromSession(); }
  saveSessions(); saveWorkspaces(); renderSessions(); syncPermSelect();
}
function onTaskAction(sid, key) {
  const s = findSession(sid);
  if (!s) return;
  if (key === "rename") return startRename(sid);
  if (key === "batch") return setBatchMode(true);
  if (key === "folder") return openFolder(s.workspace);
  if (key === "pin") {
    s.pinned = !s.pinned;
    saveSessions(); renderSessions();
    return;
  }
  if (key.indexOf("perm-") === 0) {
    setSessionPerm(sid, key.slice(5));
    toast("info", t("side.permset", {perm: t(PERM_LABEL_KEYS[key.slice(5)])}));
    return;
  }
  if (key === "delete") return deleteTask(sid);
}
function onWorkspaceAction(path, key) {
  if (key === "rename") return startWsRename(path);
  if (key === "pin") {
    const w = registerWorkspace(path);
    if (w) { w.pinned = !w.pinned; saveWorkspaces(); renderSessions(); }
    return;
  }
  if (key === "folder") return openFolder(path);
  if (key === "remove") return removeWorkspace(path);
}
// ---- batch mode ----------------------------------------------------------------
function setBatchMode(on) {
  batchMode = !!on;
  if (!batchMode) batchSel.clear();
  renderSessions();
}
function toggleBatchSel(sid) {
  if (batchSel.has(sid)) batchSel.delete(sid); else batchSel.add(sid);
  renderSessions();
}
function batchSelectAll() {
  if (batchSel.size === sessions.length) batchSel.clear();
  else sessions.forEach((s) => batchSel.add(s.id));
  renderSessions();
}
function batchPin(on) {
  if (!batchSel.size) { toast("warn", t("side.batch.none")); return; }
  batchSel.forEach((id) => { const s = findSession(id); if (s) s.pinned = !!on; });
  saveSessions(); renderSessions();
}
function batchDelete() {
  if (!batchSel.size) { toast("warn", t("side.batch.none")); return; }
  if (busy && batchSel.has(busy.sessionId)) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  const ids = [...batchSel];
  if (!confirm(t("side.batch.delconfirm", {n: ids.length}))) return;
  const backup = sessions.slice();
  sessions = sessions.filter((s) => !batchSel.has(s.id));
  if (!sessions.length) sessions.push({id: newSessionId(), title: "", workspace: "", messages: [],
                                       permission: "auto", updatedAt: Date.now()});
  if (!findSession(activeId)) { activeId = sessions[0].id; messages = sessions[0].messages || []; renderChat(); syncCtxFromSession(); }
  batchSel.clear(); batchMode = false;
  saveSessions(); renderSessions(); syncPermSelect();
  toast("info", t("side.batch.deleted", {n: ids.length}), "", 5000, {label: t("toast.undo"), run: () => { sessions = backup; if (!findSession(activeId)) activeId = sessions[0].id; messages = (findSession(activeId) || {}).messages || []; saveSessions(); renderSessions(); renderChat(); syncCtxFromSession(); }});
}
function batchMove(path) {
  const p = wsNorm(path);
  if (!p) return;
  if (!batchSel.size) { toast("warn", t("side.batch.none")); return; }
  registerWorkspace(p);
  const n = batchSel.size;
  batchSel.forEach((id) => { const s = findSession(id); if (s) s.workspace = p; });
  if (batchSel.has(activeId)) loadMemoryState(p);
  saveSessions(); renderSessions();
  toast("info", t("side.batch.moved", {n, name: wsLabel(p)}));
}
// Double-click renames: task title and workspace name.
$("session-list").addEventListener("dblclick", (e) => {
  const nameEl = e.target.closest(".st-ws__name");
  if (nameEl) { startWsRename(nameEl.dataset.wsName); return; }
  const titleEl = e.target.closest(".st-session__title");
  if (!titleEl) return;
  const row = e.target.closest("[data-sid]");
  if (row) startRename(row.dataset.sid);
});

$("sidebar-collapse").onclick = () => { document.body.classList.toggle("side-collapsed"); store.set("side.collapsed", document.body.classList.contains("side-collapsed")); layoutHandles(); };

// ------------------------------------------------------------------ popup menu (rows + right-click)
// One reusable menu drives the workspace "···", the task "···" and both right-click menus, so the
// item lists (and their i18n labels) live in exactly one place.
const popMenu = (() => {
  const el = document.createElement("div");
  el.className = "st-ctx-menu";
  el.hidden = true;
  document.body.appendChild(el);
  let onPick = null;
  function paint(items) {
    el.innerHTML = items.map((it) => it.sep
      ? `<button class="ctx-sep" tabindex="-1">${esc(it.label || "")}</button>`
      : `<button data-key="${esc(it.key)}" class="${it.danger ? "danger" : ""}${it.on ? " on" : ""}">${it.on ? "✓ " : ""}${esc(it.label)}</button>`
    ).join("");
  }
  // `align` is which edge of the popup sits on `x`; "right" keeps a sidebar menu inside the window.
  function open(x, y, items, pick, align = "left") {
    paint(items);
    onPick = pick;
    el.hidden = false;
    el.style.zIndex = "60";
    el.style.left = "0px"; el.style.top = "0px";
    const r = el.getBoundingClientRect();
    const left = align === "right" ? x - r.width : x;
    el.style.left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8)) + "px";
    el.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }
  function openAt(anchor, items, pick) {
    const r = anchor.getBoundingClientRect();
    open(r.right, r.bottom + 4, items, pick, "right");
  }
  function hide() { el.hidden = true; onPick = null; }
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-key]");
    if (!b) return;
    const fn = onPick, key = b.dataset.key;
    hide();
    if (fn) fn(key);
  });
  document.addEventListener("click", (e) => { if (!el.hidden && !el.contains(e.target)) hide(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); });
  document.addEventListener("scroll", () => hide(), true);
  return {open, openAt, hide, isOpen: () => !el.hidden};
})();
// Task menu: rename / batch / open folder / pin / permission / delete.
function taskMenuItems(s) {
  const perm = sessionPerm(s || {});
  return [
    {key: "rename", label: t("side.rename")},
    {key: "batch", label: t("side.batch")},
    {key: "folder", label: t("side.openfolder")},
    {key: "pin", label: (s && s.pinned) ? t("side.unpin") : t("side.pin")},
    {key: "perm", label: t("side.perm"), sep: true},
    {key: "perm-full", label: t(PERM_LABEL_KEYS.full), on: perm === "full"},
    {key: "perm-auto", label: t(PERM_LABEL_KEYS.auto), on: perm === "auto"},
    {key: "perm-manual", label: t(PERM_LABEL_KEYS.manual), on: perm === "manual"},
    {key: "delete", label: t("side.deltask"), danger: true},
  ];
}
// Workspace menu: the folder-level actions, including pin so a workspace can be floated to the top.
function wsMenuItems(path) {
  const w = wsFind(path);
  return [
    {key: "rename", label: t("side.renamews")},
    {key: "pin", label: (w && w.pinned) ? t("side.unpin") : t("side.pin")},
    {key: "folder", label: t("side.openfolder")},
    {key: "remove", label: t("side.removews"), danger: true},
  ];
}
$("session-list").addEventListener("contextmenu", (e) => {
  const row = e.target.closest("[data-sid]");
  if (row) {
    e.preventDefault();
    const sid = row.dataset.sid;
    popMenu.open(e.clientX, e.clientY, taskMenuItems(findSession(sid)), (k) => onTaskAction(sid, k));
    return;
  }
  const head = e.target.closest("[data-ws-head]");
  if (!head) return;
  e.preventDefault();
  const path = head.dataset.wsHead;
  if (!path) return;
  popMenu.open(e.clientX, e.clientY, wsMenuItems(path), (k) => onWorkspaceAction(path, k));
});

// ------------------------------------------------------------------ P1-1: Knowledge panel
async function loadKnowledgePanel() {
  if (!mcpInfo.tools) return;  // no MCP servers connected
  const list = $("kb-list");
  try {
    // memory/sources answers in plain lines: "<source>: <n> chunks" (or "no sources")
    const txt = await mcpText("memory", "sources", {});
    const rows = txt.split("\n").map((l) => l.trim()).filter(Boolean)
      .map((l) => l.match(/^(.*?):\s*(\d+)\s+chunks$/)).filter(Boolean)
      .map((m) => ({source: m[1], chunks: m[2]}));
    if (!rows.length) { list.innerHTML = '<div class="kb-source muted">' + t("mem.kb.empty") + '</div>'; return; }
    list.innerHTML = rows.map((s) => `<div class="kb-source"><span class="kb-source__name" title="${esc(s.source)}">${esc(s.source)}</span>` +
      `<span class="muted small">${esc(s.chunks)}</span>` +
      `<button class="st-btn st-btn--icon" data-kb-del="${esc(s.source)}" aria-label="${esc(t("side.delete"))}" title="${esc(t("side.delete"))}">${icon("trash")}</button></div>`).join("");
  } catch (e) { list.innerHTML = '<div class="kb-source muted">' + t("kb.loadfailed") + '</div>'; }
}
$("kb-panel").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-kb-del]");
  if (del) {
    const src = del.dataset.kbDel;
    if (!confirm(t("mem.kb.del.source.confirm", {src}))) return;
    try {
      await mcpCall("memory", "forget", {source: src});   // throws when the tool fails
      loadKnowledgePanel();
    } catch (e2) { toast("error", t("toast.delfailed.title"), e2.message, 4000); }
  }
});
$("workspace-btn").addEventListener("dblclick", () => { loadKnowledgePanel(); $("kb-panel").classList.toggle("open"); });

$("new-task-btn").onclick = () => {
  // Persist through saveChat(), not by assigning `messages` directly: saveChat strips
  // the base64 image/file payloads, while a raw assignment bakes them into
  // localStorage and can blow the whole ~5 MB quota in one click.
  saveChat();
  if (busy && busy.sessionId && activeId === busy.sessionId) {
    const owner = findSession(busy.sessionId);
    if (owner) { owner.messages = messages; busy.origin = owner; }
  }
  openWorkspacePicker(/*newSession=*/ true);
};

$("ws-modal").addEventListener("click", (e) => { if (e.target.id === "ws-modal") closeWorkspacePicker(); });
$("ws-close").onclick = closeWorkspacePicker;
$("ws-pick").onclick = () => openBrowser($("ws-path").value.trim());
// The workspace needs the folder's REAL absolute path. The browser's own picker
// (showDirectoryPicker) cannot give it -- a FileSystemDirectoryHandle carries only a
// leaf name, so it would hand the agent a relative path that resolves against the
// server's cwd elsewhere. So "浏览" opens an in-app browser that reads the tree from
// the server (which already owns the filesystem) and returns the absolute path.
$("ws-path").addEventListener("input", debounce(updateResolved, 350));
    $("ws-path").addEventListener("compositionend", debounce(updateResolved, 350));   // IME: CJK typed path must refresh on commit
$("ws-path").addEventListener("change", updateResolved);
// Show the resolved absolute path + exists check under the input field, so the user
// can confirm what will actually be used before pressing 设置工作区 (a tooltip alone
// would hide it). Runs on open too.
function updateResolved() {
  const raw = $("ws-path").value.trim();
  const el = $("ws-resolved");
  if (!raw) { el.textContent = ""; el.className = "ws-resolved"; return; }
  fetch("workspace/list?path=" + encodeURIComponent(raw), {headers: headers()}).then((r) => r.json()).then((j) => {
    const l = j && j.listing;
    if (!l) { el.textContent = ""; el.className = "ws-resolved"; return; }
    if (l.exists) { el.textContent = l.path; el.className = "ws-resolved ok"; }
    else { el.textContent = l.path + "  —  " + t("ws.resolved.missing"); el.className = "ws-resolved bad"; }
  }).catch(() => { el.textContent = ""; el.className = "ws-resolved"; });
}
// Windows drive (C:\ or C:/), POSIX root (/), or a UNC prefix (\\host\share).
const isAbsolutePath = (p) => /^(?:[a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(String(p || ""));
// Per-workspace permission tier chosen in the workspace picker.
let wsPermSel = "auto";
function setWsPerm(perm) {
  wsPermSel = perm;
  document.querySelectorAll("#ws-perm .perm-seg__btn").forEach((b) =>
    b.classList.toggle("on", b.dataset.perm === perm));
  const d = $("ws-perm-desc"); if (d) d.textContent = PERM_DESCS[perm];
}
$("ws-perm").addEventListener("click", (e) => {
  const b = e.target.closest(".perm-seg__btn");
  if (b) setWsPerm(b.dataset.perm);
});
$("ws-create").onclick = async () => {
  const parent = $("ws-new").value.trim();
  if (!parent) { toast("warn", t("toast.entername.title")); return; }
  // Ask the server to create the folder (via POST /workspace/create).
  try {
    const r = await fetch("workspace/create", {method: "POST", headers: headers(true), body: JSON.stringify({name: parent})});
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error?.message || `HTTP ${r.status}`);
    $("ws-path").value = j.path || "";
  } catch (e) { toast("error", t("toast.createfailed.title"), e.message, 5000); }
};
$("ws-apply").onclick = async () => {
  let path = $("ws-path").value.trim();
  const persona = $("ws-persona").value.trim();
  const newSession = $("ws-modal").dataset.newSession === "1";
  // A workspace is a real folder on disk. If the user typed a bare name (not a full
  // path, and not via the "create" button) turn it into a real folder under the
  // server's workspace root and store the absolute path — so "打开文件夹" always
  // opens a folder that exists. Legacy sessions that only stored a name self-heal on
  // open (the server creates the folder), this just future-proofs new ones.
  if (path && !isAbsolutePath(path)) {
    try {
      const r = await fetch("workspace/create", {method: "POST", headers: headers(true), body: JSON.stringify({name: path})});
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.path) path = j.path;
    } catch (e) { /* offline / older server: keep the bare name; open() will self-heal or fall back */ }
  }
  // Show the user the path that was actually stored (a bare name becomes an absolute
  // path under the server's workspace root), so "saved but path stayed short" can't happen.
  $("ws-path").value = path;
  updateResolved();
  if (newSession) {
    const id = newSessionId();
    const s = {id, title: "", workspace: path, permission: wsPermSel, persona, messages: [], updatedAt: Date.now()};
    sessions.push(s);
    activeId = id;
    messages = [];
  } else {
    const s = activeSession();
    if (s) { s.workspace = path; s.permission = wsPermSel; s.persona = persona; }
  }
  registerWorkspace(path);                  // the new task's folder becomes a parent row
  loadMemoryState(path);                     // H2: load approved rules + any pending draft for this workspace
  saveSessions(); renderSessions(); renderChat(); syncCtxFromSession();
  closeWorkspacePicker();
  $("input").focus();
};
$("ws-none").onclick = () => {
  $("ws-path").value = "";
  $("ws-apply").click();
};
function openWorkspacePicker(newSession) {
  $("ws-modal").dataset.newSession = newSession ? "1" : "";
  $("ws-path").value = (newSession ? "" : ((activeSession() || {}).workspace || ""));
  $("ws-new").value = "";
  $("ws-persona").value = (newSession ? "" : ((activeSession() || {}).persona || ""));
  // Pre-select the permission: a fresh workspace defaults to the safe "auto" tier; an existing
  // session keeps its stored tier (missing -> full, so old tasks behave as before).
  setWsPerm(newSession ? "auto" : sessionPerm(activeSession() || {}));
  $("ws-modal").hidden = false;
  $("scrim").hidden = false;
  $("scrim").onclick = closeWorkspacePicker;
  $("ws-path").focus();
  updateResolved();
}
function closeWorkspacePicker() {
  $("ws-modal").hidden = true;
  $("scrim").hidden = true;
}
$("workspace-btn").onclick = () => { if (!busy) openWorkspacePicker(false); };

// ─── In-app folder browser (replaces the browser's path-less picker) ───────────────
// Reads the real directory tree from the server and returns the absolute path, so the
// workspace always resolves to a folder that actually exists on this machine.
let wbCurrent = "";          // the absolute path currently selected in the browser
let wbPlacesReady = false;   // the drives/places shortcuts are rendered once per open
function openBrowser(start) {
  wbCurrent = (start || "").trim();
  wbPlacesReady = false;
  $("ws-browse-current").textContent = wbCurrent;
  $("ws-browse-note").hidden = true;
  $("ws-browse").hidden = false;
  $("scrim").hidden = false;
  $("scrim").onclick = closeBrowser;
  wbLoad(wbCurrent);
}
function closeBrowser() {
  $("ws-browse").hidden = true;
  $("scrim").hidden = true;
}
async function wbLoad(path) {
  let j;
  try {
    const r = await fetch("workspace/list?path=" + encodeURIComponent(path || ""), {headers: headers()});
    j = await r.json();
  } catch (e) { return; }
  if (!wbPlacesReady && j.drives) {
    const places = [...(j.drives || []), ...(j.places || [])];
    $("ws-browse-places").innerHTML = places.map((p) =>
      `<button class="ws-browse__place" data-path="${esc(p.path)}">${esc(p.name)}</button>`).join("");
    wbPlacesReady = true;
  }
  const l = j.listing;
  const list = $("ws-browse-list");
  const note = $("ws-browse-note");
  if (!l) { list.innerHTML = ""; note.hidden = true; return; }
  wbCurrent = l.path;
  $("ws-browse-current").textContent = l.path;
  // Breadcrumb: split the absolute path into clickable segments.
  const segs = splitPath(l.path);
  $("ws-browse-crumb").innerHTML = segs.map((s, i) =>
    `<button class="ws-browse__crumb-seg" data-path="${esc(s.path)}">${esc(s.name)}</button>`).join(
    `<span class="ws-browse__crumb-sep">›</span>`);
  const rows = [];
  if (l.parent) rows.push(`<button class="ws-browse__row ws-browse__row--up" data-path="${esc(l.parent)}">
      <span class="ws-browse__row-ico">..</span><span class="ws-browse__row-name" data-i18n="ws.browse.up">上一级</span></button>`);
  for (const d of (l.dirs || [])) {
    rows.push(`<button class="ws-browse__row${d.hidden ? " is-hidden" : ""}" data-path="${esc(d.path)}">
        <span class="ws-browse__row-ico">▸</span><span class="ws-browse__row-name">${esc(d.name)}</span></button>`);
  }
  list.innerHTML = rows.join("") || `<div class="ws-browse__empty" data-i18n="ws.browse.empty">此文件夹内没有其他文件夹</div>`;
  if (!l.exists || !l.readable) {
    note.hidden = false;
    note.textContent = l.exists ? t("ws.browse.noaccess") : t("ws.browse.gone");
  } else {
    note.hidden = true;
  }
}
function splitPath(p) {
  // Build [root, ..., folder] with each element carrying its own absolute prefix.
  const norm = String(p || "").replace(/\//g, "\\");
  const out = [];
  let acc = "";
  for (const part of norm.split("\\")) {
    if (!part) {
      if (acc === "") acc = "\\";   // leading "\" => drive-relative root marker
      continue;
    }
    acc = acc ? (acc === "\\" ? "\\" + part : acc + "\\" + part) : part;
    out.push({ name: part, path: acc });
  }
  // Windows drive letter: "C:" -> "C:\"
  if (out.length && /^[A-Za-z]:$/.test(out[0].name)) out[0].path = out[0].name + "\\";
  return out;
}
function wbChoose() {
  if (!wbCurrent) return;
  $("ws-path").value = wbCurrent;   // the real absolute path, always
  updateResolved();
  closeBrowser();
  $("ws-path").focus();
}
$("ws-browse").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-path]");
  if (!btn) return;
  if (e.target.closest(".ws-browse__places") || e.target.closest(".ws-browse__crumb")) {
    // a shortcut or breadcrumb -> jump straight there
    wbLoad(btn.dataset.path);
  } else if (e.target.closest(".ws-browse__list")) {
    wbLoad(btn.dataset.path);       // a folder row -> descend / go up
  }
});
$("ws-browse-close").onclick = closeBrowser;
$("ws-browse-cancel").onclick = closeBrowser;
$("ws-browse-ok").onclick = wbChoose;
// H2: rules-draft approval banner — merge the agent's proposed conventions into RULES.md, or discard.
$("rules-draft-merge").onclick = () => approveRulesDraft([...rulesSel]);
$("rules-draft-discard").onclick = () => discardRulesDraft();
// Expand / collapse the proposal list so the content is reviewable BEFORE approving.
$("rules-draft-peek").onclick = () => {
  const body = $("rules-draft-body"), peek = $("rules-draft-peek");
  const open = body.hidden;
  body.hidden = !open;
  peek.setAttribute("aria-expanded", String(open));
  peek.classList.toggle("rules-draft-banner__txt--open", open);
};
$("rules-draft-body").addEventListener("change", (e) => {
  const all = e.target.closest("[data-rd-all]");
  if (all) {
    rulesSel = all.checked ? new Set(pendingDraft) : new Set();
    renderRulesDraftBody(); syncRulesMergeBtn();
    return;
  }
  const one = e.target.closest("[data-rd-i]");
  if (one) {
    const item = pendingDraft[+one.dataset.rdI];
    if (item == null) return;
    if (one.checked) rulesSel.add(item); else rulesSel.delete(item);
    renderRulesDraftBody(); syncRulesMergeBtn();
  }
});
$("rules-draft-body").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-rd-del]");
  if (!del) return;
  const item = pendingDraft[+del.dataset.rdDel];
  if (item == null) return;
  pendingDraft = pendingDraft.filter((x) => x !== item);
  rulesSel.delete(item);
  const s = activeSession();
  if (s && s.workspace) await fsWrite(`${s.workspace.replace(/\/$/, "")}/RULES.draft.md`, pendingDraft.join("\n"));
  renderRulesDraftBody(); renderRulesBanner(); renderRulesDraftCard();
});
$("design-draft-save").onclick = () => approveDesignDraft();
$("design-draft-discard").onclick = () => discardDesignDraft();
// Expand / collapse a preview of the design body before deciding to save it.
$("design-draft-peek").onclick = () => {
  const body = $("design-draft-body"), peek = $("design-draft-peek");
  const open = body.hidden;
  body.hidden = !open;
  peek.setAttribute("aria-expanded", String(open));
  peek.classList.toggle("rules-draft-banner__txt--open", open);
};
$("design-btn").onclick = () => generateDesignFromChat();
applyInspector();

// ---- P5: collapsible + resizable sidebars, persisted across reloads ----
// Each sidebar remembers both its width and its collapsed (rail) state in localStorage,
// so the next launch restores exactly what the user left.
const RH = {
  side: { min: 180, max: 460, def: 260, wKey: "side.w",      cKey: "side.collapsed", varName: "--side-w", collapsedClass: "side-collapsed", handle: "rh-left" },
  ins:  { min: 220, max: 560, def: 300, wKey: "ins.w",       cKey: "ins.collapsed",  varName: "--ins-w",  collapsedClass: "ins-collapsed",  handle: "rh-right" },
};
function layoutHandles() {
  const rhl = $("rh-left"), rhr = $("rh-right");
  if (rhl) rhl.hidden = document.body.classList.contains("side-collapsed");
  if (rhr) rhr.hidden = document.body.classList.contains("ins-collapsed") || ($("inspector") && $("inspector").hidden);
}
function syncInspectorTitle() {
  const b = $("inspector-collapse");
  if (b) b.title = document.body.classList.contains("ins-collapsed") ? t("insp.expand") : t("insp.collapse");
}
function layoutRestore() {
  for (const k of ["side", "ins"]) {
    const c = RH[k];
    let w = store.get(c.wKey, c.def);
    if (typeof w !== "number" || Number.isNaN(w)) w = c.def;
    w = Math.max(c.min, Math.min(c.max, w));
    document.documentElement.style.setProperty(c.varName, w + "px");
    document.body.classList.toggle(c.collapsedClass, !!store.get(c.cKey, false));
  }
  layoutHandles(); syncInspectorTitle();
}
function makeResizer(side) {
  const cfg = RH[side];
  const h = $(cfg.handle);
  if (!h) return;
  const isLeft = h.dataset.side === "left";
  cfg._w = parseFloat(document.documentElement.style.getPropertyValue(cfg.varName)) || cfg.def;
  h.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX, startW = cfg._w;
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    h.classList.add("rh--active");
    document.body.classList.add("resizing");
    const move = (ev) => {
      const dx = ev.clientX - startX;
      let w = isLeft ? startW + dx : startW - dx;
      cfg._w = Math.max(cfg.min, Math.min(cfg.max, w));
      document.documentElement.style.setProperty(cfg.varName, cfg._w + "px");
    };
    const up = () => {
      try { h.releasePointerCapture(e.pointerId); } catch (_) {}
      h.classList.remove("rh--active");
      document.body.classList.remove("resizing");
      h.removeEventListener("pointermove", move);
      h.removeEventListener("pointerup", up);
      h.removeEventListener("pointercancel", up);
      store.set(cfg.wKey, cfg._w);
    };
    h.addEventListener("pointermove", move);
    h.addEventListener("pointerup", up);
    h.addEventListener("pointercancel", up);
  });
  // double-click the handle to snap back to the default width
  h.addEventListener("dblclick", () => {
    cfg._w = cfg.def;
    document.documentElement.style.setProperty(cfg.varName, cfg.def + "px");
    store.set(cfg.wKey, cfg.def);
  });
}
layoutRestore();
makeResizer("side");
makeResizer("ins");
// Bottom-bar permission selector: reflects the active session's tier and switches it live.
function syncPermSelect() {
  const sel = $("perm-select");
  if (sel) sel.value = sessionPerm(activeSession() || {});
}
$("perm-select").onchange = () => {
  const s = activeSession();
  if (!s) return;
  s.permission = $("perm-select").value;
  saveSessions(); renderSessions(); syncPermSelect();
  toast("info", "权限已切换为「" + ({full: "完全访问", auto: "自动审核", manual: "手动审批"}[$("perm-select").value]) + "」");
};
renderSessions();
syncPermSelect();

function saveChat() {
  const s = activeSession();
  const data = messages.map((m) => ({...m, images: (m.images || []).map((i) => Object.assign({name: i.name, pid: i.pid}, i.kind ? {kind: i.kind} : {}, Object.assign({}, i.ref ? {ref: i.ref} : {}, i.url ? {url: i.url} : {}))),
                                      files: (m.files || []).map((f) => ({name: f.name}))}));
  if (s) { s.messages = data; s.updatedAt = Date.now(); }   // drives the sidebar's "3分钟前"
  store.set("chat", data);   // backward-compatible fallback
  store.set("branches", branches);
  store.set("liveMessages", liveMessages);
  store.set("activeBranch", activeBranchId);
  saveSessions();
}
function timeStr(t) { return new Date(t).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}); }

function msgEl(m, i) {
  const el = document.createElement("div");
  el.className = `st-msg st-msg--${m.role}`;
  el.dataset.i = i;
  if (m.role === "user") {
    if (m.files && m.files.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const f of m.files) {
        const c = document.createElement("span");
        c.className = "chip";
        c.innerHTML = icon("attach", "st-icon st-icon--sm");
        c.append(f.name);
        wrap.appendChild(c);
      }
      el.appendChild(wrap);
    }
    if (m.images && m.images.length && !mixedSegments(m)) {
      const wrap = document.createElement("div");
      wrap.className = "msg-images";
      for (const im of m.images) {
        if (im.ref || im.url) { const img = document.createElement("img"); img.src = im.ref || im.url; img.alt = im.name || "image"; img.className = "msg-img"; img.title = t("img.view"); if (im.ref && im.url) { img.dataset.fb = im.url; img.onerror = function(){ if (!this.dataset.fbDone) { this.dataset.fbDone = "1"; this.src = this.dataset.fb; } }; } wrap.appendChild(img); }
        else { const c = document.createElement("span"); c.className = "chip"; c.innerHTML = icon("image", "st-icon st-icon--sm"); c.append(im.name || "image"); wrap.appendChild(c); }
      }
      el.appendChild(wrap);
    }
    const b = document.createElement("div");
    b.className = "st-bubble";
    const mseg = mixedSegments(m);
    if (mseg) {
      // placeholders present: lay text and images out interleaved, exactly where the user placed
      // them -- INCLUDING their newlines. The whitespace at a segment boundary is what the
      // placeholder anchor stood for: a real newline there becomes a <br> between the nodes,
      // a spaces-only junction keeps everything on the SAME line (single line in -> one line out).
      let _prevSeg = null;
      for (const sg of mseg) {
        if (_prevSeg) {
          const _ws = (sg.type === "image" ? "" : (sg.text.match(/^\s*/) || [""])[0])
                    + (_prevSeg.type === "image" ? "" : ((_prevSeg.text.match(/\s*$/) || [""])[0]));
          if (_ws.indexOf("\n") >= 0) b.appendChild(document.createElement("br"));
        }
        if (sg.type === "image") {
          const img = document.createElement("img");
          img.src = sg.url; img.alt = sg.name || "image"; img.className = "inline-msg-img"; img.title = t("img.view"); if (sg.url !== sg.wire) { img.dataset.fb = sg.wire; img.onerror = function(){ if (!this.dataset.fbDone) { this.dataset.fbDone = "1"; this.src = this.dataset.fb; } }; }
          b.appendChild(img);
        } else {
          const span = document.createElement("span");
          span.innerHTML = markdown(sg.text, true);
          b.appendChild(span);
        }
        _prevSeg = sg;
      }
    } else {
      b.textContent = m.text;
    }
    el.appendChild(b);
    const meta = document.createElement("div");
    meta.className = "st-msg__meta";
    meta.textContent = `${t("chat.you")} · ${timeStr(m.time)}`;
    el.appendChild(meta);
    const acts = document.createElement("div");
    acts.className = "st-msg__actions";
    acts.innerHTML = `<button class="st-btn st-btn--icon" data-action="copy" aria-label="${esc(t("ctx.copy"))}" title="${esc(t("ctx.copy"))}">${icon("copy")}</button>` +
      `<button class="st-btn st-btn--icon" data-action="edit" aria-label="${esc(t("ctx.edit"))}" title="${esc(t("ctx.edit"))}">${icon("edit")}</button>` +
      `<button class="st-btn st-btn--icon st-btn--danger" data-action="delete" aria-label="${esc(t("ctx.delete"))}" title="${esc(t("ctx.delete"))}">${icon("trash")}</button>`;
    el.appendChild(acts);
  } else {
    el.innerHTML = `<div class="st-bubble"></div><div class="next-steps" hidden></div><div class="proposals" hidden></div><div class="st-msg__meta"><span class="meta-text"></span>` +
      `<span class="msg-stats" hidden></span>` +
      `<button class="st-btn continue-btn" data-action="continue" hidden>继续</button>` +
      `<button class="st-btn msg-fold" data-action="fold" hidden></button>` +
      `<button class="st-btn st-btn--icon" data-msg-copy aria-label="${esc(t("ctx.copy.answer"))}" title="${esc(t("ctx.copy.answer"))}">${icon("copy")}</button>` +
      `<button class="st-btn st-btn--icon" data-action="regen" aria-label="${esc(t("ctx.regen"))}" title="${esc(t("ctx.regen"))}">${icon("regenerate")}</button>` +
      `<button class="st-btn st-btn--icon st-btn--danger" data-action="delete" aria-label="${esc(t("ctx.delete"))}" title="${esc(t("ctx.delete"))}">${icon("trash")}</button></div>`;
    updateAssistant(el, m, false);
  }
  return el;
}
// One MCP tool call in the answer: a compact block (name, state, a one-line preview) that opens to the arguments and
// the result as the model read it.  Its body is built only while open: a result can be 20,000 characters.
// NOTE: a streaming turn repaints this block tens of times per second. It is therefore built ONCE and then
// patched in place (patchTool). Rebuilding the <details> every frame recreated the status badge, which
// restarted its `blink` keyframes mid-cycle — the badges visibly strobed — and also threw away the open
// state and the user's text selection inside the block.
// Live "timeout-wait" timer for running tools. The idle ceiling is NOT hardcoded: it is synced from the
// backend runtime config (GET /api/runtime-config -> idle_timeout_s, see http_server.py), so the countdown
// always matches the real watchdog that auto-cuts the turn with a recoverable strata_notice once no token /
// tool progress / result arrives for that long. Falls back to 180s only when the endpoint is unavailable
// (proxy mode / older server). WARN/DANGER thresholds below are ratios of this live value.
let idleTimeoutS = 180;   // live; synced from /api/runtime-config (idle_timeout_s). Never edit by hand.
const TOOL_TIMER_WARN_AT = 0.6;     // 108s: amber "无新进度"
const TOOL_TIMER_DANGER_AT = 0.9;   // 162s: red pulse "即将超时"
const TOOL_TIMER_MIN_S = 2;         // hide for tools that finish in <2s (no flicker)
const TOOL_STATE = {writing: "st-badge--reading", running: "st-badge--generating", done: "",
                    error: "st-badge--error", skipped: "st-badge--queued"};
const TOOL_STATE_LABEL = {writing: "tool.state.writing", running: "tool.state.running", done: "tool.state.done",
                          error: "mon.state.error", skipped: "tool.state.skipped"};
function toolArgs(tool) { return tool.arguments == null ? "" : JSON.stringify(tool.arguments, null, 2); }
function toolPreview(tool) {
  return (tool.result != null ? String(tool.result) : toolArgs(tool).replace(/\s+/g, " ")).slice(0, 200);
}
function toolBadge(tool) {
  return {cls: TOOL_STATE[tool.state] || "",
          label: TOOL_STATE_LABEL[tool.state] ? t(TOOL_STATE_LABEL[tool.state]) : String(tool.state)};
}
function toolMs(tool) { return tool.ms != null && tool.state !== "skipped" ? `${fmt(tool.ms / 1000, 1)} s` : ""; }
// the body is built only while open: a result can be 20,000 characters
function toolBodyHtml(tool) {
  if (!tool.open) return "";
  let body = `<div class="tool-call__label">${t("tool.arguments")}</div><pre class="tool-call__pre">${esc(toolArgs(tool) || t("tool.writing.args"))}</pre>`;
  if (tool.result != null) {
    // 2026-10-27: three-state label (A+B root-cause fix). A running/progress
    // tool is NOT an error -- it turns red only when the result event comes back
    // with ok===false. The old binary `tool.ok ? result : error` read a LIVE
    // progress append (ok still undefined, state running) as red, which is
    // exactly the bug in the screenshot.
    const lbl = tool.state === "running" ? t("tool.state.running")
          : tool.ok === false ? t("mon.state.error") : t("tool.result");
    body += `<div class="tool-call__label">${lbl}${tool.chars ? ` · ${t("tool.chars", {n: fmt(tool.chars)})}` : ""}` +
            `${tool.skipreason ? " · " + t("tool.cut_argtrunc") : (tool.truncated ? ", " + t("tool.cut") : "")}</div><pre class="tool-call__pre">${esc(tool.result)}</pre>`;
  }
  return body;
}
// Every patchable part is ALWAYS present in the markup (server / milliseconds too), so patchTool can update
// them in place instead of falling back to a rebuild when a field appears late.
function toolHtml(tool, k, seq) {
  const b = toolBadge(tool), ms = toolMs(tool);
  const seqTxt = seq ? t("tool.seq", {i: seq.i, n: seq.n}) : "";
  return `<details class="st-collapse tool-call" data-tool="${k}" data-state="${esc(tool.state)}" data-same="${seq && seq.i > 1 ? 1 : 0}"${tool.open ? " open" : ""}>` +
    `<summary>${icon("tool", "st-icon st-icon--sm")}<span class="tool-call__name" title="${esc(tool.name || "")}">${esc(tool.tool || tool.name || "tool")}</span>` +
    `<span class="muted small tool-call__seq"${seq ? "" : " hidden"}>${esc(seqTxt)}</span>` +
    `<span class="muted small tool-call__srv"${tool.server ? "" : " hidden"}>${esc(tool.server || "")}</span>` +
    `<span class="tool-call__preview muted">${esc(toolPreview(tool))}</span>` +
    `<span class="st-badge ${b.cls}">${esc(b.label)}</span>` +
    `<span class="muted small tool-call__ms"${ms ? "" : " hidden"}>${esc(ms)}</span>` +
    `<span class="tool-call__timer" hidden><span class="tool-call__t-text"></span><span class="tool-call__t-bar"><i></i></span></span>` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary><div class="st-collapse__body">${toolBodyHtml(tool)}</div></details>`;
}
// Bring an existing tool block up to date without recreating it: the badge element (and any CSS animation
// running on it) survives, so a long task no longer flickers. A signature skips the whole work when nothing
// changed — most frames only append one token of text.
function patchTool(node, tool, k, seq) {
  const sig = `${tool.state}|${tool.ms}|${tool.ok}|${tool.chars}|${tool.truncated}` +
              `|${tool.result == null ? -1 : String(tool.result).length}|${tool.open ? 1 : 0}` +
              `|${tool.name}|${tool.server}|${tool.tool}|${seq ? seq.i + "/" + seq.n : ""}`;
  if (node._sig === sig) return;
  node._sig = sig;
  node.dataset.state = tool.state;
  node.dataset.same = seq && seq.i > 1 ? "1" : "0";
  // timeout-wait timer: seed the start clock on first running frame; clear it once the tool leaves running
  // (done/error/skipped) so a later retry starts fresh and the live ticker stops touching a finished card.
  const timerEl = node.querySelector(".tool-call__timer");
  if (timerEl) {
    if (tool.state === "running") {
      if (node._t0 == null) node._t0 = Date.now();
    } else {
      if (!timerEl.hidden) timerEl.hidden = true;
      node._t0 = null;
    }
  }
  const sq = node.querySelector(".tool-call__seq"), st = seq ? t("tool.seq", {i: seq.i, n: seq.n}) : "";
  if (sq) {
    if (sq.textContent !== st) sq.textContent = st;
    if (sq.hidden === !!seq) sq.hidden = !seq;
  }
  if (node.open !== !!tool.open) node.open = !!tool.open;
  const sum = node.querySelector("summary");
  if (!sum) return;
  const b = toolBadge(tool), badge = sum.querySelector(".st-badge");
  if (badge) {
    const cls = `st-badge ${b.cls}`.trim();
    if (badge.className !== cls) badge.className = cls;
    if (badge.textContent !== b.label) badge.textContent = b.label;
  }
  const nm = sum.querySelector(".tool-call__name");
  if (nm) {
    const label = tool.tool || tool.name || "tool";
    if (nm.textContent !== label) { nm.textContent = label; nm.title = tool.name || ""; }
  }
  const srv = sum.querySelector(".tool-call__srv");
  if (srv) {
    if (srv.textContent !== (tool.server || "")) srv.textContent = tool.server || "";
    if (srv.hidden === !!tool.server) srv.hidden = !tool.server;
  }
  const pv = sum.querySelector(".tool-call__preview"), preview = toolPreview(tool);
  if (pv && pv.textContent !== preview) pv.textContent = preview;
  const msEl = sum.querySelector(".tool-call__ms"), ms = toolMs(tool);
  if (msEl) {
    if (msEl.textContent !== ms) msEl.textContent = ms;
    if (msEl.hidden === !!ms) msEl.hidden = !ms;
  }
  const bodyEl = node.querySelector(".st-collapse__body");
  const bsig = tool.open
    ? `o|${tool.ok}|${tool.chars}|${tool.truncated}|${tool.result == null ? -1 : String(tool.result).length}|${toolArgs(tool)}`
    : "c";
  if (bodyEl && node._bsig !== bsig) { node._bsig = bsig; bodyEl.innerHTML = toolBodyHtml(tool); }
}
// Live timeout-wait timer for running tools, driven by the per-turn liveTimer (500ms). Mutates ONLY the
// timer chip's text + bar width in place (never rebuilds innerHTML) so it can't strobe. Two clocks:
//   elapsed = now - node._t0            how long THIS tool has been running
//   idle    = now - m._lastActivityAt   since the last token / tool progress anywhere in the turn
// idle is the meaningful "about to be killed" signal because the backend idle watchdog (180s) is touched by
// ANY progress; elapsed alone can't tell "working" from "stuck". Last-activity is tracked turn-level in the
// streaming loop (m._lastActivityAt) on every token and every strata_mcp event.
function tickToolTimers(root, m) {
  if (!root) return;
  const now = Date.now();
  const last = (m && m._lastActivityAt) || now;
  const nodes = root.querySelectorAll('.tool-call[data-state="running"]');
  for (const node of nodes) {
    if (node._t0 == null) node._t0 = now;
    const elapsed = (now - node._t0) / 1000;
    if (elapsed < TOOL_TIMER_MIN_S) continue;                 // hide for fast tools (no flicker)
    const idle = (now - last) / 1000;
    const rem = idleTimeoutS - idle;
    const timer = node.querySelector(".tool-call__timer");
    if (!timer) continue;
    timer.hidden = false;
    let cls = "", txt;
    if (idle >= TOOL_TIMER_DANGER_AT * idleTimeoutS) {
      cls = " tool-call__timer--danger";
      txt = t("tool.timer.danger", {rem: Math.max(0, Math.round(rem)), max: idleTimeoutS});
    } else if (idle >= TOOL_TIMER_WARN_AT * idleTimeoutS) {
      cls = " tool-call__timer--warn";
      txt = t("tool.timer.warn", {idle: Math.round(idle), max: idleTimeoutS});
    } else {
      txt = t("tool.timer.run", {s: Math.round(elapsed)});
    }
    const want = "tool-call__timer" + cls;
    if (timer.className !== want) timer.className = want;
    const ttext = timer.querySelector(".tool-call__t-text");
    if (ttext && ttext.textContent !== txt) ttext.textContent = txt;
    const bar = timer.querySelector(".tool-call__t-bar > i");
    if (bar) {
      const w = Math.max(0, Math.min(100, (idle / idleTimeoutS) * 100)).toFixed(1) + "%";
      if (bar.style.width !== w) bar.style.width = w;
    }
  }
}
// The answer's DOM is a sequence of segments (a reasoning chunk / a markdown chunk / a tool block / …) laid out in
// the order they really happened, so a turn reads as ONE timeline: the thought that led to an action sits next to
// that action.  Only the trailing chunk changes while text streams, so the bubble is still reconciled segment by
// segment instead of being rebuilt wholesale (which is what made badges strobe and cost O(n) DOM churn per frame).
//
// A tool records where it happened in BOTH streams: `at` = offset in the answer text, `rat` = offset in the
// reasoning.  Those two offsets are what let a thought and the call it triggered sit side by side.
// A raw offset cuts wherever the model happened to be when it called the tool - often mid-sentence, which then
// ends up split across the tool block ("…只是默认" | tool | "值。三个文件…"). Snap forward to the end of that
// sentence instead, but never past the next tool's boundary, so no segment can swallow another's text.
function snapSent(src, to, limit) {
  for (let i = to; i <= limit; i++) {
    const c = src[i - 1];
    if (c === "\n" || "。！？!?；;".includes(c)) return i;
  }
  return to;
}
function answerSpec(m) {
  const text = m.text || "", reas = m.reasoning || "", tools = m.tools || [], spec = [];
  let tp = 0, rp = 0;
  const think = (end, k) => { if (end > rp) spec.push({slot: `th${k}`, think: reas.slice(rp, end)}); rp = end; };
  const md = (end, k) => { if (end > tp) spec.push({slot: `md${k}`, src: text.slice(tp, end)}); tp = end; };
  tools.forEach((tool, k) => {
    // answer text first, then the thought: that order keeps a thought glued to the call it produced
    // (…, md, th, tool, …) instead of letting an unrelated chunk of prose slide in between.
    md(Math.min(Math.max(tool.at || 0, tp), text.length), k);
    const next = k + 1 < tools.length ? Math.max(tools[k + 1].rat || 0, rp) : reas.length;
    const raw = Math.min(Math.max(tool.rat || 0, rp), reas.length);
    think(Math.max(snapSent(reas, raw, Math.min(next, reas.length)), rp), k);
    spec.push({slot: `t${k}`, tool, k, seq: toolSeq(tools, k)});
  });
  think(reas.length, tools.length);
  // the trailing markdown node always exists: it hosts the streaming caret even before the first token arrives
  spec.push({slot: `md${tools.length}`, src: text.slice(tp)});
  return spec;
}
function mdNode(src, slot) {
  const d = document.createElement("div");
  d.className = "ans-md"; d.dataset.slot = slot; d._src = src;
  d.innerHTML = markdown(src);
  return d;
}
function toolNode(tool, k, slot, seq) {
  const tpl = document.createElement("template");
  tpl.innerHTML = toolHtml(tool, k, seq).trim();
  const node = tpl.content.firstElementChild;
  node.dataset.slot = slot;
  patchTool(node, tool, k, seq);         // seeds node._sig so the next frame is a no-op
  return node;
}
// A burst of identical calls (three file reads in a row) is labelled "2/3" instead of reading as loose blocks.
function toolSeq(tools, k) {
  const a = tools[k], same = (b) => !!b && b.tool === a.tool && b.server === a.server;
  let i = 1, n = 1;
  for (let j = k - 1; j >= 0 && same(tools[j]); j--) { i++; n++; }
  for (let j = k + 1; j < tools.length && same(tools[j]); j++) n++;
  return n > 1 ? {i, n} : null;
}

// ------------------------------------------------------------------ Thoughts (reasoning segments)
// One reasoning segment: collapsed it shows a one-line summary (so a finished turn stays scannable), open it
// shows the thought itself.  The live segment opens while it streams and closes once the turn moves on —
// which is what keeps "the wall of thinking" from taking over the screen.
const THINK_LONG = 900;                                  // above this a thought is titled "深度思考"
function thinkPeek(src) {                                // collapsed one-liner: the first sentence, at most ~90 chars
  // Skip fenced code when picking the one-liner: a thought that opens with a ```js dump would otherwise
  // summarise itself as "const opt = (oi != null …", which tells the reader nothing.
  let inFence = false, first = "";
  for (const line of String(src || "").split("\n")) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (line.trim()) { first = line; break; }
  }
  const s = (first || String(src || "")).replace(/\s+/g, " ").trim();
  const head = s.slice(0, 90);
  const m = head.match(/^[\s\S]*?[。！？!?；;\n]/);
  return ((m ? m[0] : head).trim() || head).trim();
}
function thinkOpen(m, slot, live, isLatest) {
  if (m.thinkOpen && m.thinkOpen[slot] !== undefined) return !!m.thinkOpen[slot];  // a manual toggle wins
  if ((live || isLatest) && settings.show !== false) return true;  // the live thought and the latest message follow the show switch
  return false;                                                  // older turns stay folded
}
// Gate B (2026-11-04): the thought box is the only place a small quantised model's degenerate echo
// shows up -- the SAME line emitted several times in a row. Fold a run of >=3 identical non-empty
// lines to a single line, right before the paint, so a reader sees it once. A run of <3 is left
// untouched, so a model that legitimately repeats a 1-2 line action stays verbatim. Pure string work
// (no fence parsing here -- thinkRich handles fences after this); deterministic, input-determined output.
function dedupeThink(src) {
  const MIN_RUN = 3;
  const lines = String(src || "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i];
    if (t.trim() === "") { out.push(t); i++; continue; }          // blank lines pass through untouched
    let j = i;
    while (j < lines.length && lines[j] === t) j++;                // exact-identical run only
    if (j - i >= MIN_RUN) out.push(t);                             // fold the whole run to one line
    else { for (let k = i; k < j; k++) out.push(lines[k]); }        // <3 identical: keep verbatim
    i = j;
  }
  return out.join("\n");
}
// Thinking is mostly prose, but a model that is debugging pastes code into it — and a raw ```js dump in a
// pre-wrap box is unreadable. Split the thought on fences and give each block the same .st-code card the
// answer body uses (dark surface + language label + copy + highlighting); prose keeps its plain pre-wrap.
function thinkRich(src) {
  const txt = (s) => {
    const x = s.replace(/^\n+|\n+$/g, "");
    return x.trim() ? `<div class="st-think__txt">${esc(x)}</div>` : "";
  };
  let html = "", rest = String(src || "");
  for (;;) {
    const m = rest.match(/(^|\n)```([^\n`]*)\n/);
    if (!m) { html += txt(rest); break; }
    html += txt(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const end = rest.match(/(^|\n)```[ \t]*(\n|$)/);
    if (!end) { html += codeBlock(m[2].trim(), rest); break; }        // fence still streaming: render it open
    html += codeBlock(m[2].trim(), rest.slice(0, end.index));
    rest = rest.slice(end.index + end[0].length);
  }
  return html;
}
const THINK_RENDER_MS = 70;                              // throttle the rich repaint while tokens arrive
function paintThink(body, src, live) {
  if (body._src === src) return;
  // Streaming repaints every ~70ms instead of every token (highlighting a 5k-char thought per chunk is
  // wasted work); the final flush always lands because live flips to false at end of turn.
  if (live && body._at && performance.now() - body._at < THINK_RENDER_MS) return;
  body._at = performance.now();
  body._src = src;
  const keep = body.scrollTop;                            // never yank a reader back to the top
  body.innerHTML = thinkRich(dedupeThink(src));   // Gate B: fold >=3 identical lines before paint
  if (keep) body.scrollTop = keep;
}function thinkHtml(src, slot) {
  return `<details class="st-collapse st-think" data-slot="${esc(slot)}" data-state="">` +
    `<summary>${icon("thinking", "st-icon st-icon--sm")}<span class="st-think__title"></span>` +
    `<span class="st-think__peek muted"></span>` +
    `<span class="muted small st-think__chars"></span>` +
    `${icon("chevron", "st-icon st-icon--sm st-chev")}</summary>` +
    `<div class="st-collapse__body thinking"></div></details>`;
}
function thinkNode(src, slot) {
  const tpl = document.createElement("template");
  tpl.innerHTML = thinkHtml(src, slot).trim();
  const node = tpl.content.firstElementChild;
  node.dataset.slot = slot;

  return node;
}
// Same contract as patchTool: never rebuild the node (that would restart the caret/badge animations and drop
// the user's selection); update the few parts that can change, and only when the signature really moved.
function patchThink(node, src, m, slot, live, isLatest) {
  const open = thinkOpen(m, slot, live, isLatest), long = src.length > THINK_LONG;
  const sig = `${src.length}|${open ? 1 : 0}|${long ? 1 : 0}|${live ? 1 : 0}`;
  if (node._sig === sig) return;
  node._sig = sig;
  node._src = src;
  node.dataset.long = long ? "1" : "0";
  node.dataset.state = live ? "live" : "";
  // A browser fires `toggle` for OUR change too. Remember what we asked for: the handler then tells our own
  // change (open === _want) apart from the user's (open !== _want) instead of locking the auto-fold forever.
  node._want = open;
  if (node.open !== open) node.open = open;
  const title = live ? t("chat.thinking") : long ? t("think.deep") : t("chat.thoughts");
  const te = node.querySelector(".st-think__title");
  if (te && te.textContent !== title) te.textContent = title;
  const pe = node.querySelector(".st-think__peek"), peek = thinkPeek(src);
  if (pe && pe.textContent !== peek) pe.textContent = peek;
  const ce = node.querySelector(".st-think__chars"), chars = t("think.chars", {n: src.length});
  if (ce && ce.textContent !== chars) ce.textContent = chars;
  const body = node.querySelector(".st-collapse__body");
  if (body && open) paintThink(body, src, live);
}
// Paint one markdown chunk: full re-render while short, and for very long streaming output keep a committed
// prefix (re-parsed only when the live window moves) plus a freshly parsed tail.
function paintMd(node, src, streaming) {
  if (!streaming || src.length <= MARKDOWN_LONG) {
    if (node._src === src) return;
    node._src = src; node._pb = null;
    node.innerHTML = markdown(src);
    return;
  }
  const now = performance.now();
  if (node._at && now - node._at < STREAM_RENDER_MS && node._len === src.length) return;
  node._at = now; node._len = src.length; node._src = src;
  const cut = safeCut(src, Math.max(0, src.length - MARKDOWN_TAIL));
  const prefix = src.slice(0, cut), tail = src.slice(cut);
  let prefixHtml;
  if (node._pb && node._pb.text === prefix) prefixHtml = node._pb.html;
  else { prefixHtml = markdown(prefix); node._pb = {text: prefix, html: prefixHtml}; }
  node.innerHTML = prefixHtml + markdown(tail);
}
// a tool event from the stream (the `strata_mcp` field of a chunk)
function onTool(m, x) {
  if (x.event === "limit") { m.limit = x.max_rounds; m.canContinue = true; return; }
  m.tools = m.tools || [];
  let t = m.tools.find((y) => y.id === x.id);
  if (!t) { t = {id: x.id, name: x.name, at: m.text.length, rat: m.reasoning.length, state: "writing"}; m.tools.push(t); }
  noteStreamPhase(m, "tool", t.name || x.name || x.tool);   // interruption log: which tool was alive
  if (x.event === "call") {
    Object.assign(t, {name: x.name, server: x.server, tool: x.tool, arguments: x.arguments, round: x.round, state: "running"});
    if (!t._userTouched) t.open = true;            // expand while it runs so the user sees live activity
  } else if (x.event === "progress") {
    // Live incremental output from a long-running tool (e.g. a slow shell command).
    // Append to the result area so the user sees it stream; the final `result` event
    // overwrites with the authoritative full text, so there is no duplication.
    t.state = "running";
    t.result = (t.result || "") + (x.text || "");
    if (!t._userTouched) t.open = true;
  } else if (x.event === "result") {
    Object.assign(t, {result: x.text, ok: x.ok, chars: x.chars, truncated: x.truncated, ms: x.ms,
                      state: x.skipped ? "skipped" : x.ok ? "done" : "error"});
                      t.skipreason = x.skipreason || null;
    if (!t._userTouched) t.open = false;           // collapse once it finishes (unless the user pinned it open)
  }
}
// --- "下一步建议": the model ends a finished task with a fenced ```next-steps block -> clickable chips ---
// Chips TOGGLE a selection (click again to unselect); the action row then sends the picked
// items as ONE combined message, so several suggestions can be run in a single turn.
// Parses a fenced ```next-steps block into clickable suggestion chips. A leading "*" (or "•") on a
// line marks the AI's *recommended* item: it is surfaced first (with an emerald dot) and is what the
// autonomous auto-drive picks by default. Other leading bullets (+ - –) are stripped harmlessly.
function extractNextSteps(text) {
  const m = (text || "").match(/```next-steps\s*\n([\s\S]*?)```/i);
  if (!m) return {text: text || "", steps: []};
  const steps = [];
  for (const raw of m[1].split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let recommended = false, avoid = false, hold = false;
    let body = trimmed.replace(/^\?\s*/, () => { hold = true; return ""; }).trim();   // "?" = 列给您看但 AI 等您答，不自动跑
    body = body.replace(/^[\*\u2022]+\s*/, () => { recommended = true; return ""; }).trim();
    body = body.replace(/^[!✗×x]+\s*/i, () => { avoid = true; return ""; }).trim();   // "!" = AI does NOT advise (risky / net-negative)
    body = body.replace(/^[\+\-–]+/, "").trim();     // remaining bullet chars (not the recommend marker)
    if (!body) continue;
    const i = body.indexOf("："), j = body.indexOf(":");
    const sep = i > 0 && (j < 0 || i < j) ? i : (j > 0 ? j : -1);
    steps.push(sep > 0
      ? {label: body.slice(0, sep).trim(), detail: body.slice(sep + 1).trim(), recommended, avoid, hold}
      : {label: body, detail: "", recommended, avoid, hold});
  }
  return {text: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), steps};
}
// Pure: compose the picked suggestions (and any text the user typed) into one user message.
// A single pick with no custom text keeps the exact old wording (label：detail); several picks become a
// numbered batch; typed instructions ride along as a closing "另外：…" paragraph either way.
function composeStepsMessage(steps, idxs, extra) {
  const picked = (idxs || []).map((i) => steps[i]).filter(Boolean);
  const typed = String(extra || "").trim();
  if (!picked.length) return typed;
  // C-tier: a "?" chip click means "confirmed, proceed with your default" — the sent text
  // must read as a decision, not a question, so the model does not re-ask.
  const line = (s) => s.hold
    ? `${t("nextsteps.hold.confirm")} ${s.detail ? `${s.label}：${s.detail}` : s.label}`
    : (s.detail ? `${s.label}：${s.detail}` : s.label);
  const anyExec = picked.some((s) => !s.hold);
  let body;
  if (picked.length === 1) {
    body = anyExec ? `${t("nextsteps.exec.prefix")} ${line(picked[0])}` : line(picked[0]);
  } else {
    body = t("nextsteps.combo") + "\n" + picked.map((s, i) => `${i + 1}. ${line(s)}`).join("\n");
    if (anyExec) body += `\n\n${t("nextsteps.exec.prefixAll")}`;
  }
  return typed ? `${body}\n\n${t("nextsteps.extra", {text: typed})}` : body;
}
// The send button says whether the typed text will be attached, so "多选 + 自定义一句话" is predictable.
function syncStepsSendLabel() {
  const b = document.querySelector("[data-steps-send]");
  if (!b) return;
  const n = +b.dataset.n || 0;
  const typedRaw = ceText($("input"));
  const typed = !!typedRaw;
  const txt = typed ? t("nextsteps.send.custom", {n}) : t("nextsteps.send.n", {n});
  if (b.textContent !== txt) b.textContent = txt;
  // Live preview so "select a chip, then type" is visible right away -- the gap that made people
  // think custom text was not allowed. Independent of any IME event: whatever lands in the composer shows here.
  const prev = document.querySelector(".next-steps__custom");
  if (prev) {
    const clip = typedRaw.length > 24 ? typedRaw.slice(0, 24) + "…" : typedRaw;
    prev.textContent = typed ? t("nextsteps.custom.preview", {text: clip}) : "";
    prev.hidden = !typed;
  }
}
// Send the selected suggestions of one message as a single combined turn, keeping whatever the user typed
// in the composer as an extra instruction instead of overwriting it.
function sendSelectedSteps(mm, human = true) {
  if (busy || !mm || !mm.selSteps || !mm.selSteps.length) return;
  const text = composeStepsMessage(mm.steps, [...mm.selSteps].sort((a, b) => a - b), ceText($("input")));
  if (!text.trim()) return;
  mm.selSteps = [];
  const host = $("chat").querySelector(`.st-msg[data-i="${messages.indexOf(mm)}"]`);
  if (host) renderNextSteps(host, mm);
  ceSetText($("input"), text);
  send(human);
}
function renderNextSteps(el, m) {
  const box = el.querySelector(".next-steps");
  if (!box) return;
  if (m.steps && m.steps.length) {
    box.hidden = false;
    if (!m.selSteps) m.selSteps = [];              // selection lives on the message (survives re-render)
    const sel = new Set(m.selSteps);
    // Three tiers, each a separate group so the colour system stays distinct:
    //   recommended -> "推荐建议" (green, top), optional -> "下一步建议" (gray, middle),
    //   avoid       -> "不推荐建议" (amber, bottom). Selection stores ORIGINAL indices (data-step),
    //   so grouping only reorders the DOM — the selected-set still maps back into m.steps.
    const recs = [], rest = [], avoid = [], hold = [];
    m.steps.forEach((s, i) => (s.recommended ? recs : s.avoid ? avoid : s.hold ? hold : rest).push({s, i}));
    const hasRec = recs.length > 0, hasRest = rest.length > 0, hasAvoid = avoid.length > 0, hasHold = hold.length > 0;

    const chip = ({s, i}) => {
      const on = sel.has(i);
      let tier = "", badge = "";
      if (s.recommended) { tier = " next-step--rec";    badge = `<span class="next-step__badge">${esc(t("nextsteps.badge"))}</span>`; }
      else if (s.avoid)  { tier = " next-step--avoid"; badge = `<span class="next-step__badge next-step__badge--avoid">${esc(t("nextsteps.avoid.badge"))}</span>`; }
      else if (s.hold)   { tier = " next-step--hold";  badge = `<span class="next-step__badge next-step__badge--hold">${esc(t("nextsteps.hold.badge"))}</span>`; }
      else               { tier = " next-step--rest"; }                              // 普通档橙 chip（自动跑）
      const chk = on ? '<svg class="st-icon st-icon--sm"><use href="web/sprite.svg#i-check"/></svg>' : "";
      return `<button type="button" class="next-step${on ? " next-step--on" : ""}${tier}" data-step="${i}"` +
        ` aria-pressed="${on}" title="${esc(s.detail ? `${s.label}：${s.detail}` : s.label)}">` +
        badge + chk + `<span class="next-step__label">${esc(s.label)}</span></button>`;
    };
    // kind -> colour system + i18n keys; solo = no recommended items at all (neutral "建议下一步")
    const group = (kind, items) => {
      const cls = kind === "rec" ? " next-steps__group--rec"
                : kind === "avoid" ? " next-steps__group--avoid"
                : kind === "hold" ? " next-steps__group--hold"
                : " next-steps__group--rest";
      const tt = t(`nextsteps.${kind}.title`), sb = t(`nextsteps.${kind}.sub`);
      return `<span class="next-steps__group${cls}">` +
        `<span class="next-steps__title">${esc(tt)}</span>` +
        (sb ? `<span class="next-steps__sub">${esc(sb)}</span>` : "") +
        `<span class="next-steps__chips">` + items.map(chip).join("") + `</span></span>`;
    };

    let html = "";
    if (hasRec)   html += group("rec", recs);
    if (hasRest)  html += group(hasRec ? "more" : "solo", rest);
    if (hasHold)  html += group("hold", hold);
    if (hasAvoid) html += group("avoid", avoid);

    html += sel.size
      ? `<span class="next-steps__acts">` +
        `<button type="button" class="st-btn st-btn--primary st-btn--sm" data-steps-send data-n="${sel.size}">${esc(t("nextsteps.send.n", {n: sel.size}))}</button>` +
        `<button type="button" class="st-btn st-btn--ghost st-btn--sm" data-steps-clear>${esc(t("nextsteps.clear"))}</button>` +
        `<span class="next-steps__custom"></span></span>`
      : "";
    box.innerHTML = html;
    syncStepsSendLabel();                          // reflect typed text ("+ 自定义") right away
  } else {
    // closing-out backstop (B): this turn declared it is done (all-ticked plan)
    // or is waiting on a decision (a live proposal card) yet has no chips -- draw a
    // minimal reminder so a missed fence is VISIBLE, not purely down to model
    // self-discipline. A plain empty-steps turn with none of these signals stays
    // hidden, which keeps the existing hidden-on-empty gates green.
    const closing = (m.plan && m.plan.length && m.plan.every((p) => p.done)) ||
      ((m.proposals || []).some((p) => !p.dismissed));
    if (closing) {
      box.hidden = false;
      box.innerHTML = `<span class="next-steps__reminder">` +
        `<span class="next-steps__reminder__t">${esc(t("nextsteps.closeoutremind.title"))}</span>` +
        `<span class="next-steps__reminder__s">${esc(t("nextsteps.closeoutremind.sub"))}</span></span>`;
    } else {
      box.hidden = true;
    }
  }
}

/* ---------------------------------------------------------- autonomous auto-drive (suggested steps)
 * When the "自主推进 / AI 自动续跑建议" switch is on, after a finished turn the AI's own suggested next
 * steps are picked automatically and sent as one combined turn — driving the task forward with no clicks.
 * Guardrails: only when the turn ended cleanly (no error / pending approval / round-limit), only up to
 * AUTO_DRIVE_MAX chain steps, with a brief beat so the user can see / interrupt, and a Stop on the pill.
 */
function maybeAutoDrive(m) {
  if (busy) return;                                  // a turn is already running (shouldn't happen here)
  if (autoDriveAbort) { autoDriveAbort = false; autoDriveDepth = 0; return; }
  if ((m.proposals || []).some((p) => !p.dismissed)) return;  // 2026-10-23: decision card this turn -> do not auto-drive (waiting for the human pick)
  if (!settings.autosteps || !m || !m.steps || !m.steps.length) return;
  if (m.error || m.notice || m.limit) return;        // ambiguous / needs-approval / round-limit → stop
  // pick: recommended-only by default, else every suggestion — never auto-drive "不推荐" (risky) steps
  const picks = m.steps.map((s, i) => ({s, i}))
    .filter(({s}) => !s.avoid && !s.hold && (!settings.autostepsRec || s.recommended))                              // 默认勾上=只推荐·取消勾=绿+橙都跑·红/蓝不跑
    .map(({i}) => i);
  if (!picks.length) return;                          // nothing eligible (e.g. rec-only but no rec)
  if (autoDriveDepth >= AUTO_DRIVE_MAX) {             // chain cap reached: hand back to the human
    autoDriveDepth = 0;
    toast("info", t("autodrive.stopped", {n: AUTO_DRIVE_MAX}));
    return;
  }
  m.selSteps = picks;
  autoDriveDepth++;
  const host = $("chat").querySelector(`.st-msg[data-i="${messages.indexOf(m)}"]`);
  if (host) renderNextSteps(host, m);                 // show the picked chips as selected
  showAutoDrivePill(true);
  autoDriveTimer = setTimeout(() => {                 // brief beat so the user can see / interrupt
    autoDriveTimer = null;
    showAutoDrivePill(false);
    sendSelectedSteps(m, false);                      // false = NOT a human turn (don't reset the chain)
  }, 900);
}
function showAutoDrivePill(on) {
  const pill = $("autodrive-pill");
  if (pill) pill.hidden = !on;
}
function stopAutoDrive() {
  if (autoDriveTimer) { clearTimeout(autoDriveTimer); autoDriveTimer = null; }
  autoDriveAbort = true;                              // also swallow the next queued auto-run
  showAutoDrivePill(false);
  abortStream();                                      // halt whatever is currently inferring
}
// Fire-and-forget POST. `fetch` is only guaranteed to return a Promise in a real browser; a test/legacy
// stub may return a plain value, and calling `.catch` on that used to throw INSIDE turn finalization --
// crashing the whole turn (and the suite) over a best-effort cancel/log request. Never let that happen.
function postQuiet(url, body) {
  try {
    const p = fetch(url, {method: "POST", headers: headers(true), body: JSON.stringify(body)});
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) { /* best-effort side channel: must never break the caller */ }
}
// Cancel the backend stream + browser fetch for the in-flight turn. Shared by #stop-btn and the
// auto-drive pill so both truly stop inference, not just the browser fetch.
function abortStream() {
  if (!busy) return;
  const sid = busy.stopId;
  if (sid) postQuiet("api/chat/stop", {stop_id: sid});
  busy.controller.abort();
}

/* ---------------------------------------------------------- proposal decision cards
 * A model can emit a decision proposal as a ```proposal <json>``` fenced block. The streaming loop
 * calls extractProposalsFromText() after each content chunk: complete fences are parsed, rendered as
 * collapsible cards, and STRIPPED from m.text. Because apiMessages()/assistantMessages() only forward
 * m.text to the engine, the verbose pros/cons NEVER enter the model context (zero bloat). The card lives
 * as DOM + m.proposals data only. "存为文件" (data-prop-act=save) writes the full analysis to
 * .strata-memory/proposal-<id>.md (reusing the side-log philosophy) so even the UI text can be offloaded.
 */
function extractProposalsFromText(m) {
  if (!m || !m.text) return;
  // Only complete fences (with a closing ```) match; a fence still streaming in is left in m.text until done.
  const RE = /```proposal\s*\n([\s\S]*?)\n```/g;
  let mt, hits = [];
  while ((mt = RE.exec(m.text)) !== null) hits.push(mt[1]);
  if (!hits.length) return;
  if (!m.proposals) m.proposals = [];
  let changed = false;
  for (const body of hits) {
    let obj = null;
    try { obj = JSON.parse(body); } catch (e) { obj = null; }
    if (!obj || !obj.title) continue;              // malformed: keep the raw fence as text (safe fallback)
    const id = obj.id || ("prop_" + String(body).length.toString(36) + "_" + (m.proposals.length));
    if (m.proposals.some((p) => p.id === id)) continue;
    obj.id = id;
    if (obj.verified == null) obj.verified = false;
    obj.dismissed = false;
    m.proposals.push(obj);
    changed = true;
  }
  if (changed) {
    // Remove every proposal fence (plus one trailing newline) and collapse runs of blank lines.
    m.text = m.text.replace(/```proposal\s*\n[\s\S]*?\n```\s*\n?/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }
}

function proposalCardHtml(p, gi) {
  const badge = p.verified
    ? `<span class="proposal__badge proposal__badge--ok">${esc(t("proposal.verified"))}</span>`
    : `<span class="proposal__badge proposal__badge--warn">${esc(t("proposal.unverified"))}</span>`;
  const summary = p.summary ? `<div class="proposal__summary">${esc(p.summary)}</div>` : "";
  const evidence = p.evidence ? `<div class="proposal__evidence"><b>${esc(t("proposal.evidence"))}：</b>${esc(p.evidence)}</div>` : "";
  const next = p.next ? `<div class="proposal__next"><b>${esc(t("proposal.next"))}：</b>${esc(p.next)}</div>` : "";
  let opts = "";
  if (p.options && p.options.length) {
    opts = `<table class="proposal__opts"><thead><tr><th>${esc(t("proposal.option"))}</th><th>${esc(t("proposal.verdict"))}</th><th>${esc(t("proposal.pros"))}</th><th>${esc(t("proposal.cons"))}</th><th></th></tr></thead><tbody>` +
      p.options.map((o, oi) => {
        const pros = Array.isArray(o.pros) ? o.pros.map((x) => `<li>${esc(x)}</li>`).join("") : (o.pros ? `<li>${esc(o.pros)}</li>` : "");
        const cons = Array.isArray(o.cons) ? o.cons.map((x) => `<li>${esc(x)}</li>`).join("") : (o.cons ? `<li>${esc(o.cons)}</li>` : "");
        // Mirror the next-steps three-tier scheme: verdict "推荐" -> green "do this" row (primary adopt);
        // verdict "不推荐" -> amber "caution" row (still adoptable, but warned); everything else stays neutral.
        const rec = !!o.verdict && (o.verdict === "推荐" || o.verdict === t("nextsteps.badge"));
        const avoid = !!o.verdict && (o.verdict === "不推荐" || o.verdict === t("nextsteps.avoid.badge"));
        const verdictCls = rec ? " proposal__verdict--rec" : (avoid ? " proposal__verdict--avoid" : "");
        const verdictTxt = rec ? t("nextsteps.badge") : (avoid ? t("nextsteps.avoid.badge") : o.verdict);
        const verdict = o.verdict ? `<span class="proposal__verdict${verdictCls}">${esc(verdictTxt)}</span>` : "";
        const rowCls = rec ? "proposal__opt--rec" : (avoid ? "proposal__opt--avoid" : "");
        const btnCls = rec ? "st-btn--primary" : "st-btn--ghost";
        return `<tr class="${rowCls}"><td>${esc(o.label || ("#" + (oi + 1)))}</td><td>${verdict}</td>` +
          `<td><ul class="proposal__list">${pros}</ul></td><td><ul class="proposal__list">${cons}</ul></td>` +
          `<td><button type="button" class="st-btn st-btn--sm ${btnCls}" data-prop="${gi}" data-opt="${oi}" data-prop-act="adopt">${esc(t("proposal.adopt"))}</button></td></tr>`;
      }).join("") + `</tbody></table>`;
  }
  const saved = p.savedFile ? `<div class="proposal__saved">📄 ${esc(p.savedFile)}</div>` : "";
  return `<details class="proposal"${p._open ? " open" : ""} data-prop="${gi}">` +
    `<summary class="proposal__head">${badge}<span class="proposal__title">${esc(p.title)}</span>${summary ? `<span class="proposal__sum">${esc(p.summary)}</span>` : ""}</summary>` +
    `<div class="proposal__body">${opts}${evidence}${next}${saved}` +
    `<div class="proposal__acts"><button type="button" class="st-btn st-btn--ghost st-btn--sm" data-prop="${gi}" data-prop-act="save">${esc(t("proposal.save"))}</button>` +
    `<button type="button" class="st-btn st-btn--ghost st-btn--sm" data-prop="${gi}" data-prop-act="dismiss">${esc(t("proposal.dismiss"))}</button></div>` +
    `</div></details>`;
}

function renderProposals(el, m) {
  const box = el.querySelector(".proposals");
  if (!box) return;
  const vis = (m.proposals || []).filter((p) => !p.dismissed);
  if (!vis.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<div class="proposals__title">${esc(t("proposal.title"))}</div>` +
    vis.map((p) => proposalCardHtml(p, m.proposals.indexOf(p))).join("");
}

async function handleProposalAction(host, mm, p, act, oi) {
  if (act === "dismiss") { p.dismissed = true; renderProposals(host, mm); return; }
  if (act === "adopt") {
    const opt = (oi != null && p.options && p.options[oi]) ? p.options[oi]
      : (p.options ? (p.options.find((o) => o.verdict === "推荐") || p.options.find((o) => o.verdict !== "不推荐") || p.options[0]) : null);
    const label = opt ? opt.label : "";
    const verdict = (opt && opt.verdict) ? `（${opt.verdict}）` : "";
    const next = p.next ? `\n下一步：${p.next}` : "";
    ceSetText($("input"), `采纳建议：「${p.title}」选 ${label}${verdict}。${next}`); $("input").focus();
    return;
  }
  if (act === "save") {
    await saveProposalToFile(mm, p);
    renderProposals(host, mm);
    return;
  }
}

async function saveProposalToFile(mm, p) {
  try {
    const base = (activeSession() || {}).workspace || "";
    if (!base) { toast("error", t("proposal.savefail"), "未定位到工作区目录"); return; }
    const id = p.id || ("prop_" + Date.now().toString(36));
    const path = `${base.replace(/\/$/, "")}/.strata-memory/proposal-${id}.md`;
    await fsWrite(path, proposalMarkdown(p));
    p.savedFile = path;
    toast("ok", t("proposal.saved"), path);
  } catch (e) {
    toast("error", t("proposal.savefail"), String((e && e.message) || e));
  }
}

function proposalMarkdown(p) {
  const lines = [`# 建议决策卡：${p.title}`, "", `**验证状态**：${p.verified ? "已验证" : "待验证"}`, ""];
  if (p.summary) lines.push(`**结论**：${p.summary}`, "");
  if (p.options && p.options.length) {
    lines.push("## 选项对照", "", "| 选项 | 结论 | 好处 | 坏处 |", "| --- | --- | --- | --- |");
    for (const o of p.options) {
      const pros = (o.pros || []).join("；") || "-";
      const cons = (o.cons || []).join("；") || "-";
      lines.push(`| ${o.label || ""} | ${o.verdict || ""} | ${pros} | ${cons} |`);
    }
    lines.push("");
  }
  if (p.evidence) lines.push("## 验证方式", "", p.evidence, "");
  if (p.next) lines.push("## 下一步", "", p.next, "");
  return lines.join("\n");
}

function continueTask(btn) {
  if (busy) return;
  const host = btn && btn.closest(".st-msg");
  const m = host ? messages[+host.dataset.i] : null;
  // Context overflow: the prompt is already too large for the upstream to generate, so re-sending
  // "继续" would just 400 again and loop forever. Compact history first; compactConversation() then
  // auto-resumes the interrupted task with the correct prompt instead of spinning.
  if (m && m.notice && m.notice.code === "context_overflow") {
    resumeSnapshot = taskResumeSnapshot() || {leftItems: null};   // force-arm so it resumes after compacting
    continueRequested = true;   // A: asked for by the Continue button -> must not be deferred
    compactConversation(true);
    return;
  }
  ceSetText($("input"), "继续完成刚才被工具轮数上限截断的任务：接着把剩下的工作做完（不要重复已经做的部分）。");
  send();
}

// A healthy turn always ends with the gateway's [DONE]. Ending WITHOUT it (and without an error, a
// notice or a Stop) means the connection was cut mid-turn: dropped socket, proxy timeout, gateway
// restart. Without this a half-streamed answer looked exactly like a finished one -- the "it just
// stopped for no reason" report. Marks the turn so the UI says so and auto-resume can pick it up.
function markTruncatedIfCut(m, sawDone, stopId) {
  if (sawDone || !m || m.error || m.stopped || m.notice) return false;
  m.truncated = true;
  // The gateway may still be running this turn server-side (it only stops when its socket breaks).
  // Cancel it explicitly so it stops burning tokens and can't race the follow-up turn.
  if (stopId) postQuiet("api/chat/stop", {stop_id: stopId});
  return true;
}

// ------------------------------------------------------------------ interruption log
// Every turn that did NOT finish cleanly is recorded with the TIME and the PHASE it died in
// (thinking / answering / which tool was running). "It just stopped" used to leave no evidence
// at all -- this file is what turns the next report from anecdote into diagnosis: a cluster of
// `tool` entries naming one tool is a wedged tool; a cluster of `thinking` with a growing idleS
// is a silent engine; a spread across sessions at the same minute is the network or the proxy.
// Two sinks on purpose: the gateway appends to a JSONL file (survives a cleared browser), and a
// localStorage mirror keeps working offline / in parasitic mode where the route does not exist.
const ILOG_KEY = "interruptLog";       // localStorage mirror key (strata.interruptLog)
const ILOG_MIRROR_MAX = 200;           // mirror is a safety net, not an archive: keep it small
// Persistence helpers for expand/collapse state (survives hard refresh + restart):
// localStorage-backed Sets, one per list. JSON array in storage, Set in memory.
function expandSetLoad(key){ let s = new Set(); try { const a = JSON.parse(localStorage.getItem(key) || "[]"); if (Array.isArray(a)) s = new Set(a); } catch (e) {} return s; }
function expandSetSave(key, set){ try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) {} }
const BUGBOX_KEY = 'bugBox';            // localStorage key: bug collection box (off-turn exceptions)
const BUGBOX_MAX = 500;                 // bug box is larger: dev bugs accumulate across a session
let BUGBOX_SHOW_LIMIT = 50;           // perf (aligns KB_SHOW_LIMIT): rows shown before load-more
const bugBoxExpanded = expandSetLoad('strata.bugBoxExpanded');   // persisted (2026-10-30): survives refresh/restart
const _bugBox = { _lastTs: 0, _lastMsg: null };   // de-dupe state for the off-turn collector
// Called from the streaming loop as each kind of activity arrives. The phase is what the user
// was LOOKING AT when the turn died, which is exactly what they report ("it stopped while
// thinking" / "it stopped inside that shell command").
function noteStreamPhase(m, phase, tool) {
  if (!m) return;
  m._phase = phase;
  m._phaseTool = phase === "tool" ? (tool || m._phaseTool || null) : null;
}
// Pure: build the record for one interrupted turn. `kind` is decided by recordInterruption().
function interruptRecord(m, kind) {
  if (!m) return null;
  const now = Date.now();
  const tools = m.tools || [];
  // A tool still open (running/writing) is the one that was cut off; if everything already
  // finished, fall back to the last tool so "which tool" is still answerable.
  const open = tools.filter((x) => x.state === "running" || x.state === "writing");
  const tl = open.length ? open[open.length - 1] : (tools.length ? tools[tools.length - 1] : null);
  const phase = m._phase || (tl ? "tool" : (m.reasoning && !m.text ? "thinking" : "answering"));
  let model = null;
  try { if (typeof requestModel === "function") model = requestModel(); } catch (e) { model = null; }
  return {
    ts: new Date(now).toISOString(),       // ISO so the file sorts and greps cleanly
    kind,                                  // truncated | notice:<code> | error | limit | stopped
    phase,                                 // thinking | answering | tool
    tool: phase === "tool" ? (tl ? (tl.name || tl.tool || null) : null) || m._phaseTool || null : null,
    toolState: tl ? tl.state : null,       // running = it never came back; writing = it never started
    round: tl && tl.round != null ? tl.round : null,
    idleS: m._lastActivityAt ? Math.round((now - m._lastActivityAt) / 1000) : null,
    elapsedS: m.startAt != null ? Math.round((performance.now() - m.startAt) / 1000) : null,
    chars: (m.text || "").length,
    session: activeId || null,
    model,
    notice: m.notice ? (m.notice.code || "notice") : null,
    // `cutError` carries the raw transport text ("network error") of a turn that was cut rather
    // than failed -- keeping it matters: kind stays "truncated" (so it is not mistaken for a fatal
    // error) while the reason is still on disk for the next diagnosis.
    error: m.error || m.cutError || null,
    limit: m.limit || null,
    truncated: !!m.truncated,
    stopped: !!m.stopped,
  };
}
function logInterruption(m, kind) {
  const rec = interruptRecord(m, kind);
  if (!rec) return null;
  try {
    const prev = store.get(ILOG_KEY, []);
    store.set(ILOG_KEY, (Array.isArray(prev) ? prev : []).concat([rec]).slice(-ILOG_MIRROR_MAX));
  } catch (e) { /* best-effort mirror: the server-side file is the real sink */ }
  try {
    postQuiet("api/interrupt-log", {entry: rec});
  } catch (e) { /* no route (parasitic mode) or offline: the mirror already holds it */ }
  return rec;
}
// Called once a turn settles. A turn that finished normally is NOT an interruption, so it is
// not logged -- otherwise the signal (real breaks) would drown in noise (every clean answer).
function recordInterruption(m) {
  if (!m) return null;
  const kind = m.truncated ? "truncated"
    : m.notice ? "notice:" + (m.notice.code || "notice")
    : m.error ? "error"
    : m.limit ? "limit"
    : m.stopped ? "stopped" : null;
  return kind ? logInterruption(m, kind) : null;
}
// About-panel viewer: the server file when the route exists, else the browser mirror.
async function loadInterruptLog() {
  const card = $("ilog-card");
  if (!card) return;
  let entries = null, path = "";
  try {
    const r = await fetch("api/interrupt-log?n=20", {headers: headers()});
    if (r.ok) {
      const c = await r.json();
      entries = c.entries || [];
      path = c.path || "";
    }
  } catch (e) { /* fall through to the mirror */ }
  // Three cases, in order: no route at all (parasitic mode / offline) -> the browser mirror;
  // a route that came back empty -> the mirror too, so entries recorded before the gateway had
  // this route are not lost; otherwise the server file (the authoritative, shared sink).
  if (entries === null || !entries.length) {
    const mirror = store.get(ILOG_KEY, []);
    if (Array.isArray(mirror) && mirror.length) { entries = mirror; path = t("about.ilog.mirror"); }
  }
  $("ilog-file").textContent = path;
  const list = entries.slice().reverse();                 // newest first
  $("ilog-list").innerHTML = list.length ? list.map(ilogRowHtml).join("")
    : `<p class="muted small">${esc(t("about.ilog.empty"))}</p>`;
  card.hidden = false;
}
function ilogRowHtml(e) {
  const when = String(e.ts || "").replace("T", " ").slice(0, 19);
  const what = e.phase === "tool" ? (e.tool || t("ilog.unknown")) : t("ilog." + (e.phase || "unknown"));
  const extra = e.idleS != null ? `${e.idleS}s ${t("ilog.idle")}` : "";
  return `<div class="ilog-row"><code>${esc(when)}</code>` +
         `<span class="ilog-kind">${esc(e.kind || "")}</span>` +
         `<span class="ilog-what">${esc(what)}</span>` +
         `<span class="muted small">${esc(extra)}</span></div>`;
}

// Automatic resume of an INTERRUPTED turn. Fires on its own -- the human must not have to click 继续
// for the task to carry on. Eligible stops are the recoverable ones:
//   • m.truncated  the stream was cut off (dropped connection) -- the work is half-done, retry it
//   • notice with resumable:true (idle watchdog / turn budget / round cap)
//   • NOT context_overflow: re-sending would 400 again; that path compacts first (see continueTask)
//   • NOT a human Stop (m.stopped) and NOT a fatal error (m.error): retrying those is wrong.
// Capped at AUTO_RESUME_MAX consecutive automatic retries, then control goes back to the human, so a
// permanently wedged engine can't spin forever. Reuses the compaction-resume machinery (badge + 3s
// undo window), so every automatic retry is still visible and cancellable.
function maybeAutoResume(m) {
  if (busy || !m) return false;
  if (!settings.autoresume) return false;               // master switch off -> never auto-resume
  if (m.stopped || m.error) return false;
  const cap = settings.autoresumeMax > 0 ? settings.autoresumeMax : AUTO_RESUME_MAX;   // A: drawer field wins; the const is only the unset fallback
  const emptyCap = settings.emptyRoundMax >= 0 ? settings.emptyRoundMax : 2;            // B: pure-thinking empty rounds get their OWN small budget (default 2)
  const isEmptyLane = !!(m.notice && m.notice.code === "empty_round");
  const openPlan = (m.plan || []).filter((p) => !p.done).length;   // D(early-done): the model's OWN unchecked checklist - strongest premature-close signal.
  const mainResumable = m.truncated ||
    (m.notice && m.notice.resumable && m.notice.code !== "context_overflow") || isEmptyLane;
  // D(early-done lane): model wrote what reads like a closing line while its OWN plan checklist still had boxes left -> premature, not done.
  const earlyCap = Math.max(AUTO_RESUME_FLOOR, cap);   // 2026-11 plan A+B: early lane is a NOT-finished lane, so it gets the same big budget as the main chain (floor>=12, default 24) and runs to completion; only the pure-spin empty lane keeps its small anti-spin budget.
  const isEarlyLane = !mainResumable && openPlan > 0 && !!(m.text || "").trim();   // ONLY when no existing lane took it AND its own plan has boxes left AND there is real text -> near-zero misjudge on a genuine short answer
  if (!isEarlyLane && !mainResumable) return false;   // early lane IS a mainResumable=false case, so let it through the gate too
  let chainN, chainMax;                                  // per-lane count/max so the toast never mixes the two chains
  if (isEarlyLane) {                                  // D: its OWN counter + small budget; never borrows the main-chain count
  if (earlyDoneChain >= earlyCap) {                 // fuse reached -> say WHY and hand control back to the human
  earlyDoneChain = 0;
  m.resumeExhausted = earlyCap;
  m.canContinue = true;
  toast("info", t("resume.stopped.early", {n: earlyCap}));
  renderChat();
  return false;
  }
  earlyDoneChain++; chainN = earlyDoneChain; chainMax = earlyCap;
  } else if (isEmptyLane) {
    // B: separate counter + own budget -> a long thinking-only stall is auto-carried up to emptyCap then handed back with WHY.
    if (emptyRoundChain >= emptyCap) {
      emptyRoundChain = 0;
      m.resumeExhausted = emptyCap;
      m.canContinue = true;                      // stamp so the banner says WHY, not go silent
      toast("info", t("resume.stopped.empty", {n: emptyCap}));
      renderChat();
      return false;
    }
    emptyRoundChain++; chainN = emptyRoundChain; chainMax = emptyCap;
  } else {
    if (autoResumeChain >= cap) {                        // main-chain hard stop: say why, and hand it back
      autoResumeChain = 0;
      m.resumeExhausted = cap;
      m.canContinue = true;                           // STAMP the message so the banner survives the toast; a long task that hit the cap should say WHY it stopped, not go silent
      toast("info", t("resume.stopped", {n: cap}));
      renderChat();                                      // repaint: updateAssistant already ran before this branch, so the banner only shows up now
      return false;
    }
    autoResumeChain++; chainN = autoResumeChain; chainMax = cap;
  }
  ceSetText($("input"), t("chat.resume.cmd"));
  toast("ok", t("chat.resume.auto"), t("resume.chain", {n: chainN, max: chainMax}), 6000);
  resumeBadge = t("chat.resume.meta");
  pendingResume = {timer: setTimeout(() => { pendingResume = null; send(false); }, 3000)};
  renderInspector();                                  // show the undo affordance on the panel row now
  return true;
}

// ================================================================== R5: right inspector (task panel)
// Pure-frontend: context fill, plan progress, generated files and test results are all derived from the
// existing stream (usage.prompt_tokens, the `strata_mcp` tool events, and a ```plan block the model emits).
// inspectorOpen is declared near `let tab` so it is initialized before the first applyInspector() call.
let maxCtx = 0;                                  // model context window (from the status poll)
let lastPromptTokens = 0, lastCacheTokens = 0;    // latest request usage (per turn)
let lastRag = "";                                 // F3: knowledge recalled for the current turn (empty if none)
let pendingCompact = false;
let continueRequested = false;   // A: a Continue click on a context_overflow forces the compaction through, past the chain-active guard
let resumeSnapshot = null;                                 // auto-resume: set before any compaction (auto or manual), consumed once by the hook
let resumeBadge = null;             // auto-resume badge for the next streamed turn (meta label + hidden autoResume flag)
let pendingResume = null;             // auto-resume undo window: {timer} while the deferred send() waits; null once fired or cancelled
let autoResumeChain = 0;              // consecutive AUTOMATIC resumes on the MAIN chain (capped by settings.autoresumeMax)
let emptyRoundChain = 0;              // B: separate counter for the pure-thinking empty_round lane (own budget, default 2)
let earlyDoneChain = 0;             // D: separate counter for the premature-close lane (own budget), mirroring emptyRoundChain on purpose.
const AUTO_RESUME_MAX = 24;           // A: raise floor so a normal long task runs to finish; s-autoresumeMax (drawer) overrides it when set.
const AUTO_RESUME_FLOOR = 12;         // 2026-11 plan-A guard: the smallest main-chain cap we honour. A drawer value below this too-small floor falls back to DEFAULTS/AUTO_RESUME_MAX, so a stray small number (like a leftover 2) can no longer fuse-and-hand-back after only a couple of resumes.
// Adaptive auto-compact threshold.
//   settings.compactPct > 0 -> manual override (user pinned this percentage).
//   settings.compactPct === 0 -> adaptive: 75% of the model's effective (native) window,
//     expressed as a percentage of the physical max. For large physical windows that
//     exceed the native context (e.g. 262K with native ~128K), this fires before the
//     decode-speed slowdown zone. Floor 50% prevents premature compaction of tiny chats;
//     ceiling 90% prevents waiting until the compact request itself might not fit.
const EFFECTIVE_NATIVE_FALLBACK = 128000;   // used when the model entry has no native_ctx
// Per-model effective (trained) window from the registry: models.json -> native_ctx.
function nativeWindow() {
  const m = currentModel();
  return (m && +m.native_ctx > 0) ? +m.native_ctx : EFFECTIVE_NATIVE_FALLBACK;
}
// Why the panel says the threshold was reached but nothing happened (null = nothing
// blocked: no threshold crossed, or nothing standing in the way). Pure display layer.
function autoCompactBlockReason() {
  if (!settings.autocompact) return null;
  if (pendingCompact || autoCompactRetryTimer) return null;              // already acting on it
  if (!maxCtx || !lastPromptTokens) return null;
  if (lastPromptTokens < (autoCompactThreshold() / 100) * maxCtx) return null;   // threshold not crossed: nothing to explain
  if (autoCompactCooldown > Date.now())
    return t("insp.compact.block.cooldown", { s: Math.ceil((autoCompactCooldown - Date.now()) / 1000) });
  if (messages.length <= 6) return t("insp.compact.block.shortchat");
  return null;
}
function autoCompactThreshold() {
  if (settings.compactPct > 0) return settings.compactPct;
  if (!maxCtx) return 75;
  const effective = Math.min(maxCtx, nativeWindow());
  const trigger = effective * 0.75;
  const pct = Math.round((trigger / maxCtx) * 100);
  return Math.min(Math.max(pct, 50), 90);
}
let compactCount = 0;                             // compactions performed in this page session (manual + auto)
// H2: workspace procedural rules (the "工作规则" tier). Two parts:
//   - workspaceRules : the APPROVED, always-injected conventions (text of <ws>/RULES.md).
//   - pendingDraft   : rule lines the agent proposed this/last session, awaiting human approval
//                      (mirrored to <ws>/RULES.draft.md so they survive a reload).
let workspaceRules = "";
let pendingDraft = [];
// H2: three-scope memory state (workspace-specific + group-shared + cross-project global) for all
// three stores. Fed by loadMemoryState(); read by workspaceSystem() to compose the always-on prompt.
// Precedence (lowest first): global -> group -> workspace (later overrides earlier on conflict).
let globalRules = "", globalKnowledge = "", globalExperience = "";
let groupRules = "", groupKnowledge = "", groupExperience = "";
let workspaceKnowledge = "", workspaceExperience = "";
let currentGroup = "";   // the active workspace's group label ("" => no group tier)
// Draft lines ticked in the approval banner, keyed by CONTENT (stable when other
// lines are dropped). Default: everything ticked, so "merge" = approve all.
let rulesSel = new Set();
const TEST_RE = /\b(pytest|unittest|nose|jest|mocha|tox|go test|npm test|node --test|cargo test|mvn test|gradle test|test_[a-z0-9_]+\.|\.test\.|__tests?__)\b/i;
const FILE_TOOL_BASE = new Set(["write", "write_file", "create", "create_file", "write_text_file", "move",
  "rename", "edit", "edit_file", "append", "append_file", "save", "put_file", "create_directory", "mkdir"]);
function firstPath(args) {
  if (!args || typeof args !== "object") return "";
  for (const k of ["path", "file_path", "target", "destination", "file", "source"])
    if (typeof args[k] === "string" && args[k]) return args[k];
  for (const v of Object.values(args)) if (typeof v === "string" && /[\\/]/.test(v)) return v;
  return "";
}
function classifyTool(t) {
  if (!t) return null;
  const srv = String(t.server || "").toLowerCase(), tool = String(t.tool || t.name || "").toLowerCase();
  const base = tool.split("__").pop();
  if (srv.includes("file") && FILE_TOOL_BASE.has(base)) {
    const p = firstPath(t.arguments);
    return p ? {kind: "file", path: p, ok: t.ok !== false} : null;
  }
  if (srv.includes("shell") || base.includes("shell") || srv.includes("terminal")) {
    const cmd = typeof t.arguments === "string" ? t.arguments : JSON.stringify(t.arguments || "");
    if (TEST_RE.test(cmd)) {
      const res = String(t.result || "");
      const fp = res.match(/(\d+)\s*passed/i);
      const fr = res.match(/(\d+)\s*failed/i) || res.match(/failures=(\d+)/i) || res.match(/errors=(\d+)/i);
      const tot = res.match(/Ran\s+(\d+)\s*tests?/i);
      const passed = fp ? +fp[1] : (tot ? +tot[1] : null);
      const failed = fr ? +fr[1] : 0;
      const ok = t.ok !== false && failed === 0 && !/FAILED|Traceback|Error:/i.test(res.slice(0, 500));
      return {kind: "test", cmd: cmd.replace(/\s+/g, " ").slice(0, 48), passed, failed, ok};
    }
  }
  return null;
}
// --- the ```plan checklist ---------------------------------------------------
// The block is matched WITH or WITHOUT its closing fence: while a turn streams the closing fence has not
// arrived yet, and the panel must still be able to show the checklist the model is currently working on.
function planBlocks(text) {
  const out = [];
  const src = text || "";
  let m;
  const mdRe = /```plan[^\n]*\n([\s\S]*?)(```|$)/gi;
  while ((m = mdRe.exec(src)) !== null) {
    out.push({raw: m[1], at: m.index, len: m[0].length, closed: m[2] === "```"});
    if (!m[0].length) break;                       // safety: never loop on a zero-length match
  }
  // XML-plan form: the model’s hallucination of writing the ```plan``` checklist as a
  // tool-call scaffold (<function=plan> ... </function>). The action parser discards it, so
  // without this branch the panel misses the checklist and the raw tags render as litter.
  const xmlRe = /<function=plan[^>]*>([\s\S]*?)(<\/function>|$)/gi;
  while ((m = xmlRe.exec(src)) !== null) {
    out.push({raw: m[1], at: m.index, len: m[0].length, closed: m[2] === "</function>"});
    if (!m[0].length) break;
  }
  out.sort((a, b) => a.at - b.at);                 // consumers read the LAST block by position
  return out;
}
function parsePlanItems(raw) {
  return String(raw || "").split("\n").map((s) => s.trim()).filter(Boolean).map((s) => {
    const done = /^[-*]\s*\[[xX]\]/i.test(s);
    const label = s.replace(/^[-*]\s*\[[ xX]\]\s*/, "").trim();
    return {done, label};
  }).filter((it) => it.label);
}
// The checklist of the turn being streamed: the LAST plan block (the model may re-emit an updated list every
// round, and the newest one is the truth), regardless of whether its fence is closed yet.
function livePlan(text) {
  const bs = planBlocks(text);
  for (let i = bs.length - 1; i >= 0; i--) {
    const items = parsePlanItems(bs[i].raw);
    if (items.length) return items;
  }
  return [];
}
// Finalise a finished turn: take the last checklist and cut EVERY plan block out of the answer text (they are
// the panel's business, not the prose). Tool anchors (`at`) sit later in the text, so they are shifted by the
// removed length — stripping from the end keeps the earlier offsets valid while we go.
function applyPlan(m) {
  const bs = planBlocks(m.text || "");
  if (!bs.length) return [];
  const items = parsePlanItems(bs[bs.length - 1].raw);
  if (!items.length) return [];
  let text = m.text;
  for (let i = bs.length - 1; i >= 0; i--) {
    const b = bs[i];
    text = text.slice(0, b.at) + text.slice(b.at + b.len);
    for (const t of (m.tools || [])) if (t.at > b.at) t.at = Math.max(b.at, t.at - b.len);
  }
  m.text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return items;
}
// Legacy shape (text in, text+items out) kept for callers/tests that render a single string.
function extractPlan(text) {
  const bs = planBlocks(text);
  if (!bs.length) return {text: text || "", items: []};
  const last = bs[bs.length - 1], items = parsePlanItems(last.raw);
  if (!last.closed) return {text: text || "", items};
  let out = text;
  for (let i = bs.length - 1; i >= 0; i--) out = out.slice(0, bs[i].at) + out.slice(bs[i].at + bs[i].len);
  return {text: out.trim(), items};
}
// D11: a tiny inline sparkline of per-turn context usage (%) drawn into an SVG.
function ctxSpark(arr) {
  if (!arr.length) return "";
  const w = 100, h = 24, n = arr.length;
  const x = (i) => n === 1 ? w / 2 : (i / (n - 1)) * w;
  const y = (v) => h - (Math.min(100, v) / 100) * (h - 3) - 1.5;
  const last = arr[arr.length - 1];
  const tone = last >= 90 ? "var(--st-danger)" : last >= 75 ? "var(--st-warn)" : "var(--st-accent)";
  const pts = arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return `<polyline fill="none" stroke="${tone}" stroke-width="1.5" points="${pts}"/>` +
         `<circle cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="1.8" fill="${tone}"/>`;
}
function renderInspector() {
  const ins = $("inspector");
  if (!ins) return;
  // --- context fill ---
  const escNum = (s, tone) => s.replace(/(\d[\d,]*)/g, '<span class="ins-note__val"' + (tone ? ' data-tone="' + tone + '"' : '') + '>$1</span>');
  const ctx = maxCtx || (currentModel() && (+currentModel().context_window || +currentModel().native_ctx || 0)) || 0, used = lastPromptTokens || 0;
  const frac = ctx ? Math.min(1, used / ctx) : 0, pct = Math.round(frac * 100);
  const cachePct = used ? Math.round(100 * (lastCacheTokens || 0) / used) : 0;
  const tone = pct >= 90 ? "danger" : pct >= 75 ? "warning" : "success";
  const bar = $("ins-ctx-bar"); if (bar) { bar.style.width = (frac * 100) + "%"; bar.dataset.tone = tone; }
  const pe = $("ins-ctx-pct"); if (pe) { const h = ctx ? escNum(esc(`${pct}%`), tone) : esc("–"); if (pe.dataset._h !== h) { pe.innerHTML = h; pe.dataset._h = h; } }
  const su = $("ins-ctx-sub"); if (su) su.textContent = ctx ? `${kfmt(used)} / ${kfmt(ctx)} tokens` : t("insp.ctx.empty");
  const en = $("ins-engine");
  if (en) {
    const c = (engineMonitor && engineMonitor.available) ? engineMonitor.context : null;
    const mx = c ? (+c.maxTokens || 0) : 0;
    // [ENGINE-WATERLINE-HONEST + REALTOKENS] 这套壳引擎的 context.usedTokens/maxTokens 不可信（恒 0 + 占位 32768，
    // 实测引擎真实处理过 110031 tokens 的请求）。网关已透传引擎侧跨会话真实占用 engineRealTokens（取自 requests[].tokensIn
    // 最新一条 done）+ 声明窗口 maxCtx(131K)。壳引擎场景：本行显示「引擎侧跨会话真实占用 ÷ 声明窗口」，与上方占用条
    // (本会话占用 ÷ 同一声明窗口)分工互补——占用条=本会话、本行=引擎全量真实，二者不再同源重复。真 llama.cpp 引擎(无此字段)
    // 落回共享池口径 usedTokens÷真实 n_ctx。
    // [ENGINE-WATERLINE] 壳引擎的 context.maxTokens 是占位默认值(实测 32768)，它不维护真实 n_ctx——
    // 判定「引擎自报分母 ≠ 声明窗口 maxCtx」即壳引擎（两值都稳定，判定恒成立，不依赖会抖动的
    // engineRealTokens）。壳引擎场景直接隐藏本行：引擎侧读数语义不干净（假分母+恒0水位），隐藏后
    // 只留上方占用条（用真实声明窗口），零抖动、语义最干净。真 llama.cpp 引擎(自报≈声明)才显示共享池口径。
    const decl = maxCtx || 0;
    const shell = decl > 0 && mx > 0 && Math.abs(mx - decl) / decl > 0.02;   // 引擎占位分母与声明窗口明显不同 = 壳引擎
    if (shell) {
      if (!en.hidden) { en.hidden = true; en.innerHTML = ""; en.dataset._h = ""; }
      en.title = "";
    } else if (mx > 0) {
      const u = +c.usedTokens || 0;
      const idle = !busy && u <= 0;
      const epct = mx ? Math.min(100, Math.round(100 * u / mx)) : 0;
      const etone = epct >= 90 ? "danger" : epct >= 75 ? "warning" : "success";
      const eh = idle
        ? esc(t("insp.engine") + " ") + `<span class="muted">${esc(t("insp.engine.idle"))} · ${kfmt(mx)}</span>`
        : escNum(esc(`${t("insp.engine")} ${epct}%`), etone) + ` <span class="muted">${kfmt(u)} / ${kfmt(mx)}</span>`;
      if (en.dataset._h !== eh) { en.hidden = false; en.innerHTML = eh; en.dataset._h = eh; }
      en.title = t("insp.engine.tip");
    } else if (!en.hidden) { en.hidden = true; en.innerHTML = ""; en.dataset._h = ""; }
  }
  const ca = $("ins-cache"); if (ca) { const h = used ? escNum(esc(`缓存命中 ${cachePct}%`)) : esc("–"); if (ca.dataset._h !== h) { ca.innerHTML = h; ca.dataset._h = h; } }
  // D14: the "compact" action is meaningless while there is no conversation to compact — disable it at 0 tokens
  const cmp = $("ins-compact"); if (cmp) cmp.disabled = !used;
  // Auto-compaction used to fire in the background with nothing on screen to explain the sudden drop in
  // usage. Show its state (and how many times it ran this session) right under the button.
  const note = $("ins-ctx-note");
  if (note) {
    const htmlBits = [pendingCompact ? esc(t("insp.compact.running"))
      : pendingResume ? esc(t("insp.compact.resumed")) + ' <button class="ins-undo-btn" data-action="resume-undo">' + esc(t("insp.compact.undo")) +'</button>'
      : settings.autocompact && (([...messages].reverse().find((mm) => mm.role === "assistant") || {}).autoResume)
        ? esc(t("insp.compact.resumed"))
      : settings.autocompact ? escNum(esc(t("insp.compact.auto", {p: autoCompactThreshold()})))
      : esc(t("insp.compact.autooff"))];
    const blockReason = settings.autocompact && !pendingCompact && !pendingResume ? autoCompactBlockReason() : null;
    if (blockReason) htmlBits.push(esc(blockReason));
    if (compactCount) htmlBits.push(esc(t("insp.compact.count", {n: compactCount})));
    const html = htmlBits.join(" · ");
    if (note.dataset._h !== html) { note.innerHTML = html; note.dataset._h = html; }
    note.dataset.state = pendingCompact ? "busy" : settings.autocompact ? "on" : "off";
  }
  // --- plan: the CURRENT turn's checklist only ---
  // While a turn streams the list is read live out of the answer text, so the bar moves as the model ticks
  // items off. While idle only the NEWEST answer may supply one: the previous task's checklist must not
  // linger once the next task has started (that was the "old task" staleness).
  let plan = null, planLive = false, planPending = false;
  const bmsg = busy && busy.msg;
  if (bmsg) {
    planLive = true;
    const items = livePlan(bmsg.text || "");
    if (items.length) plan = items; else planPending = true;
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "assistant") continue;
      if (messages[i].plan && messages[i].plan.length) plan = messages[i].plan;
      break;
    }
  }
  const pbox = $("ins-plan"), plive = $("ins-plan-live");
  if (plive) plive.hidden = !(planLive && plan);
  if (plan && plan.length) {
    const done = plan.filter((p) => p.done).length;
    if (pbox) pbox.hidden = false;
    const pb = $("ins-plan-bar"); if (pb) pb.style.width = (100 * done / plan.length) + "%";
    const pc = $("ins-plan-count"); if (pc) { const h = escNum(`${done}/${plan.length}`); if (pc.dataset._h !== h) { pc.innerHTML = h; pc.dataset._h = h; } }
    const pl = $("ins-plan-list");
    if (pl) {                                     // repainted at ~2 Hz while streaming: skip identical lists
      let html = plan.map((p) =>
        `<li class="${p.done ? "done" : ""}">${p.done ? "✓" : "○"} ${esc(p.label)}</li>`).join("");
      // B: idle + not fully ticked -> surface WHY it looks done-but-not (the close-out reminder).
      // Streaming (planLive) keeps the bare list so the live bar still moves during the turn.
      if (!planLive && done < plan.length) html += `<li class="ins-plan-remind">${esc(t("insp.plan.reminder", {n: plan.length - done}))}</li>`;
      if (!planLive && done >= plan.length) html += `<li class="ins-plan-complete">${esc(t("insp.plan.complete"))}</li>`;
      if (pl.innerHTML !== html) pl.innerHTML = html;
    }
  } else if (planPending) {
    if (pbox) pbox.hidden = false;
    const pb = $("ins-plan-bar"); if (pb) pb.style.width = "0%";
    const pc = $("ins-plan-count"); if (pc && pc.dataset._h !== "") { pc.innerHTML = ""; pc.dataset._h = ""; }
    const pl = $("ins-plan-list");
    if (pl && !pl.dataset.pending) { pl.dataset.pending = "1"; pl.innerHTML = `<li class="muted">${esc(t("insp.plan.pending"))}</li>`; }
  } else if (pbox) {
    pbox.hidden = true;
    const pl = $("ins-plan-list"); if (pl && pl.dataset.pending) delete pl.dataset.pending;
  }
  // --- files + tests aggregated across the whole conversation ---
  const files = [], tests = [];
  for (const m of messages) for (const t of (m.tools || [])) {
    const c = classifyTool(t); if (!c) continue;
    if (c.kind === "file" && c.path) files.push(c); else if (c.kind === "test") tests.push(c);
  }
  const fmap = new Map(); for (const f of files) fmap.set(f.path, f);
  const fe = $("ins-files");
  if (fe) {
    const html = fmap.size ? [...fmap.values()].slice(-14).reverse().map((f) =>
      `<li><span class="ins-file-path" title="${esc(f.path)}">${esc(f.path.split(/[\\/]/).pop())}</span>` +
      `<span class="ins-tag ${f.ok ? "ok" : "err"}">${f.ok ? t("insp.wrote") : t("insp.failed")}</span></li>`).join("")
      : `<li class="muted">${t("insp.none")}</li>`;
    if (fe.innerHTML !== html) fe.innerHTML = html;     // repainted at 2 Hz while a turn streams
  }
  const te = $("ins-tests");
  if (te) {
    const html = tests.length ? tests.slice(-8).reverse().map((tt) => {
      const label = tt.passed != null ? `${escNum(String(tt.passed))} 通过` : (tt.ok ? t("insp.pass") : t("insp.fail"));
      return `<li title="${esc(tt.cmd)}"><span class="ins-file-path">${esc(tt.cmd)}</span>` +
        `<span class="ins-tag ${tt.ok ? "ok" : "err"}">${label}</span></li>`;
    }).join("") : `<li class="muted">${t("insp.none")}</li>`;
    if (te.innerHTML !== html) te.innerHTML = html;
  }
  // D15: a section that only ever says "暂无" wastes vertical space — hide it until there's data
  const fsec = $("ins-files-sec"), tsec = $("ins-tests-sec");
  if (fsec) fsec.hidden = fmap.size === 0;
  if (tsec) tsec.hidden = tests.length === 0;
  // --- D11: session-wide cumulative tokens + per-turn context trend ---
  let inTok = 0, outTok = 0, turns = 0; const ctxArr = [];
  for (const mm of messages) {
    if (mm.role !== "assistant" || !mm.stats) continue;
    inTok += mm.stats.prompt || 0; outTok += mm.stats.completion || 0; turns++;
    if (mm.stats.ctxMax) ctxArr.push(Math.round(100 * (mm.stats.ctxUsed || 0) / mm.stats.ctxMax));
  }
  const si = $("ins-sess-in"), so = $("ins-sess-out"), stn = $("ins-sess-turns");
  const sv = kfmt(inTok), ov = kfmt(outTok), tv = fmt(turns);   // session stats are discrete too: dirty-check like files/tests/plan
  if (si && si.textContent !== sv) si.textContent = sv;
  if (so && so.textContent !== ov) so.textContent = ov;
  if (stn && stn.textContent !== tv) stn.textContent = tv;
  const spark = $("ins-sess-spark");
  if (spark) { const sh = ctxSpark(ctxArr); if (spark.innerHTML !== sh) spark.innerHTML = sh; }
}
function applyInspector() { const ins = $("inspector"); if (ins) ins.hidden = (tab !== "chat" && tab !== "spark") || !inspectorOpen; layoutHandles(); }
// The context readout is a per-turn value, so it must be re-derived when the user switches tasks —
// otherwise the panel keeps showing the previous task's occupancy until the new task's first turn ends.
function syncCtxFromSession() {
  let pt = 0, ct = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const mm = messages[i];
    if (mm.role === "assistant" && mm.stats && mm.stats.ctxUsed) {
      pt = mm.stats.ctxUsed; ct = mm.stats.cache || 0; break;
    }
  }
  lastPromptTokens = pt; lastCacheTokens = ct;
  renderInspector();
}
// Estimate how many context characters a message actually costs (mirrors the backend
// SessionMemory._msg_chars): tool-call payloads live in tool_calls[].function.arguments,
// not content, so a verbatim tail of agent turns can be far heavier than its text.
function estMsgChars(m) {
  if (!m) return 0;
  let n = (m.text || m.content || "").length;
  const tcs = m.tool_calls || m.tools || [];
  for (const tc of tcs) {
    const fn = (tc.function || tc) || {};
    n += (fn.name || "").length + ((typeof fn.arguments === "string") ? fn.arguments.length : 0) + 32;
    // tool RESULTS ride the wire too (apiMessages sends them as role:"tool") -- a single
    // read/grep back can dwarf every chat bubble. Ignoring them under-counts the estimate,
    // an over-window chat looks like it fits, the single-shot compact gets 400ed, deadlock.
    if (tc.result != null) n += String(tc.result).length;
  }
  return n;
}

// ── Chunked pre-compaction (2026-10-20) ────────────────────────────────────────
// The classic compact sent the WHOLE history + "summarise this" in one request. When the history
// itself overflowed the model window, the compact request 400ed ("context window exceeded even
// when compacting") and compaction could never run — the one escape hatch was welded shut for
// exactly the conversations that needed it most. Fix: fold the history into a summary in bounded
// chunks (each request far below the window), THEN run the normal single-shot compact on the
// condensed transcript. The user-visible flow and the post-compact tail/resume logic are unchanged.
let chunkedCompacting = false;   // true while the pre-condense loop runs (blocks send/compact re-entry)
// A (2026-11): hard cap on precondense self re-entry. precondenseAndCompact folds the history,
// then a single-shot compact fires; if THAT also overflows (full window + injection) the gateway
// 400s "even when compacting", the finalize hook rolls back and re-enters precondense -- an
// unbounded recursion that compacted 20+ times in a row. Two folds are plenty: the second runs on
// the summary+tail (far smaller). Past the cap we stop and surface a self-rescue warning.
let precondenseDepth = 0;
const PRECONDENSE_MAX = 2;   // default re-entry cap; settings.precondenseMax (drawer slider) overrides it
function precondenseCap() { const v = +settings.precondenseMax; return v >= 1 ? v : PRECONDENSE_MAX; }

// B (2026-11): calibrate the per-request injection overhead (system prompt + tool schemas +
// memory/recall) from REAL usage instead of a flat 10% guess. Near a full window the prompt is
// (messages + injection), so injection ≈ lastPromptTokens − (message chars / 1.8). A workspace whose
// rules/knowledge/schemas exceed 10% of the window made the compact budget optimistic: the
// single-shot compact request overflowed and re-entered precondense forever. A measured floor
// shrinks the budget so the compact request actually fits -- fewer chats fall into that loop.
function measuredInjectTokens() {
  if (!(maxCtx > 0) || !lastPromptTokens) return 0;
  let chars = 0;
  for (const m of messages) chars += estMsgChars(m);
  const msgTok = Math.floor(chars / 1.8);
  return Math.max(0, lastPromptTokens - msgTok);
}

function compactReqBudgetChars() {
  // One compaction request must fit the REAL model window: message chars PLUS the injected
  // overhead every request carries (system prompt + tool schemas + memory/recall) PLUS the
  // reply. The old flat 35% ignored both: an over-window chat estimated "fits", skipped the
  // chunked path, and the single-shot compact request itself got 400ed -- deadlock.
  // char scale kept at 1.8/token (zh-mixed); token floors for injection and reply.
  const perTok = 1.8;
  if (!(maxCtx && maxCtx > 0)) return 24000;
  const injectTok = Math.max(8000, Math.floor(maxCtx * 0.10), measuredInjectTokens());   // B: measured floor, not just 10%
  const replyTok = Math.max(800, Math.floor(maxCtx * 0.05));      // the summarise reply itself
  const tok = Math.max(Math.floor(maxCtx * 0.12), maxCtx - injectTok - replyTok);
  return Math.max(6000, Math.floor(tok * perTok));
}
const COMPACT_SYS = "你是对话压缩器。把给定的对话历史合并为一份紧凑但信息完整的摘要：保留任务目标、已完成的步骤与结果、关键文件/命令/数据、重要决定、未完成的事项与下一步计划。不要评论，不要客套，直接输出摘要正文。";

// User-facing tail budget for the post-compact rebuild. settings.compactTarget is the percent
// of the window the kept-verbatim tail may occupy (default 25 = the historical flat value).
// Exposed as a function so tests can assert the slider actually moves it.
function computeTailBudgetChars() {
  const pct = +settings.compactTarget || 25;
  return (maxCtx && maxCtx > 0) ? maxCtx * 3 * (pct / 100) : 1e9;
}

function renderMsgForCompact(m, cap) {
  const tag = m.role === "user" ? "[用户]" : m.role === "assistant" ? "[助手]" : "[" + (m.role || "system") + "]";
  let s = m.text || (typeof m.content === "string" ? m.content : "");
  const tcs = m.tool_calls || m.tools || [];
  if (tcs.length) s += "\n" + tcs.map((tc) => {
    const fn = (tc.function || tc) || {};
    return "[工具调用] " + (fn.name || "") + " " + (typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || ""));
  }).join("\n");
  if (m.images && m.images.length) s += ` [图片×${m.images.length}]`;
  if (m.files && m.files.length) s += ` [文件×${m.files.length}]`;
  s = (tag + " " + s).trim();
  if (s.length > cap) s = s.slice(0, cap) + "…[过长已截断]";
  return s;
}
function splitForCompact(msgs, budget) {
  const cap = Math.max(2000, Math.floor(budget * 0.5));   // no single message eats more than half a chunk
  const rendered = msgs.map((m) => renderMsgForCompact(m, cap));
  const chunks = []; let cur = []; let acc = 0;
  for (let i = 0; i < rendered.length; i++) {
    const c = rendered[i].length;
    if (cur.length && acc + c > budget) { chunks.push(cur); cur = []; acc = 0; }
    cur.push(rendered[i]); acc += c;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
// Adaptive reply cap for one chunk summarise call. The proactive guard only bypasses OUR 92% check —
// it does NOT lift the engine's hard window. So the reply must leave room for the (already-bounded)
// prompt: estimate prompt tokens conservatively (4 chars/token, English-heavy worst case) and cap the
// reply to whatever is left after a 15% safety reserve. Small-window models thus never overflow on a
// chunk, while the normal 4096 ceiling still applies to large windows (and as a fallback when maxCtx
// is unknown).
function compactChunkMaxTokens(requestChars) {
  if (!(maxCtx > 0)) return 4096;
  // Pure-frontend math: the gateway RESETS tracked occupancy for compact-flagged requests,
  // so its dynamic output ceiling assumes a near-empty window and can balloon the reply to
  // the edge. The chunk prompt is bounded by compactReqBudgetChars; the injection still
  // rides along on EVERY request, so charge for it here too before giving the reply room.
  const promptTok = Math.ceil(requestChars / 4);
  const injectTok = Math.max(8000, Math.floor(maxCtx * 0.10), measuredInjectTokens());   // B: measured floor
  const reserve = Math.floor(maxCtx * 0.05);
  const safe = maxCtx - promptTok - injectTok - reserve;
  return Math.min(4096, Math.max(800, safe));
}
// Compression is a PURE summarisation task: a long thinking chain only adds latency
// (85-181s first-token measured on the custom model) and, on a thinking-only turn,
// starves the content channel -> empty summary -> "chunked compaction failed". Cap the
// reasoning effort on BOTH compact paths (the chunked fold in llmSummarize AND the
// post-fold single-shot in streamAssistant) to a short budget. Single source: the constant
// + helper below are the only place the compact level is defined.
const COMPACT_THINK_EFFORT = "low";
function compactThinkBudget() { return thinkingBudget(COMPACT_THINK_EFFORT) || 1024; }
// One bounded summarisation request through the SAME streaming endpoint the chat uses (the gateway's
// agent loop only speaks SSE). strata_compact bypasses the proactive guard; no strata_workspace /
// recall / tool extras — this is a pure summarise call.
async function llmSummarize(userPrompt) {
  const reqChars = COMPACT_SYS.length + (userPrompt || "").length;
  const body = {model: requestModel(), stream: true, temperature: 0.2,
                max_tokens: compactChunkMaxTokens(reqChars),
                // #compactthink: summarisation needs no long chain -- cap the fold's reasoning
                // so the custom model (think_default:auto -> xhigh uncapped) stops emitting a
                // 85-181s thinking block that leaves content empty.
                reasoning_effort: COMPACT_THINK_EFFORT, reasoning_budget_tokens: compactThinkBudget(),
                messages: [{role: "system", content: COMPACT_SYS}, {role: "user", content: userPrompt}],
                strata_session: activeId, strata_compact: true};
  // #chunkretry: KV-residency contention is transient -- a compact request that the engine
  // 400s as a context overflow can clear when another session's resident slot frees. The
  // gateway turns the engine's overflow into an SSE error chunk (HTTP 200), so the retry
  // trigger lives in the stream; a 400 reaching fetchWithRetry (direct upstream) with the
  // same "exceeded" wording is caught too. Retry budget: EXACTLY ONE, and only for an
  // exceeded-shaped failure -- a genuine full-window overflow or any other error fails
  // fast like before.
  const MAX_ATTEMPTS = 2;   // 1 normal + 1 transient-contention retry
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetchWithRetry("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body)}, {retries: 1, base: 800});
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !(e && e.message && /exceeded/i.test(String(e.message)))) throw e;
      await sleep(900);
      continue;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (!r.body || !r.body.getReader) throw new Error("no stream body");
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "", out = "", reasoningAcc = "", errHit = "";
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j && j.error && typeof j.error.message === "string") { errHit = j.error.message; continue; }
          const d = j && j.choices && j.choices[0] && j.choices[0].delta;
          if (d) { if (typeof d.content === "string") out += d.content; else if (typeof d.reasoning_content === "string") reasoningAcc += d.reasoning_content; }
        } catch (e) { /* partial line or non-chat event */ }
      }
    }
    if (!out.trim()) out = reasoningAcc;   // #chunkfail: small quantized models emit reasoning-only (content_chars:0); honor "reasoning counts as content" so the summarise call is not judged empty
    if (out.trim()) return out.trim();
    if (attempt >= MAX_ATTEMPTS || !/exceeded/i.test(errHit)) break;   // not transient contention -- fail fast
    await sleep(900);   // the contention is transient: pause and re-issue this chunk once
  }
  throw new Error("empty summary");
}

async function precondenseAndCompact(auto) {
  precondenseDepth++;   // A: count this fold attempt (reset on success / after the cap fires)
  const budget = compactReqBudgetChars();
  chunkedCompacting = true;
  const original = messages;
  let tail = [];
  try {
    const chunks = splitForCompact(original, budget);
    let carry = "";
    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i].join("\n\n");
      const prompt = carry
        ? "【此前累计摘要】\n" + carry + "\n\n【对话历史片段 " + (i + 1) + "/" + chunks.length + "】\n" + part + "\n\n请把两段合并为一份更紧凑的摘要，保留全部关键信息。"
        : "【对话历史片段 " + (i + 1) + "/" + chunks.length + "】\n" + part + "\n\n请输出该片段的紧凑摘要。";
      carry = await llmSummarize(prompt);
      if (i === 0) toast("info", t("insp.compact.chunking", {i: 1, n: chunks.length}), undefined, 2500);   // noise reduction: single toast at the first fold carrying the total, not one per chunk
    }
    // Keep a small recent tail verbatim (same intent as the post-compact tail, tighter budget so the
    // final single-shot compact request is guaranteed to fit: preSummary + tail + prompt < window).
    const tailBudget = Math.floor(budget * 0.6);
    const MIN_TAIL = 2;
    let acc = 0;
    for (let i = original.length - 1; i >= 0; i--) {
      const c = estMsgChars(original[i]);
      const haveMin = tail.length >= MIN_TAIL;
      if (tail.length && ((haveMin && acc + c > tailBudget) || (c > tailBudget && tail.length >= 1))) break;
      tail.unshift(original[i]); acc += c;
    }
    messages = [{role: "system", content: "【对话压缩摘要·分段预压缩】\n" + carry}, ...tail];
    saveChat(); renderChat();
  } catch (e) {
    pendingCompact = false; resumeSnapshot = null;    // stay on the untouched history; user can retry
    messages = original;
    toast("err", t("insp.compact.chunkfail"), String(e && e.message || e), 9000);
    return;
  } finally {
    chunkedCompacting = false;   // cleared BEFORE send() — send() refuses to run while this flag is up
  }
  // Now the normal single-shot compact runs on a transcript that fits; its finish hook builds the
  // final summary structure and resumes the interrupted task exactly as before.
  ceSetText($("input"), t("insp.compact.prompt"));
  send();
}

function compactConversation(auto = false) {
  if (busy || chunkedCompacting) return;
  if (!auto) precondenseDepth = 0;   // A: a fresh manual compact restarts the fold budget from zero
  if (!auto && !confirm(t("insp.compact.confirm"))) return;
  pendingCompact = auto ? "auto" : "manual";
  // Compaction IS truncation: every compact (auto or manual) arms a resume (approved 2026-10,
  // reversing the 2026-10-19 scan-decides rule now that the 3s undo window and Stop are the
  // user's regret gates). A missed resume stalls a live task; a spurious one costs only a
  // polite closing turn. The scan still runs first so the panel and snapshot keep their signal.
  if (!resumeSnapshot) resumeSnapshot = taskResumeSnapshot() || {leftItems: null};
  // Whole history + compact prompt must fit ONE request; otherwise pre-condense in bounded chunks
  // first (the old single-shot 400ed "even when compacting" exactly on oversized histories).
  const budget = compactReqBudgetChars();
  const total = messages.reduce((s, m) => s + estMsgChars(m), 0) + t("insp.compact.prompt").length;
  if (total > budget) {
    const _byContinue = continueRequested; continueRequested = false;   // A: single-shot -> only the Continue-asked compaction skips the guard
    if (auto && autoDriveDepth > 0 && !_byContinue) { pendingCompact = false; resumeSnapshot = null; toast("warn", t("insp.compact.deferred.title"), t("insp.compact.deferred.msg"), 6000); return; }   // chain-active guard: chunking a RUNNING task is the interruption; defer to the chain tail. B: was silent, now says so.
    if (!resumeSnapshot) resumeSnapshot = taskResumeSnapshot() || {leftItems: null}; precondenseAndCompact(auto); return;
  }
  ceSetText($("input"), t("insp.compact.prompt"));
  send();
}
// F4: automatically summarise a long chat when its context reaches the model limit, so quality doesn't
// degrade and we don't hit the ceiling. Only fires while idle, with a cooldown to avoid thrashing.
let autoCompactCooldown = 0;
let autoCompactRetryTimer = null;         // one-shot re-check armed while past the threshold inside the cooldown
// Measured decode speed (content tokens/s) while the chat was small (< 40% of the window).
// The speed rule below needs a real baseline to compare against - without one it stays silent.
let speedBaseline = null;
function recordSpeedBaseline(st) {
  if (st == null || st.tokS == null || !maxCtx) return;
  if (st.prompt == null || st.prompt >= maxCtx * 0.4) return;   // only low-occupancy turns calibrate
  if ((st.completion || 0) < 20) return;                        // too few tokens -> noisy sample
  speedBaseline = speedBaseline == null ? st.tokS : Math.max(speedBaseline, st.tokS);
}
function lastTurnSpeed() {                                      // newest turn with usable speed data
  for (let i = messages.length - 1; i >= 0; i--) {
    const s = messages[i].stats;
    if (s && s.tokS != null && (s.completion || 0) >= 20) return s;
  }
  return null;
}
// Auto-resume: snapshot of the unfinished task captured right BEFORE a compaction
// (automatic or manual - approved 2026-10, the finish hook resumes both). Consumed once.
// Last-prompt check: a user message sitting after the newest assistant message was never
// answered (e.g. the user stopped mid-flight). A compaction right before such a dangling
// prompt means the task was cut short too, so it feeds the resume snapshot.
function lastTurnUnanswered() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return false;
    if (messages[i].role === "user") return true;
  }
  return false;
}
function taskResumeSnapshot() {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const open = (m.plan || []).filter((p) => !p.done).length;
    if (open) return {leftItems: open};
    if (m.autoResume || m.limit || m.canContinue || m.notice) return {leftItems: null};
    return null;
  }
  return null;
}
function maybeAutoCompact() {
  if (busy || !settings.autocompact) return;
  // Cooldown guards against BACK-TO-BACK compaction (cache thrash), not against a
  // threshold that is crossed and never acted on: when we are past the threshold NOW
  // and only the cooldown is in the way, schedule one re-check for when it expires --
  // otherwise a failed/undone compaction leaves the bar red forever (2026-10 report
  // "crossed the threshold but never compacted").
  const pastThreshold = maxCtx && lastPromptTokens && lastPromptTokens >= (autoCompactThreshold() / 100) * maxCtx;
  if (autoCompactCooldown > Date.now()) {
    if (pastThreshold && !autoCompactRetryTimer)
      autoCompactRetryTimer = setTimeout(() => { autoCompactRetryTimer = null; maybeAutoCompact(); }, autoCompactCooldown - Date.now());
    return;
  }
  if (!maxCtx || !lastPromptTokens) return;
  if (messages.length <= 6 && !(pastThreshold && (settings.compactPct > 0 || lastPromptTokens >= maxCtx * 0.95))) return;      // tiny chats stay whole -- unless the window is genuinely full
  // rule 1: window rule (unchanged) - fires at threshold% of the physical window
  let fire = lastPromptTokens >= (autoCompactThreshold() / 100) * maxCtx;
  // rule 2: speed rule - measured decode speed fell below 85% of the low-occupancy
  // baseline while we are past half the window. Whichever rule fires first wins.
  if (!fire && !settings.compactPct && speedBaseline != null && lastPromptTokens >= maxCtx * 0.5) {
    const st = lastTurnSpeed();
    const drop = +settings.speedDropPct || 50;   // slider: how far below baseline = fire (default 50%)
    if (st && st.tokS < speedBaseline * (1 - drop / 100)) fire = true;
  }
  if (fire) {
    autoCompactCooldown = Date.now() + 120000;
    compactConversation(/*auto=*/ true);
  }
}
// F5: after a real task finishes, capture its gist into the knowledge base so future sessions can recall it.
// Writes a markdown note via the filesystem server, then ingests it. Best-effort: failures are toasts, not errors.
async function maybeAutoLearn(m) {
  const s = activeSession();
  if (!s || !s.workspace || !settings.autolearn || !mcpInfo.tools) return;
  if (!((m.text && m.text.length > 40) || (m.tools && m.tools.length))) return;   // skip chit-chat
  const u = messages[messages.length - 2];
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const src = `auto-${ts}`;
    const plan = (m.plan || []).map((p) => `- ${p.done ? "[x]" : "[ ]"} ${p.label || p.text || ""}`).join("\n");
    // G3: also record the actual operations (files written, commands run, MCP tools used) so a future
    // "I edited app.js to fix X" recall can hit this note — raw task/result text alone rarely matches.
    const acts = (m.tools || []).filter((t) => t && t.name).map((t) => {
      const a = t.arguments || {};
      const detail = a.path || a.file || a.command || a.cmd || "";
      return `- ${t.name}${detail ? " · " + String(detail).replace(/\s+/g, " ").slice(0, 160) : ""}`;
    });
    const uniqActs = [...new Set(acts)];
    const note = `# 经验沉淀 ${new Date().toLocaleString()}\n\n## 任务\n${userText(u || {text: ""}) || "(见对话)"}\n\n` +
                 `## 结果摘要\n${(m.text || "").slice(0, 1500)}\n` +
                 (plan ? `\n## 计划\n${plan}\n` : "") +
                 (uniqActs.length ? `\n## 实际操作\n${uniqActs.join("\n")}\n` : "");
    const path = `${s.workspace.replace(/\/$/, "")}/.strata-memory/${src}.md`;
    await fsWrite(path, note);                                   // throws when the write fails
    await mcpCall("memory", "ingest", {path, source: src});      // throws when the tool fails
    toast("ok", t("toast.learn.ok"), src);
  } catch (e) { toast("warn", t("toast.learn.fail"), e.message, 5000); }
}
$("inspector-toggle").onclick = () => {
  inspectorOpen = !inspectorOpen;
  if (inspectorOpen) document.body.classList.remove("ins-collapsed");
  store.set("inspector.open", inspectorOpen);
  store.set("ins.collapsed", document.body.classList.contains("ins-collapsed"));
  applyInspector(); syncInspectorTitle();
};
$("inspector-collapse").onclick = () => {
  document.body.classList.toggle("ins-collapsed");
  store.set("ins.collapsed", document.body.classList.contains("ins-collapsed"));
  syncInspectorTitle(); layoutHandles();
};
$("ins-compact").onclick = compactConversation;
// Auto-resume undo: delegation lives on the note itself (same direct-attach precedent as
// #ins-compact). The undo button only exists in the HTML while pendingResume is set, and the
// dataset._h cache refreshes the row as soon as the window closes or the cancel lands.
const noteEl = $("ins-ctx-note");
if (noteEl) noteEl.onclick = (e) => {
  if (!pendingResume || !e.target.closest('[data-action="resume-undo"]')) return;
  clearTimeout(pendingResume.timer);
  pendingResume = null;
  resumeBadge = null;   // don't let the cancelled resume leak its "自动续跑" badge onto the next stream
  renderInspector();
  toast("ok", t("chat.resume.cancelled"));
};
// Turn-stop notice text. The server sends a machine-readable code (+ numbers), the wording
// lives here so it stays translatable; both languages are maintained in i18n.js.
function noticeText(n) {
  if (!n) return "";
  if (n.code === "turn_budget") return t("chat.notice.budget", {m: Math.round((n.budget_s || 0) / 60), n: n.rounds || 0});
  if (n.code === "idle") return t("chat.notice.idle", {s: n.idle_s || 0});
  if (n.code === "rounds") return t("chat.notice.rounds", {n: n.rounds || 0});
  if (n.code === "max_tokens") return n.text || t("chat.notice.max_tokens", {n: n.max_tokens || 0});
  if (n.code === "empty_round") return n.text || t("chat.notice.empty_round");
  if (n.code === "context_overflow") return n.text || t("chat.notice.context_overflow");
  return n.text || t("chat.notice.generic");
}
// Banners under an answer (error / stop notice). Exactly ONE of each, updated in place.
// Appending them per repaint was the reason a single stop could show up as several identical
// red boxes: every rAF between the error and the end of the turn added another node.
function syncBanners(bubble, m) {
  const put = (cls, text) => {
    const old = bubble.querySelector(`:scope > .${cls}`);
    if (!text) { if (old) old.remove(); return; }
    if (old) { if (old.textContent !== text) old.textContent = text; return; }
    const node = document.createElement("div");
    node.className = cls;
    node.textContent = text;
    bubble.appendChild(node);
  };
  const cut = m.truncated
    ? t(m.gatewayDown ? "chat.notice.gateway_down" : "chat.notice.truncated",
        {tool: inflightToolName(m) ? `（卡在 ${inflightToolName(m)}）` : ""})
    : "";
  put("msg-notice", (m.resumeExhausted ? t("resume.stopped", {n: m.resumeExhausted}) : "") || noticeText(m.notice) || cut);
  put("msg-error", m.error || "");
}
// The tool that was still in flight when the stream died — the one the user sees frozen at
// "未运行". Naming it turns "连接中断" into "it broke at this step", which is what makes the
// next attempt actionable.
function inflightToolName(m) {
  const ts = (m && m.tools) || [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const t0 = ts[i];
    if (t0.state === "running" || t0.state === "writing") return t0.name || t0.tool;
    if ((t0.state === "skipped" || t0.state == null) && t0.ok === undefined && !t0.result) {
      return t0.name || t0.tool;
    }
  }
  return "";
}
// A cut stream has two very different causes, and the fix is different for each: the turn died
// inside a live gateway (press Continue), or the gateway process is gone (restart it). One cheap
// probe tells them apart instead of leaving the user with a vague "连接中断".
async function gatewayIsDown() {
  try {
    const r = await fetch("api/models", {headers: headers(), signal: AbortSignal.timeout(1500)});
    return !r.ok;
  } catch (e) { return true; }
}
function updateAssistant(el, m, streaming) {
  const bubble = el.querySelector(".st-bubble");
  // A mid-stream error (e.g. a server error chunk) must NOT wipe the tool calls / partial
  // text already on screen — show the answer that arrived, then append the error as a banner.
  // Reasoning counts as content: a turn that is still only thinking must render its thought segments.
  const hasContent = m.text || m.reasoning || (m.tools && m.tools.length);
  if (m.error && !hasContent) {
    bubble.innerHTML = "";
  } else {
    if (!hasContent && streaming) {
      // keep the placeholder node while it is already on screen: re-creating it restarts the caret's blink
      if (!bubble.querySelector(".cursor")) {
        bubble.innerHTML = `<span class="cursor"></span>`;
      }
    } else {
      paintBubble(bubble, m, streaming);
      if (streaming) bubble.classList.add("cursor"); else bubble.classList.remove("cursor");
    }
  }
  syncBanners(bubble, m);
  renderNextSteps(el, m);
  renderProposals(el, m);
  const cont = el.querySelector(".continue-btn");
  if (cont) cont.hidden = !((m.limit || m.canContinue) && !streaming);
  // Per-turn stats footer: duration / output speed / token flow / context usage
  renderStats(el, m, streaming);
  el.querySelector(".meta-text").textContent = m.meta || (streaming ? "" : m.stopped ? t("stat.stopped") : "");
  el.querySelector("[data-msg-copy]").hidden = streaming || !m.text;
  syncFoldBtn(el);
  if (busy && busy.msg === m) followStream(el, m);        // keep the growing thought / answer in view
}
// A finished turn folds itself: every thought is reduced to its one-line summary. This button is the way back
// in (and the way to fold everything again) once a turn has more than one block worth looking at.
function syncFoldBtn(el) {
  const btn = el.querySelector("[data-action='fold']");
  if (!btn) return;
  if (el.querySelectorAll(".st-think, .tool-call").length < 2) { btn.hidden = true; return; }
  const anyClosed = !!el.querySelector(".st-think:not([open]), .tool-call:not([open])");
  btn.hidden = false;
  btn.textContent = anyClosed ? t("chat.expand.all") : t("chat.fold.all");
  btn.dataset.mode = anyClosed ? "expand" : "fold";
}
function foldAll(el, m) {
  const btn = el.querySelector("[data-action='fold']");
  const expand = !!(btn && btn.dataset.mode === "expand");
  m.thinkOpen = m.thinkOpen || {};
  el.querySelectorAll(".st-think").forEach((d) => {
    m.thinkOpen[d.dataset.slot] = expand;
    const body = d.querySelector(".st-collapse__body");
    if (expand && body && d._src && !body.textContent) body.textContent = d._src;
  });
  (m.tools || []).forEach((tool) => { tool._userTouched = true; tool.open = expand; });
  updateAssistant(el, m, !!busy && busy.msg === m);
}
// While a turn streams, an OPEN block has two ways to hide its newest text: the chat can scroll away from it,
// and a long thought / tool output scrolls inside its own box (max-height). followStream handles the inner
// scroll; scrollDown() handles the container, aiming at the tail instead of blindly at the document end.
function followStream(el, m) {
  if (!streamingFollow) return;
  el.querySelectorAll(".thinking, .tool-call__pre").forEach((n) => {
    if (n._noFollow) return;                              // the user scrolled this box to read - leave it alone
    if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = n.scrollHeight;
  });
}
// Build the per-turn stats footer: duration, output speed, token flow, context occupancy.
// While streaming we only show a live ticking timer (+ "生成中"); the full set appears once the turn ends.
//
// IMPORTANT — do not rebuild this row wholesale while streaming. `updateAssistant` (which calls us) is
// driven by `paint()` on every animation frame, so during token flow this function ran ~60x/second and
// each call re-wrote `box.innerHTML`. That tore down and re-inserted every chip + icon SVG each frame,
// which showed up as the badges "flickering". So: the live row is built ONCE and afterwards only its
// text nodes are mutated; the final row is written once and cached by a signature (identical repaints
// are no-ops). Same in-place discipline as the answer/tool segments.
function renderStats(el, m, streaming) {
  const box = el.querySelector(".msg-stats");
  if (!box) return;
  // tool-round progress: how many rounds have run so far, and the cap if the server reported it
  const rounds = (m.tools || []).map((x) => x.round).filter((r) => r != null);
  const maxRound = rounds.length ? Math.max(...rounds) : 0;
  const roundText = maxRound ? (m.limit ? t("stat.round.max", {n: maxRound, max: m.limit}) : t("stat.round", {n: maxRound})) : "";
  const roundChip = roundText ? (m.limit
      ? `<span class="stat" title="${esc(t("stat.round.max", {n: maxRound, max: m.limit}))}">${icon("tool", "st-icon st-icon--xs")}<span>${esc(t("stat.round.max", {n: maxRound, max: m.limit}))}</span></span>`
      : `<span class="stat" title="${esc(t("stat.round", {n: maxRound}))}">${icon("tool", "st-icon st-icon--xs")}<span>${esc(t("stat.round", {n: maxRound}))}</span></span>`)
    : "";
  if (streaming) {
    if (m.startAt == null) { box.hidden = true; return; }
    const ms = performance.now() - m.startAt;
    const phase = (!m.text && m.reasoning) ? t("stat.thinking") : t("stat.generating");   // D12: tell thinking from generating
    box.hidden = false;
    // Stable skeleton, created once per message element; later ticks touch text only (never innerHTML).
    if (box.dataset.mode !== "live" || !box.querySelector(".stat--dur")) {
      box.dataset.mode = "live";
      box._sig = null;
      box._seedSig = null;                       // 2026-11: progressive-reveal seed chip tracks its own sig, same anti-flicker idea as _sig
      box.innerHTML =
        `<span class="stat stat--dur">${icon("clock", "st-icon st-icon--xs")}<span class="stat__v"></span></span>` +
        `<span class="stat stat--live"></span>` +
        `<span class="stat stat--round" hidden></span>` +
        `<span class="stat stat--seed" hidden></span>`;
    }
    const v = box.querySelector(".stat--dur .stat__v");
    if (v) { const txt = fmtClock(ms); if (v.textContent !== txt) v.textContent = txt; }
    const live = box.querySelector(".stat--live");
    if (live && live.textContent !== phase) live.textContent = phase;
    const rc = box.querySelector(".stat--round");
    if (rc) {
      if (!roundText) rc.hidden = true;
      else {
        rc.hidden = false;
        if (!rc.firstChild) rc.innerHTML = `${icon("tool", "st-icon st-icon--xs")}<span></span>`;
        const rcTxt = rc.querySelector("span");
        if (rcTxt && rcTxt.textContent !== roundText) rcTxt.textContent = roundText;
        if (rc.title !== roundText) rc.title = roundText;
      }
    }
    // 方案A progressive-reveal: a send-time seed is ALREADY known (m.seed set in send()), so light it
    // up during streaming instead of waiting for the finish row. Mirrors the finished-row seed chip
    // exactly (class/data-seed/role/tabindex/title/icon + t() keys); the #chat click-copy handler uses
    // closest()+data-seed so this same-container live chip is clickable too. Only rewrite on change.
    const scv = box.querySelector(".stat--seed");
    if (scv) {
      if (m.seed == null) { scv.hidden = true; }   // honest guard: the chip stays hidden until a seed exists
      else {
        const ssig = String(m.seed) + "|" + (m.seedPinned ? "p" : "");
        if (box._seedSig !== ssig) {
          box._seedSig = ssig;
          scv.hidden = false;
          scv.setAttribute("role", "button"); scv.tabIndex = 0;
          scv.dataset.seed = String(m.seed);
          scv.title = t("stat.seed.tip");
          scv.innerHTML = `${icon(m.seedPinned ? "pin" : "refresh", "st-icon st-icon--xs")}<span></span>`;
          scv.querySelector("span").textContent = t("stat.seed", {n: m.seed});
        }
      }
    }
    return;
  }
  const s = m.stats;
  if (!s) { box.hidden = true; return; }
  const parts = [];
  parts.push(`<span class="stat stat--dur" title="${esc(t("stat.duration.tip", {d: fmtDurLong(s.dur)}))}">` +
    `${icon("clock", "st-icon st-icon--xs")}<span>${esc(fmtDur(s.dur))}</span></span>`);
  if (s.thinkSecs != null)
    parts.push(`<span class="stat" title="${esc(t("stat.think", {s: fmt(s.thinkSecs, 1)}))}">${icon("thinking", "st-icon st-icon--xs")}<span>${esc(t("stat.think", {s: fmt(s.thinkSecs, 1)}))}</span></span>`);
  if (s.tokS != null) {
    const spd = s.reasoningTokens != null ? t("stat.out", {s: fmt(s.tokS, 1)}) : `${fmt(s.tokS, 1)} tok/s`;   // D12: relabel as output speed when split is known
    parts.push(`<span class="stat" title="${esc(t("stat.speed.tip"))}">${icon("gauge", "st-icon st-icon--xs")}<span>${esc(spd)}</span></span>`);
  }
  if (s.thinkTokS != null)   // D12: show reasoning-phase speed too, when the engine reports reasoning tokens
    parts.push(`<span class="stat" title="${esc(t("stat.think.spd.tip"))}">${icon("thinking", "st-icon st-icon--xs")}<span>${esc(t("stat.think.spd", {s: fmt(s.thinkTokS, 1)}))}</span></span>`);
  if (s.prompt != null || s.completion != null)
    parts.push(`<span class="stat" title="${esc(t("stat.tokens.tip"))}">${icon("layers", "st-icon st-icon--xs")}` +
      `<span>${kfmt(s.prompt)} → ${kfmt(s.completion)}</span></span>`);
  if (s.ctxMax && s.ctxUsed != null) {          // ctxUsed is null when the engine never reported usage
    const pct = Math.round(100 * s.ctxUsed / s.ctxMax);
    const tone = pct >= 90 ? "danger" : pct >= 75 ? "warn" : "ok";
    parts.push(`<span class="stat stat--ctx stat--${tone}" title="${esc(t("stat.context.tip", {used: ctxfmt(s.ctxUsed), max: ctxfmt(s.ctxMax)}))}">` +
      `${icon("cpu", "st-icon st-icon--xs")}<span>${pct}%</span></span>`);
  }
  // A turn that died before the engine reported usage still gets its footer (duration / thinking /
  // rounds); say why the token chips are missing instead of silently dropping the whole row.
  if (s.partial) parts.push(`<span class="stat" title="${esc(t("stat.nousage.tip"))}">${esc(t("stat.nousage"))}</span>`);
  if (roundChip) parts.push(roundChip);
  // plan-complete badge: this turn's own checklist fully ticked -> echo the panel's completion
  // signal down in the footer chip row (mirrors insp.plan.complete).
  const _fp = m.plan || [];
  if (_fp.length && _fp.every((p) => p.done))
    parts.push(`<span class="stat stat--done" title="${esc(t("stat.plan.done.tip"))}">` + `${icon("check", "st-icon st-icon--xs")}<span>${esc(t("stat.plan.done"))}</span></span>`);
  // The seed belongs in this row, next to the other per-turn figures: it is a property of THIS
  // generation, not of the app. Click copies it (delegated handler on #chat) so it can be pasted
  // back into the drawer to replay the turn.
  if (s.seed != null) {
    parts.push(`<span class="stat stat--seed" role="button" tabindex="0" data-seed="${esc(String(s.seed))}"` +
      ` title="${esc(t("stat.seed.tip"))}">` +
      `${icon(s.seedPinned ? "pin" : "refresh", "st-icon st-icon--xs")}` +
      `<span>${esc(t("stat.seed", {n: s.seed}))}</span></span>`);
  }
  box.hidden = !parts.length;
  // The finished row is static; only rewrite when something really changed (a late usage chunk, a
  // re-render). This keeps the end-of-turn repaint from flashing the chips.
  const sig = parts.join("");
  if (box.dataset.mode === "final" && box._sig === sig) return;
  box.dataset.mode = "final";
  box._sig = sig;
  box.innerHTML = sig;
}
// A/B shared entry: force one live paint of the running turn NOW, bypassing the rAF scheduler (which the
// browser pauses on hidden pages). No-op when nothing is streaming or the turn lives in a viewed-away session.
function paintLive() {
  if (!busy) return;
  const el = liveMsgEl(busy.msg);
  if (el) updateAssistant(el, busy.msg, true);
}
function renderChat() {
  const chat = $("chat");
  chat.querySelectorAll(".st-msg").forEach((e) => e.remove());
  $("chat-empty").hidden = messages.length > 0;
  messages.forEach((m, i) => chat.appendChild(msgEl(m, i)));
  scrollDown(true);
  renderBranchBar();
  if (busy) paintLive();   // B: on switching back, paint immediately if a turn is live -- do not wait for the next rAF-scheduled chunk
}
let streamingFollow = true;            // while a turn streams, stick to the newest content
function nearBottom() { const s = $("chat-scroll"); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; }
// Where the newest text actually is: the tail segment of the running turn, or - when that tail is an open
// thought / tool block - the body inside it (a closed block only shows its one-line summary, so aim at it).
// The on-screen .st-msg node that currently represents message `m` IN THIS session,
// or null when `m` lives in another (viewed-away) session -- same judgement as
// liveTailEl. Callers must skip the DOM write and only accumulate data when it is
// null; switching back runs renderChat, which rebuilds from the messages array and
// shows everything that accumulated meanwhile.
function liveMsgEl(m) {
  if (!busy || busy.msg !== m || busy.sessionId !== activeId) return null;
  const idx = messages.indexOf(m);
  if (idx < 0) return null;
  for (const e of $("chat").querySelectorAll(".st-msg")) if (+e.dataset.i === idx) return e;
  return null;
}
function liveTailEl() {
  if (!busy || !busy.msg) return null;
  const list = $("chat").querySelectorAll(".st-msg");
  const el = list.length ? list[list.length - 1] : null;
  if (!el || +el.dataset.i !== messages.indexOf(busy.msg)) return null;
  const ans = el.querySelector(".ans");
  let last = ans && ans.lastElementChild;
  if (!last) return null;
  // Work-log folding: the growing segment (live thought / running tool) sits INSIDE the group, while the
  // group's trailing sibling is just the (still empty) final-answer md. Descend into the open group first.
  if (last.classList.contains("st-steps") && last.open) {
    const inner = last.querySelector(".st-steps__body");
    const innerLast = inner && inner.lastElementChild;
    if (innerLast) last = innerLast;
  }
  if (last.open && (last.classList.contains("st-think") || last.classList.contains("tool-call"))) {
    return last.querySelector(".st-collapse__body") || last;
  }
  return last;
}
// Scroll just enough to bring `n` into view - unlike scrollIntoView it never yanks a block taller than the
// viewport to the top, because the interesting end of a growing block is its bottom.
function revealNode(n, s) {
  if (!n || !s || !s.getBoundingClientRect) return;
  const r = n.getBoundingClientRect(), sr = s.getBoundingClientRect();
  const over = r.bottom - (sr.bottom - 12);
  if (over > 0) { s.scrollTop += over; return; }
  if (r.top < sr.top + 12 && r.height < sr.height - 24) s.scrollTop -= (sr.top + 12 - r.top);
}
function revealBlock(d) { try { d.scrollIntoView({block: "nearest"}); } catch (e) { /* jsdom */ } }
function scrollDown(force) {
  const s = $("chat-scroll");
  if (force) { s.scrollTop = s.scrollHeight; return; }                       // explicit jump (render / button)
  if (busy && streamingFollow) {                                             // streaming: follow live thinking/output
    const tail = liveTailEl();
    // Aim at the MESSAGE, not only at its text tail. The turn renders more BELOW the tail than just
    // text: the live stats footer (`.st-msg__meta`) and, once it lands, the next-step chips. Revealing
    // only the tail left those rows parked under the fold, half-cut by the composer's top edge -- the
    // "底部徽标跑到对话框下面被遮住" report. The message bottom IS the newest content, so this shows
    // strictly more, never less.
    const host = tail && tail.closest ? tail.closest(".st-msg") : null;
    if (host) revealNode(host, s);
    else if (tail) revealNode(tail, s);
    else s.scrollTop = s.scrollHeight;
    return;
  }
  if (nearBottom()) s.scrollTop = s.scrollHeight;                            // idle: only if already near bottom
}
// A finished turn grows rows at its own bottom: the full stats footer replaces the live timer and the
// next-step chips land underneath the answer. The idle branch above only snaps when already "near
// bottom" (120px) -- a chips block is taller than that, so the last row stayed just below the fold and
// read as "被对话框切掉". When the user is still following, go all the way down instead.
function settleBottom() {
  if (streamingFollow) scrollDown(true);
}
// Auto-follow shows the live tail while a turn streams; pausing (scroll up to read) reveals a "jump to latest" pill.
(function setupAutoScroll() {
  const s = $("chat-scroll"), btn = $("scroll-latest");
  s.addEventListener("scroll", () => {
    // Track "near bottom" in both idle (reading history) and streaming modes: scrolling up
    // reveals the "jump to latest" pill; returning to the bottom hides it again.
    streamingFollow = nearBottom();             // back to bottom -> resume; scrolled up -> pause
    btn.hidden = streamingFollow;               // show the pill only while paused
  });
  btn.onclick = () => { streamingFollow = true; scrollDown(true); btn.hidden = true; };
})();

$("chat").addEventListener("click", (e) => {
  const cc = e.target.closest("[data-code-copy]");
  if (cc) { copyText(cc.closest(".st-code").querySelector("pre").textContent, cc); return; }
  const mc = e.target.closest("[data-msg-copy]");
  if (mc) { const i = +mc.closest(".st-msg").dataset.i; copyText(messages[i].text, mc); return; }
  // the footer's seed chip: one click puts the number on the clipboard (to paste back into the drawer)
  const sc = e.target.closest(".stat--seed");
  if (sc && sc.dataset.seed) { copyText(sc.dataset.seed); return; }
  // --- Continue: resume a task that hit the MCP tool-round limit ---
  const cont = e.target.closest('[data-action="continue"]');
  if (cont) { continueTask(cont); return; }
  // --- Next-step chips: click TOGGLES the selection (click again to unselect) ---
  const ns = e.target.closest(".next-step");
  if (ns) {
    const i = +ns.dataset.step;
    const host = ns.closest(".st-msg");
    const mm = messages[+host.dataset.i];
    const s = mm && mm.steps && mm.steps[i];
    if (s) {
      if (!mm.selSteps) mm.selSteps = [];
      const at = mm.selSteps.indexOf(i);
      if (at >= 0) mm.selSteps.splice(at, 1); else mm.selSteps.push(i);
      renderNextSteps(host, mm);
      settleBottom();     // picking a chip reveals the "发送" action row: keep it above the composer too
    }
    return;
  }
  const nsSend = e.target.closest("[data-steps-send]");
  if (nsSend) { sendSelectedSteps(messages[+nsSend.closest(".st-msg").dataset.i]); return; }
  const nsClear = e.target.closest("[data-steps-clear]");
  if (nsClear) {
    const host = nsClear.closest(".st-msg");
    const mm = messages[+host.dataset.i];
    if (mm) { mm.selSteps = []; renderNextSteps(host, mm); settleBottom(); }
    return;
  }
  // --- Proposal decision cards: adopt / save / dismiss ---
  const pb = e.target.closest("[data-prop-act]");
  if (pb) {
    const host = pb.closest(".st-msg");
    const mm = messages[+host.dataset.i];
    const gi = +pb.dataset.prop, act = pb.dataset.propAct, oi = pb.dataset.opt != null ? +pb.dataset.opt : null;
    const p = mm && mm.proposals && mm.proposals[gi];
    if (p) handleProposalAction(host, mm, p, act, oi);
    return;
  }
  // --- P0-1: message actions ---
  const act = e.target.closest("[data-action]");
  if (act) {
    const i = +act.closest(".st-msg").dataset.i;
    const action = act.dataset.action;
    if (action === "copy") { copyText(messages[i].text, act); return; }
    if (action === "fold") { foldAll(act.closest(".st-msg"), messages[i]); return; }
    if (action === "edit") { openEditModal(i); return; }
    if (action === "regen") { doRegenerate(i); return; }
    if (action === "delete") { deleteMessage(i); return; }
  }
  // a tool block: its open state lives in the message (the answer is rebuilt while it streams), so the click sets it
  const sum = e.target.closest(".tool-call > summary");
  if (sum) {
    e.preventDefault();
    const el = sum.closest(".st-msg"), m = messages[+el.dataset.i], t = m && m.tools && m.tools[+sum.parentElement.dataset.tool];
    if (!t) return;
    t.open = !t.open;
    t._userTouched = true;                         // a manual toggle wins over the auto expand/collapse
    updateAssistant(el, m, !!busy && busy.msg === m);
    if (t.open) revealBlock(sum.parentElement);
  }
});
// A thought the user opens keeps that state per slot (the answer is rebuilt while it streams), and its body is
// filled here because - like a tool result - it is only built when something is actually looking at it.
$("chat").addEventListener("toggle", (e) => {
  const d = e.target;
  if (d.tagName !== "DETAILS" || !d.classList.contains("st-think")) return;
  const host = d.closest(".st-msg");
  if (!host) return;
  const m = messages[+host.dataset.i];
  if (!m) return;
  if (d.open === d._want) return;                 // our own auto open/close, not the user's
  m.thinkOpen = m.thinkOpen || {};
  m.thinkOpen[d.dataset.slot] = d.open;
  const body = d.querySelector(".st-collapse__body");
  if (d.open && body && !body.textContent && d._src) body.textContent = d._src;
  if (d.open) revealBlock(d);
}, true);
// Scrolling inside an expanded thought / tool output means "I'm reading this" - stop dragging it to the bottom.
$("chat-scroll").addEventListener("scroll", (e) => {
  const n = e.target;
  if (!n || n === $("chat-scroll") || !n.classList) return;
  if (!n.classList.contains("thinking") && !n.classList.contains("tool-call__pre")) return;
  n._noFollow = n.scrollHeight - n.scrollTop - n.clientHeight > 40;
}, true);

// The workspace-specific system prompt (working dir + plan/next-steps conventions). Kept as a helper
// so apiMessages can compose it with the always-on base prompt, persona, and RAG context.
function workspaceSystem(ws) {
  let txt = `Working directory: ${ws}\nThe agent reads, writes, and runs commands in this folder. Use it as the default target for file and shell operations.\n\n【plan 防幻觉硬约束】下面的计划清单必须用 markdown 三个反引号围起来的 \`\`\`plan 围栏书写，它【不是】工具调用——绝不要把它写成 <function=plan>、<parameter>、\`tool_call\` 这类 XML 工具调用语法（把 markdown 围栏幻觉成工具语法会让本动作被解析器丢弃、整轮空转并中断任务）。
任务若包含多个步骤，请在执行过程中用下面的「计划清单」格式跟踪进度：每完成一项就把对应的 [ ] 改成 [x]。清单放在回答开头附近（不要放进代码块以外的地方造成歧义），右侧面板会把它渲染成进度条。若任务很简单（一步完成），可以不输出：\n\`\`\`plan\n- [ ] 第一步\n- [x] 第二步（已完成）\n- [ ] 第三步\n\`\`\`\n\n执行命令或写文件后，务必确认结果符合预期（读回文件内容、查看命令输出）；若出现报错，先修复再继续，不要在未验证时就宣布任务完成。\n\n当你判断一项任务已经彻底完成（不再需要调用任何工具）时，在回答的末尾用下面格式给出 2-5 条「下一步建议」，每条一句话、可作为按钮直接点击执行。用行首符号标注优劣（前端据此分色、并据此决定是否自动续跑——颜色即决定）：\n- 行首 \`*\`：你真正推荐、净收益高且风险低的（置顶、绿色、标「推荐」，自动续跑会跑它）；\n- 行首无符号的 \`-\`：可选、中性、值得顺手做的（排中间、黄色，自动续跑会跑它）；\n- 行首 \`!\`：你不推荐、坏处多或风险高的（排最后、红色、标「不推荐」，自动续跑绝不自动跑它，仅由用户决定）；\n- 行首 \`?\`：你已列出但在**等用户真实回复/需要用户拍板或自定义**的（蓝色、标「等你确认」，自动续跑绝不自动跑它——这是防止自我复读的停等信号）。\n重要：当你这一轮其实是在等用户拍板（需要决策、或该等用户真实回复/自定义）时，照旧输出 next-steps 块（含决策卡的轮次前端整轮不自动跑——绿/黄条照出、可点、但不会被自动跑掉），别给自己塞一个会被自动跑的建议而推进自我复读。\n若任务尚未完成，不要输出这个代码块：\n\`\`\`next-steps\n* 推荐项\n- 可选项\n! 不推荐项\n\`\`\``;
  // H2.5: decision proposals should also use the 推荐 / 不推荐 verdict so the UI can tier them.
  txt += `\n\n当你用「决策卡」给出多方案对比（proposal 代码块）时，给每个选项填 verdict：用 "推荐" 标注你最建议采纳的、"不推荐" 标注坏处多/风险高但用户仍可能考虑的，其余留空或写中性结论。前端会把"推荐"标绿置顶、"不推荐"标琥珀排最后。`;
  // H2: autonomous memory maintenance. The agent may discover durable, cross-task memory during a
  // task and proposes (never writes) it via fenced blocks. When auto-memory is ON there is no human
  // gate, so the brief is stricter; when OFF the proposals stage as drafts for approval.
  const memOn = settings.autoMemory;
  const memBlock = (block, grounded, auto) => {
    let what;
    if (block === "propose-rules") what = "可跨任务复用、且本次已经**实际验证过**的稳定操作约定（文件/目录布局、构建部署命令、编码命名铁律、权限审批模型、已知易错点）";
    else if (block === "propose-knowledge") what = "已确认的事实、接口怪癖、环境结论（编码/语言环境、依赖版本、工具链行为）";
    else what = "一次真实决策的复盘：用「上下文 → 决策 → 结果 → 复盘」一句话记录可复用经验";
    const gate = auto
      ? "用户已开启「自主维护记忆」：新条目会被**直接写入**对应文件并在之后每次对话生效，且可一键撤销。因此只写你确认过的事实，不要写猜测、临时方案或一次性做法，不要重复已有条目，也不要在正文里自行写文件。"
      : "前端会生成待审批草稿，绝不会自动生效，你也不要在正文里自行写入文件。";
    const label = block === "propose-rules" ? "工作规则" : block === "propose-knowledge" ? "知识库" : "经验库";
    return `\n\n【沉淀${label}】${gate}\n当你在任务中发现${what}，在本回答末尾用下面格式给出（每条一行、简洁可执行）：\n\`\`\`${block}\n- 条目一\n- 条目二\n\`\`\``;
  };
  txt += memBlock("propose-rules", true, memOn);
  txt += memBlock("propose-knowledge", false, memOn);
  txt += memBlock("propose-experience", false, memOn);
  // 2026-10: the wording iron law — clickable executable tiers must read as imperative so a
  // click is a decision, not a question; and the "?" tier must ship an explicit default so a
  // click means "ratify the default" and the agent must not re-ask.
  txt += `\n\n【建议条措辞铁律】凡「可执行档」（推荐 * / 一般 - / 不推荐 !）的建议必须写成祈使陈述句（例：「跑一遍全套回归」），不要写成疑问句或「让用户补一下信息」的句子——用户点击即代表拍板执行，你不得再反问；「? 等你确认」档必须在本轮正文里写明你建议的默认值/默认方案（例：「默认取 16384 词」），因为用户点击 = 授权按该默认执行，你不得反问；若确实无法预设默认值（真正开放的问题），改用决策卡 proposal 或在正文里直陈，不要放进 ? 档。`;
  // H2: always-on memory, composed from THREE scopes in precedence order (lowest first): global ->
  // group -> workspace. Later, more specific tiers can refine/override earlier ones. Global entries
  // apply to every workspace (universal); group entries to every workspace in that group (the
  // "between workspaces" tier); workspace entries are this project's specifics.
  const grp = currentGroup;
  if (globalRules && globalRules.trim()) {
    txt += `\n\n【全局操作约定（所有工作空间通用，务必遵守）】\n${globalRules.trim()}`;
  }
  if (grp && groupRules && groupRules.trim()) {
    txt += `\n\n【工作区间操作约定（${grp} 组通用，务必遵守）】\n${groupRules.trim()}`;
  }
  if (workspaceRules && workspaceRules.trim()) {
    txt += `\n\n【本工作空间操作约定（已固化，务必遵守）】\n${workspaceRules.trim()}`;
  }
  if (globalKnowledge && globalKnowledge.trim()) {
    txt += `\n\n【全局知识库（所有工作空间通用）】\n${globalKnowledge.trim()}`;
  }
  if (grp && groupKnowledge && groupKnowledge.trim()) {
    txt += `\n\n【工作区间知识库（${grp} 组通用）】\n${groupKnowledge.trim()}`;
  }
  if (workspaceKnowledge && workspaceKnowledge.trim()) {
    txt += `\n\n【本工作空间知识库】\n${workspaceKnowledge.trim()}`;
  }
  if (globalExperience && globalExperience.trim()) {
    txt += `\n\n【全局经验库（所有工作空间通用）】\n${globalExperience.trim()}`;
  }
  if (grp && groupExperience && groupExperience.trim()) {
    txt += `\n\n【工作区间经验库（${grp} 组通用）】\n${groupExperience.trim()}`;
  }
  if (workspaceExperience && workspaceExperience.trim()) {
    txt += `\n\n【本工作空间经验库】\n${workspaceExperience.trim()}`;
  }
  // Design-doc language: keep filename + body language consistent with the chosen policy.
  const _dl = settings.designLang || "auto";
  if (_dl === "zh") {
    txt += "\n\n【设计文档语言】当用户请求你输出设计/任务文档（`design` 代码块）时，必须用简体中文撰写，包括作为文件名的标题。";
  } else if (_dl === "en") {
    txt += "\n\n【Design document language】When asked to output a design/task document (a `design` code block), write it in English, including the title that becomes the filename.";
  } else {
    txt += "\n\n【设计文档语言】设计/任务文档（`design` 代码块）请使用与当前对话相同的语言撰写（包括作为文件名的标题）；若对话混用，以用户主要语言为准。";
  }
  return txt;
}
function apiMessages() {
  const out = [];
  // F1: always-on base prompt (also enforces Chinese output) — present even with no workspace.
  // 强制中文思考·首因位置：规则放在 BASE_SYSTEM 之前，强化注意力锚定（方案 A）。
  out.push({role: "system", content: (settings.cnThink ? CN_THINK_RULE : "") + BASE_SYSTEM});
  // F2: persistent persona (per-session wins; falls back to the global default in settings).
  const persona = ((activeSession() || {}).persona || settings.persona || "").trim();
  if (persona) out.push({role: "system", content: "【人设与长期偏好】\n" + persona});
  // Workspace conventions.
  const ws = (activeSession() || {}).workspace;
  if (ws) out.push({role: "system", content: workspaceSystem(ws)});
  // F3: knowledge retrieved for this turn (empty unless recall returned something useful).
  if (lastRag && lastRag.trim()) out.push({role: "system", content:
    "【已检索到的相关经验知识（仅供参考，若与当前问题无关请忽略）】\n" + lastRag.trim()});
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = (m.images || []).filter((i) => i.url);
      const text = userText(m);
      const segs = mixedSegments(m);
      if (segs) {
        // placeholders present: emit text/image blocks in the order the user placed them (OpenAI
        // multimodal accepts any text<->image order). file attachments are appended as trailing text.
        const blocks = segs.map((sg) => (sg.type === "image"
          ? {type: "image_url", image_url: {url: sg.wire}}
          : {type: "text", text: sg.text.trim()})).filter((b) => b.type === "image_url" || b.text);
        const fileTxt = (m.files || []).filter((f) => f.text != null).map(fileBlock).join("\n\n");
        if (fileTxt) blocks.push({type: "text", text: fileTxt});
        out.push({role: "user", content: blocks.length ? blocks : text});
      } else {
        out.push({role: "user", content: imgs.length ? [{type: "text", text},
          ...imgs.map((i) => ({type: "image_url", image_url: {url: wireImageUrl(i)}}))] : text});
      }
    } else if (!(busy && busy.msg === m)) {            // the answer being asked for now is not history yet
      out.push(...assistantMessages(m));
    }
  }
  return out;
}
// F3-enh (G2): build a recall query that survives short follow-up turns. A bare "继续" / "为什么" /
// "改一下" would make a keyword recall miss; fall back to / concatenate the previous user message instead
// so multi-turn conversations still retrieve the right experience.
function recallQuery() {
  const us = messages.filter((m) => m.role === "user").map((m) => userText(m).trim()).filter(Boolean);
  if (!us.length) return "";
  const last = us[us.length - 1];
  const prev = us.length >= 2 ? us[us.length - 2] : "";
  const followup = /^(继续|为什么|为何|怎么|如何|改|修|调整|优化|那个|这个|它|他|她|这|那|好的|嗯|对|另外|还有|再加|再|重新|还是|或者|比如|以及|也)/i;
  if (last.length < 6 || followup.test(last)) {
    const base = prev || last;
    return (base + (base && last !== base ? "\n" + last : "")).trim();
  }
  return last;
}
// F3: retrieve knowledge relevant to the current query. Returns the trimmed text, or "" when the KB is
// empty / has no hits. Non-fatal: any failure yields "" so the turn proceeds without RAG context.
async function recallKnowledge(query) {
  try {
    // memory/recall answers in plain text lines ("[episodic] …" / "nothing found")
    const txt = await mcpText("memory", "recall", {query});
    if (!txt || /^(no sources?|nothing found)$/i.test(txt) || txt.length < 20) return "";
    return txt;
  } catch (e) { return ""; }
}
// H2: workspace procedural-rules tier. The agent auto-proposes durable conventions (model emits a
// `propose-rules` block); they land in a DRAFT that the human approves before being injected as a
// stable system-section. Never auto-applied — that is the safeguard against stale / over-generalised rules.
// H2: autonomous memory maintenance across three stores. Each store has its own file, proposal
// fenced block, audit trail, and guardrail caps. A master `autoMemory` toggle gates all auto-merges.
// RULES is highest-risk (only verified conventions), knowledge/experience lower (facts / decision logs).
// A memory entry belongs to a STORE (rules / knowledge / experience) and a SCOPE:
//   - "workspace": lives under the active workspace (default landing for AI proposals).
//   - "group":     lives under GLOBAL_ROOT/groups/<name>/ and applies to every workspace in that
//                  group (the "between workspaces" tier) — but NOT to the rest.
//   - "global":    lives under GLOBAL_ROOT and applies to EVERY workspace (cross-project).
// The human promotes/demotes between scopes from the memory panel; the AI never writes the group or
// global scope directly (that is the safeguard against over-generalising a workspace quirk).
const GLOBAL_ROOT = "E:/WorkBuddy/.strata-memory";   // inside FS_ALLOW (E:/WorkBuddy); auto-created on first write
const MEMORY_STORES = {
  rules:      {key: "rules",      title: "rules",      file: "RULES.md",                    gfile: "RULES.md",        re: /```propose-rules\s*\n([\s\S]*?)```/i,      audit: ".strata-memory/auto-rules.md",      maxPerTurn: 5, maxChars: 200, maxLines: 80,  grounding: true},
  knowledge:  {key: "knowledge",  title: "knowledge",  file: ".strata-memory/knowledge.md",  gfile: "knowledge.md",    re: /```propose-knowledge\s*\n([\s\S]*?)```/i,  audit: ".strata-memory/auto-knowledge.md",  maxPerTurn: 8, maxChars: 300, maxLines: 200, grounding: false},
  experience: {key: "experience", title: "experience", file: ".strata-memory/experience.md", gfile: "experience.md",  re: /```propose-experience\s*\n([\s\S]*?)```/i, audit: ".strata-memory/auto-experience.md", maxPerTurn: 8, maxChars: 400, maxLines: 300, grounding: false},
};
const MEMORY_ORDER = ["rules", "knowledge", "experience"];
// Group label -> a filesystem-safe directory name (strip path-illegal chars).
function safeGroup(name) { return String(name || "").replace(/[<>:"/\\|?*]/g, "").trim(); }
function groupDir(group) { return `${GLOBAL_ROOT}/groups/${safeGroup(group)}`; }
// Scope-aware paths. `base` is the active workspace (used only for the workspace scope); `group`
// is the active workspace's group label (used only for the group scope).
function storePath(store, scope, base, group) {
  const cfg = MEMORY_STORES[store];
  if (scope === "global") return `${GLOBAL_ROOT}/${cfg.gfile}`;
  if (scope === "group")  return `${groupDir(group)}/${cfg.gfile}`;
  return `${base}/${cfg.file}`;
}
function auditPath(store, scope, base, group) {
  const cfg = MEMORY_STORES[store];
  if (scope === "global") return `${GLOBAL_ROOT}/auto-${store}.md`;
  if (scope === "group")  return `${groupDir(group)}/auto-${store}.md`;
  return `${base}/${cfg.audit}`;
}
// Pull the lines out of a store's proposal fenced block (one `- item` per line).
function extractMemoryProposals(store, text) {
  const m = MEMORY_STORES[store].re.exec(text || "");
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && !/^```/.test(l));
}
async function fsRead(path) {
  try {
    // filesystem/read answers with the file's raw content inside `text`
    const r = await fetch("mcp/call", {method: "POST", headers: headers(true),
      body: JSON.stringify({server: "filesystem", tool: "read", args: {path}})});
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return "";
    return String(d.text == null ? "" : d.text);
  } catch (e) { return ""; }
}
async function fsWrite(path, content) {
  const r = await fetch("mcp/call", {method: "POST", headers: headers(true),
    body: JSON.stringify({server: "filesystem", tool: "write", args: {path, content}})});
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) {
    throw new Error(String(d.text || `HTTP ${r.status}`).replace(/^error:\s*/, ""));
  }
}
// A workspace joins a group by writing its label to `<base>/.strata-memory/group.txt` (first line).
async function getGroupLabel(base) {
  const v = (await fsRead(`${base}/.strata-memory/group.txt`)) || "";
  return v.split("\n")[0].trim();
}
async function setGroupLabel(base, label) {
  await fsWrite(`${base}/.strata-memory/group.txt`, (label ? label : "").trim() + "\n");
}
// Load the approved rules + any pending draft for a workspace. Safe to call on every workspace switch.
async function loadMemoryState(ws) {
  if (!ws) {
    workspaceRules = ""; pendingDraft = []; rulesSel = new Set();
    workspaceKnowledge = ""; workspaceExperience = "";
    globalRules = ""; globalKnowledge = ""; globalExperience = "";
    groupRules = ""; groupKnowledge = ""; groupExperience = ""; currentGroup = "";
    renderRulesBanner(); return;
  }
  const base = ws.replace(/\/$/, "");
  workspaceRules = await fsRead(`${base}/RULES.md`);
  workspaceKnowledge = await fsRead(`${base}/.strata-memory/knowledge.md`);
  workspaceExperience = await fsRead(`${base}/.strata-memory/experience.md`);
  const draft = await fsRead(`${base}/RULES.draft.md`);
  pendingDraft = draft ? draft.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  rulesSel = new Set(pendingDraft);               // everything ticked by default
  // Cross-project global tier (applies to every workspace; the human promotes entries here).
  globalRules = await fsRead(`${GLOBAL_ROOT}/RULES.md`);
  globalKnowledge = await fsRead(`${GLOBAL_ROOT}/knowledge.md`);
  globalExperience = await fsRead(`${GLOBAL_ROOT}/experience.md`);
  // Group tier: only loaded when this workspace declares a group (the "between workspaces" tier).
  currentGroup = await getGroupLabel(base);
  if (currentGroup) {
    groupRules = await fsRead(`${groupDir(currentGroup)}/RULES.md`);
    groupKnowledge = await fsRead(`${groupDir(currentGroup)}/knowledge.md`);
    groupExperience = await fsRead(`${groupDir(currentGroup)}/experience.md`);
  } else {
    groupRules = ""; groupKnowledge = ""; groupExperience = "";
  }
  renderRulesBanner();
}
// Append `picked` lines to a store file, dedupe (order-preserving). Returns {merged, added} so callers
// can tell what actually landed (an all-duplicate proposal must not be reported as a merge).
async function mergeMemoryInto(store, scope, picked, base, group) {
  const existing = (await fsRead(storePath(store, scope, base, group))) || "";
  const lines = existing.split("\n").map((l) => l.trim()).filter(Boolean);
  const added = (picked || []).map((p) => String(p).trim()).filter((p) => p && !lines.includes(p));
  if (!added.length) return {merged: lines, added: []};
  const merged = lines.concat(added);
  await fsWrite(storePath(store, scope, base, group), merged.join("\n") + "\n");
  return {merged, added};
}
// Every unattended merge leaves a timestamped, store-tagged trace (the memory panel reads it back).
async function appendMemoryAudit(store, scope, added, base, group) {
  const path = auditPath(store, scope, base, group);
  const prev = (await fsRead(path)) || "";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const rows = added.map((a) => `- [${stamp}] ${a}`).join("\n");
  await fsWrite(path, (prev.trim() ? prev.trimEnd() + "\n" : "") + rows + "\n");
}
// Route a rules-store change to the right scope variable, then refresh the banner.
function setRulesVar(scope, value) {
  if (scope === "global") globalRules = value;
  else if (scope === "group") groupRules = value;
  else workspaceRules = value;
  renderRulesBanner();
}
// Keep the in-memory knowledge/experience model in sync after a direct write (mirrors setRulesVar but
// for the two non-rules stores, which have no banner and so need no re-render).
function setMemoryVar(store, scope, value) {
  if (store === "rules") { setRulesVar(scope, value); return; }
  if (store === "knowledge") {
    if (scope === "global") globalKnowledge = value;
    else if (scope === "group") groupKnowledge = value;
    else workspaceKnowledge = value;
  } else {
    if (scope === "global") globalExperience = value;
    else if (scope === "group") groupExperience = value;
    else workspaceExperience = value;
  }
}
// Take back exactly the lines an auto-merge added (the manual file editor is left untouched).
async function undoAutoMemory(store, scope, added, base, group) {
  if (!added || !added.length) return;
  const existing = (await fsRead(storePath(store, scope, base, group))) || "";
  const keep = existing.split("\n").map((l) => l.trim()).filter((l) => l && !added.includes(l));
  await fsWrite(storePath(store, scope, base, group), keep.length ? keep.join("\n") + "\n" : "");
  const audit = (await fsRead(auditPath(store, scope, base, group))) || "";
  const keepAudit = audit.split("\n").filter((l) => !added.some((a) => l.replace(/^-\s*\[[^\]]*\]\s*/, "") === a)).join("\n");
  await fsWrite(auditPath(store, scope, base, group), keepAudit);
  if (store === "rules") setRulesVar(scope, keep.join("\n"));
  toast("warn", t("mem.auto.undone"), t("mem.auto.undone.n", {n: added.length}));
}
// After a real task, pull any of the three proposal blocks the model emitted. For each store:
//   autoMemory ON  -> straight into the store file (undoable, audited, capped).
//   autoMemory OFF -> stage a draft for human approval (RULES -> banner; knowledge/experience -> draft file).
let pendingDrafts = { knowledge: [], experience: [] };   // rules keeps its own `pendingDraft`
async function maybeProposeMemory(m) {
  const s = activeSession();
  if (!s || !s.workspace || !mcpInfo.tools) return;
  const base = s.workspace.replace(/\/$/, "");
  for (const store of MEMORY_ORDER) {
    const cfg = MEMORY_STORES[store];
    const entries = extractMemoryProposals(store, m.text || "");
    if (!entries.length) continue;
    const approved = (await fsRead(`${base}/${cfg.file}`)) || "";
    const draftLines = store === "rules" ? pendingDraft : pendingDrafts[store];
    const have = new Set((approved + "\n" + draftLines.join("\n")).split("\n").map((l) => l.trim()).filter(Boolean));
    const fresh = entries.filter((e) => !have.has(e));
    if (!fresh.length) continue;                       // nothing new to propose

    if (settings.autoMemory) {
      const lineCount = approved.split("\n").map((l) => l.trim()).filter(Boolean).length;
      if (lineCount <= cfg.maxLines) {
        const picked = fresh.filter((e) => e.length <= cfg.maxChars).slice(0, cfg.maxPerTurn);
        if (!picked.length) continue;
        const {merged, added} = await mergeMemoryInto(store, "workspace", picked, base, currentGroup);
        if (added.length) {
          if (store === "rules") workspaceRules = merged.join("\n");
          await appendMemoryAudit(store, "workspace", added, base, currentGroup);
          if (store === "rules") renderRulesBanner();
          toast("ok", t("mem.auto.applied"), t("mem.auto.applied.n", {n: added.length, s: cfg.title}), 9000,
                {label: t("mem.auto.undo"), run: () => undoAutoMemory(store, "workspace", added, base, currentGroup)});
          // Tier 1: if this store now exceeds its soft budget, proactively compact it. Always does a
          // lossless exact-dedup; when the user opted into memCompactLLM, knowledge/experience also get a
          // model-driven semantic merge (rules stay lossless-only — never rewritten).
          if (merged.length >= SOFT_BUDGET[store]) {
            const r = await compactMemoryStore(store, "workspace", base, currentGroup,
                                               {llm: settings.memCompactLLM ? _llmCompactFn : null});
            if (r.changed) {
              if (store === "rules") renderRulesBanner();
              toast("info", t("mem.auto.compacted"),
                    t("mem.auto.compacted.n", {s: cfg.title, n: r.next.split("\n").filter(Boolean).length,
                                               llm: r.usedLLM ? t("mem.auto.compacted.llm") : ""}),
                    9000, {label: t("mem.auto.undo"), run: restoreCompaction});
            }
          }
        }
        continue;
      }
      // Safety valve: an oversized store must not grow unattended -> fall back to the draft path below.
      toast("warn", t("mem.auto.full"), t("mem.auto.full.n", {n: lineCount, s: cfg.title}), 7000);
    }

    // OFF path: stage as a draft for human approval.
    if (store === "rules") {
      pendingDraft = pendingDraft.concat(fresh);
      rulesSel = new Set(pendingDraft);
      await fsWrite(`${base}/RULES.draft.md`, pendingDraft.join("\n"));
      renderRulesBanner();
    } else {
      pendingDrafts[store] = pendingDrafts[store].concat(fresh);
      await fsWrite(`${base}/${cfg.file}.draft.md`, pendingDrafts[store].join("\n"));
    }
    toast("ok", t("mem.auto.proposed"), t("mem.auto.proposed.n", {n: fresh.length, s: cfg.title}), 6000);
  }
}
// Load drafts for all three stores (rules uses its globals; knowledge/experience from disk).
async function loadPendingDrafts(ws) {
  const base = (ws || "").replace(/\/$/, "");
  if (!base) return { rules: [], knowledge: [], experience: [] };
  const k = (await fsRead(`${base}/.strata-memory/knowledge.md.draft.md`)) || "";
  const e = (await fsRead(`${base}/.strata-memory/experience.md.draft.md`)) || "";
  return {
    rules: pendingDraft.slice(),
    knowledge: k ? k.split("\n").map((l) => l.trim()).filter(Boolean) : [],
    experience: e ? e.split("\n").map((l) => l.trim()).filter(Boolean) : [],
  };
}
// Approve (merge) some or all of a store's pending draft into the store file.
async function approveMemoryDraft(store, items) {
  const s = activeSession(); if (!s || !s.workspace) return;
  const base = s.workspace.replace(/\/$/, "");
  const cfg = MEMORY_STORES[store];
  const src = store === "rules" ? pendingDraft : pendingDrafts[store];
  const picked = (items && items.length ? items : src).slice();
  if (!picked.length) return;
  const {merged} = await mergeMemoryInto(store, "workspace", picked, base, currentGroup);
  const rest = src.filter((p) => !picked.includes(p));
  if (store === "rules") { pendingDraft = rest; rulesSel = new Set(rest); await fsWrite(`${base}/RULES.draft.md`, rest.join("\n")); renderRulesBanner(); }
  else { pendingDrafts[store] = rest; await fsWrite(`${base}/${cfg.file}.draft.md`, rest.join("\n")); }
  if (store === "rules") workspaceRules = merged.join("\n");
  toast("ok", t("mem.auto.merged"), t("mem.auto.merged.n", {n: merged.length, s: cfg.title}), 5000);
}
// Discard a single proposed draft line (the rest stay pending — never silently dropped).
async function discardMemoryDraft(store, item) {
  const s = activeSession(); if (!s || !s.workspace) return;
  const base = s.workspace.replace(/\/$/, "");
  const cfg = MEMORY_STORES[store];
  if (store === "rules") { pendingDraft = pendingDraft.filter((x) => x !== item); rulesSel.delete(item); await fsWrite(`${base}/RULES.draft.md`, pendingDraft.join("\n")); renderRulesBanner(); }
  else { pendingDrafts[store] = pendingDrafts[store].filter((x) => x !== item); await fsWrite(`${base}/${cfg.file}.draft.md`, pendingDrafts[store].join("\n")); }
}
// Tidy: dedupe each store file (drop exact duplicates and lines fully contained in a longer one).
async function tidyMemory() {
  const s = activeSession(); if (!s || !s.workspace) { toast("warn", t("mem.auto.tidy"), t("mem.auto.tidy.nows")); return; }
  const base = s.workspace.replace(/\/$/, "");
  let removed = 0;
  const scopes = currentGroup ? ["workspace", "group", "global"] : ["workspace", "global"];
  for (const scope of scopes) {
    for (const store of MEMORY_ORDER) {
      const existing = (await fsRead(storePath(store, scope, base, currentGroup))) || "";
      const lines = existing.split("\n").map((l) => l.trim()).filter(Boolean);
      const keep = [];
      for (const l of lines) {
        if (keep.some((k) => k === l || k.includes(l) || l.includes(k))) { removed++; continue; }
        keep.push(l);
      }
      if (keep.length !== lines.length) await fsWrite(storePath(store, scope, base, currentGroup), keep.length ? keep.join("\n") + "\n" : "");
    }
  }
  await loadMemoryState(s.workspace);
  toast("ok", t("mem.auto.tidy"), t("mem.auto.tidy.n", {n: removed}));
}

// ---- Tier 1: proactive memory-store compaction ----------------------------------------------
// Soft budget (in lines) per store. Strictly below the hard wall (MEMORY_STORES.maxLines) so a store is
// slimmed BEFORE it hits the ceiling. Crossing it triggers compactMemoryStore (wired in maybeProposeMemory).
const SOFT_BUDGET = { rules: 60, knowledge: 150, experience: 240 };
// Injected LLM compaction fn (overridable for tests). Returns compacted text, or null to fall back to lossless.
let _llmCompactFn = null;
function setLlmCompactFn(fn) { _llmCompactFn = (typeof fn === "function") ? fn : null; }
// Real impl: a one-shot chat completion that merges / summarises store entries. Fail-safe: any error -> null.
async function realLlmCompact(text, store) {
  try {
    const sys = store === "knowledge"
      ? "你是知识库压缩器。把下面的知识条目合并去重为更紧凑的条目，保留全部事实与关键细节，每条一行，不要编号以外的多余格式。若无法安全合并，原样返回。"
      : "你是经验库压缩器。把下面这些一次决策的复盘合并为更紧凑、可复用的经验条目，保留决策上下文与结果，每条一行。";
    const body = { model: (activeSession() || {}).model || "strata",
                   messages: [{role: "system", content: sys}, {role: "user", content: text}],
                   temperature: 0.2, max_tokens: 4096, stream: false };
    const r = await fetchWithRetry("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body)}, {retries: 2, base: 800});
    const j = await r.json();
    const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return out ? out.trim() : null;
  } catch (e) { return null; }
}
setLlmCompactFn(realLlmCompact);

// Proactively compact one memory store. Always does a LOSSLESS exact-dedup (no info loss). For
// knowledge/experience, when an LLM fn is supplied AND the store is still over its soft budget, it asks
// the model to merge semantically (fewer, denser lines). RULES is NEVER semantically rewritten — it is a
// "must-follow" contract, so only lossless dedup ever touches it. Returns {changed, prev, next, usedLLM}.
let pendingCompactionUndo = null;
async function compactMemoryStore(store, scope, base, group, opts = {}) {
  const cfg = MEMORY_STORES[store];
  if (!cfg) return { changed: false };
  const p = storePath(store, scope, base, group);
  const prevRaw = (await fsRead(p)) || "";
  const prevLines = prevRaw.split("\n").map((l) => l.trim()).filter(Boolean);
  // Lossless: order-preserving exact-dedup.
  const seen = new Set();
  const dedup = [];
  for (const l of prevLines) { if (!seen.has(l)) { seen.add(l); dedup.push(l); } }
  let next = dedup, usedLLM = false;
  if (store !== "rules" && opts.llm && typeof opts.llm === "function" && dedup.length > SOFT_BUDGET[store]) {
    try {
      const merged = await opts.llm(dedup.join("\n"), store);
      if (merged && typeof merged === "string") {
        const mlines = merged.split("\n").map((l) => l.trim()).filter(Boolean);
        if (mlines.length && mlines.length < dedup.length) { next = mlines; usedLLM = true; }
      }
    } catch (e) { /* keep the lossless result on any failure */ }
  }
  if (next.length === prevLines.length && next.join("\n") === prevLines.join("\n")) return { changed: false };
  const text = next.join("\n") + "\n";
  await fsWrite(p, text);
  setMemoryVar(store, scope, text.trim());
  pendingCompactionUndo = { store, scope, base, group, prev: prevRaw };
  return { changed: true, prev: prevRaw, next: text, usedLLM };
}
// Snapshot-level undo for the most recent compaction (restores the whole previous file).
async function restoreCompaction() {
  if (!pendingCompactionUndo) return;
  const { store, scope, base, group, prev } = pendingCompactionUndo;
  await fsWrite(storePath(store, scope, base, group), prev || "");
  setMemoryVar(store, scope, (prev || "").trim());
  if (store === "rules") renderRulesBanner();
  pendingCompactionUndo = null;
}
// Parse a store's audit file into [{ts, text}] for the rollback list in the memory panel.
function parseAudit(text) {
  if (!text) return [];
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^-\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*(.*)$/);
    return m ? {ts: m[1], text: m[2]} : {ts: "", text: l.replace(/^-\s*/, "")};
  });
}
// Move an audited entry to the store's cold-archive file (keeps it out of the live file, not deleted).
async function archiveAutoEntry(store, scope, text, base, group) {
  const audit = (await fsRead(auditPath(store, scope, base, group))) || "";
  const keep = audit.split("\n").filter((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, "") !== text);
  await fsWrite(auditPath(store, scope, base, group), keep.join("\n"));
  const cold = (await fsRead(auditPath(store, scope, base, group) + ".cold.md")) || "";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  await fsWrite(auditPath(store, scope, base, group) + ".cold.md", (cold.trim() ? cold.trimEnd() + "\n" : "") + `- [${stamp}] ${text}\n`);
  const existing = (await fsRead(storePath(store, scope, base, group))) || "";
  const keepLive = existing.split("\n").map((l) => l.trim()).filter((l) => l && l !== text);
  await fsWrite(storePath(store, scope, base, group), keepLive.length ? keepLive.join("\n") + "\n" : "");
  if (store === "rules") setRulesVar(scope, keepLive.join("\n"));
  toast("ok", t("mem.auto.archive"), t("mem.auto.archive.n", {n: 1}));
}
// The 3-tier promotion chain: workspace -> group (if a group is set) -> global. Demotion reverses it.
function nextScopeUp(scope, group) {
  if (scope === "workspace") return group ? "group" : "global";
  if (scope === "group") return "global";
  return "global";
}
function nextScopeDown(scope, group) {
  if (scope === "global") return group ? "group" : "workspace";
  if (scope === "group") return "workspace";
  return "workspace";
}
// Move a single entry between scopes. The human curates "what is universal / shared" here; the AI
// never writes the group or global scope directly. Moves both the live line and the audit trace so
// the memory panel (which lists from audit files) stays consistent across scopes.
async function moveMemoryEntry(store, text, fromScope, toScope, base, group) {
  const src = (await fsRead(storePath(store, fromScope, base, group))) || "";
  const srcKept = src.split("\n").map((l) => l.trim()).filter((l) => l && l !== text);
  await fsWrite(storePath(store, fromScope, base, group), srcKept.length ? srcKept.join("\n") + "\n" : "");
  const srcAudit = (await fsRead(auditPath(store, fromScope, base, group))) || "";
  const srcAuditKept = srcAudit.split("\n").filter((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, "") !== text);
  await fsWrite(auditPath(store, fromScope, base, group), srcAuditKept.join("\n"));
  const dst = (await fsRead(storePath(store, toScope, base, group))) || "";
  const dstLines = dst.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!dstLines.includes(text)) {
    await fsWrite(storePath(store, toScope, base, group), dstLines.concat(text).join("\n") + "\n");
  }
  const dstAudit = (await fsRead(auditPath(store, toScope, base, group))) || "";
  if (!dstAudit.split("\n").some((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, "") === text)) {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    await fsWrite(auditPath(store, toScope, base, group), (dstAudit.trim() ? dstAudit.trimEnd() + "\n" : "") + `- [${stamp}] ${text}\n`);
  }
  // Keep the in-memory rules model consistent immediately (the panel reloads via loadMemoryState too).
  if (store === "rules") {
    setRulesVar(fromScope, (await fsRead(storePath(store, fromScope, base, group)) || "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
    setRulesVar(toScope, (await fsRead(storePath(store, toScope, base, group)) || "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n"));
  }
}
async function promoteEntry(store, fromScope, text, base, group) {
  const to = nextScopeUp(fromScope, group);
  if (to !== fromScope) await moveMemoryEntry(store, text, fromScope, to, base, group);
  return to;
}
async function demoteEntry(store, fromScope, text, base, group) {
  const to = nextScopeDown(fromScope, group);
  if (to !== fromScope) await moveMemoryEntry(store, text, fromScope, to, base, group);
  return to;
}
// Human approved (some or all of) the draft -> merge into RULES.md (append, dedupe).
// Any line NOT in `items` stays in the draft file for a later decision — approving one
// rule must never silently drop the others.
async function approveRulesDraft(items) {
  const s = activeSession();
  const picked = items && items.length ? items.slice() : pendingDraft.slice();
  if (!s || !s.workspace || !picked.length) return;
  const base = s.workspace.replace(/\/$/, "");
  const {merged} = await mergeMemoryInto("rules", "workspace", picked, base);   // shared with the auto-merge path (dedupe + write)
  const rest = pendingDraft.filter((p) => !picked.includes(p));
  await fsWrite(`${base}/RULES.draft.md`, rest.join("\n"));   // keep the un-approved lines
  workspaceRules = merged.join("\n");
  pendingDraft = rest;
  rulesSel = new Set(rest);
  renderRulesBanner();
  if (typeof renderRulesDraftCard === "function") renderRulesDraftCard();
  toast("ok", t("rules.toast.merged"), t("rules.toast.merged.n", {n: merged.length}), 5000);
}
// Human discarded the draft -> just empty the draft file and drop the staged lines.
async function discardRulesDraft() {
  const s = activeSession();
  if (!s || !s.workspace) { pendingDraft = []; rulesSel = new Set(); renderRulesBanner(); return; }
  const base = s.workspace.replace(/\/$/, "");
  await fsWrite(`${base}/RULES.draft.md`, "");
  pendingDraft = [];
  rulesSel = new Set();
  renderRulesBanner();
  toast("warn", t("rules.toast.discarded"), "", 4000);
}
// Show / hide the approval banner based on whether a draft is pending.
function renderRulesBanner() {
  const el = document.getElementById("rules-draft-banner");
  if (!el) return;
  if (pendingDraft.length) {
    el.hidden = false;
    const title = document.getElementById("rules-draft-title");
    if (title) title.textContent = t("rules.banner.title", {n: pendingDraft.length});
    syncRulesMergeBtn();
    renderRulesDraftBody();
  } else {
    el.hidden = true;
    rulesSel = new Set();
    const body = document.getElementById("rules-draft-body");
    const peek = document.getElementById("rules-draft-peek");
    if (body) body.hidden = true;
    if (peek) { peek.setAttribute("aria-expanded", "false"); peek.classList.remove("rules-draft-banner__txt--open"); }
  }
}
// The expandable panel inside the banner: one checkbox per proposed rule (all ticked by
// default), a select-all row with a live count, and a per-item drop button.
function renderRulesDraftBody() {
  const body = document.getElementById("rules-draft-body");
  if (!body) return;
  body.innerHTML = `<label class="rd-row rd-row--all"><input type="checkbox" data-rd-all` +
    `${rulesSel.size === pendingDraft.length ? " checked" : ""}>` +
    `<span>${esc(t("rules.banner.selected", {n: rulesSel.size, total: pendingDraft.length}))}</span></label>` +
    pendingDraft.map((e2, i) => `<div class="rd-row"><label class="rd-row__main">` +
      `<input type="checkbox" data-rd-i="${i}"${rulesSel.has(e2) ? " checked" : ""}>` +
      `<span class="rd-row__txt">${esc(e2)}</span></label>` +
      `<button type="button" class="st-btn st-btn--ghost st-btn--sm" data-rd-del="${i}"` +
      ` title="${esc(t("rules.banner.item.discard"))}">${icon("trash")}</button></div>`).join("");
}
// The merge button approves exactly the ticked lines: label + disabled state follow the selection.
function syncRulesMergeBtn() {
  const btn = document.getElementById("rules-draft-merge");
  if (!btn) return;
  const n = rulesSel.size;
  btn.disabled = n === 0;
  btn.textContent = n > 0 && n === pendingDraft.length ? t("rules.banner.merge") : t("rules.banner.merge.n", {n});
}

// ============================================================ Design documents (`.design/` folder)
// A durable planning artifact, distinct from `next-steps` (ephemeral clickable chips) and
// `propose-rules` (a draft staged for human approval). Saved under <workspace>/.design/ so it
// survives sessions, can be ticked off item by item, and (optionally) ingested into the KB.
const DESIGN_RE = /```design\s*\n([\s\S]*?)```/i;
function extractDesign(text) {
  const m = DESIGN_RE.exec(text || "");
  if (!m) return null;
  const body = m[1].trim();
  const tm = body.match(/^#\s+(.+)$/m);
  const title = (tm ? tm[1] : "").trim() || "未命名设计";
  return {title, body};
}
// Heuristic: if a meaningful share of characters are CJK, treat the text as Chinese.
function detectLang(text) {
  const s = text || "";
  if (!s.trim()) return "en";
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  return cjk > s.replace(/\s/g, "").length * 0.15 ? "zh" : "en";
}
// Resolve the effective document language: explicit zh/en wins; auto follows the conversation.
function designLangOf() {
  const dl = settings.designLang || "auto";
  if (dl === "zh") return "zh";
  if (dl === "en") return "en";
  const joined = messages.filter((m) => m.role === "user").map((m) => userText(m)).join("\n");
  return detectLang(joined);
}
// Build a filesystem-safe filename from a document title (sanitise, never rename an existing file).
function designFileName(title) {
  const safe = (title || "未命名设计").replace(/[\/\\:*?"<>|\n\r]+/g, " ").trim().slice(0, 60);
  return `${safe}.md`;
}

// Pending design doc proposed by the model (staged for the human to save into <ws>/.design/).
let pendingDesign = null;   // {title, body, file, ws}
async function maybeProposeDesign(m) {
  const s = activeSession();
  if (!s || !s.workspace || !mcpInfo.tools) return;   // need a workspace + filesystem MCP
  const d = extractDesign(m.text || "");
  if (!d) return;
  const base = s.workspace.replace(/\/$/, "");
  pendingDesign = {title: d.title, body: d.body, file: designFileName(d.title), ws: base};
  renderDesignBanner();
  toast("ok", t("design.toast.proposed"), pendingDesign.file, 6000);
}
function renderDesignBanner() {
  const el = document.getElementById("design-draft-banner");
  if (!el) return;
  if (pendingDesign) {
    el.hidden = false;
    const title = document.getElementById("design-draft-title");
    if (title) title.textContent = t("design.banner.title", {file: pendingDesign.file});
    const pre = document.getElementById("design-draft-pre");
    if (pre) {
      const lines = String(pendingDesign.body || "").split("\n");
      pre.textContent = lines.slice(0, 30).join("\n") +
        (lines.length > 30 ? `\n... (${lines.length} lines total; full text after saving)` : "");
    }
  } else {
    el.hidden = true;
    const body = document.getElementById("design-draft-body");
    const peek = document.getElementById("design-draft-peek");
    if (body) body.hidden = true;
    if (peek) { peek.setAttribute("aria-expanded", "false"); peek.classList.remove("rules-draft-banner__txt--open"); }
  }
}
async function approveDesignDraft() {
  if (!pendingDesign) return;
  const {body, file, ws} = pendingDesign;
  await fsWrite(`${ws}/.design/${file}`, body + "\n");
  toast("ok", t("design.toast.saved"), `${ws}/.design/${file}`, 5000);
  pendingDesign = null;
  renderDesignBanner();
}
async function discardDesignDraft() {
  pendingDesign = null;
  renderDesignBanner();
  toast("warn", t("design.toast.discarded"), "", 4000);
}
// Manual "generate design doc" button: pull an explicit `design` block if present, otherwise
// aggregate this chat's plan / next-steps blocks into one document, then save under <ws>/.design/.
async function generateDesignFromChat() {
  const s = activeSession();
  if (!s || !s.workspace || !mcpInfo.tools) { toast("warn", t("design.toast.nows"), "", 4000); return; }
  const designs = [], plans = [], steps = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const txt = m.text || "";
    const dm = DESIGN_RE.exec(txt);
    if (dm) designs.push(dm[1].trim());
    const pm = extractPlan(txt);
    if (pm && pm.items && pm.items.length) plans.push(pm.items.join("\n"));
    const ns = (txt.match(/```next-steps\s*\n([\s\S]*?)```/i) || [])[1];
    if (ns) steps.push(ns.trim());
  }
  let body, title;
  if (designs.length) {
    body = designs.join("\n\n---\n\n");
    const tm = body.match(/^#\s+(.+)$/m);
    title = (tm ? tm[1] : "").trim() || "会话设计文档";
  } else {
    const firstUser = messages.find((m) => m.role === "user");
    const seed = (firstUser ? userText(firstUser) : "").slice(0, 24);
    title = seed || "会话设计文档";
    const parts = [];
    if (plans.length) parts.push("## 任务计划\n" + plans.join("\n"));
    if (steps.length) parts.push("## 下一步建议\n" + steps.join("\n"));
    body = `# ${title}\n\n` + (parts.length ? parts.join("\n\n") : "_（本对话暂无 plan / next-steps 内容）_");
  }
  const base = s.workspace.replace(/\/$/, "");
  const file = designFileName(title);
  await fsWrite(`${base}/.design/${file}`, body + "\n");
  toast("ok", t("design.toast.saved"), `${base}/.design/${file}`, 5000);
}

// ============================================================ Memory management view ("记忆" tab)
// One console for the three persistent "memory" stores: knowledge base (semantic.db), workspace
// RULES.md, auto-learned notes (.strata-memory/*.md), plus a read-only view of the global MEMORY.md.
// The raw text of a tool result for callers that want plain lines; "" on any failure
// (the callers here render empty states rather than error banners).
async function mcpTxt(server, tool, args) {
  try { return await mcpText(server, tool, args); } catch (e) { return ""; }
}

// Project-scoped global memory file (read-only in the UI; the agent maintains it).
const PROJECT_MEMORY = "E:/WorkBuddy/星云智能体/.workbuddy/memory/MEMORY.md";

// ============================================================ cold-archive manager
// The drawer panel (option A: same section as the archiveOn toggle) that lets a user
// view / edit / delete the verbatim snapshots compaction writes to <ws>/.strata-archive/.
// Reuses the notes-card paradigm (mcpTxt list/delete + fsRead view + fsWrite save).
// Design: view = read-only <pre>; edit unlocks a textarea then fsWrite; delete copies
// the file to .strata-archive/.trash/ before removing the original (anti-accident).
async function renderArchiveManager() {
  const box = $("archive-mgr-list"); if (!box) return;
  const s = activeSession();
  const base = (s && s.workspace) ? s.workspace.replace(/\/$/, "") : "";
  if (!base) { box.innerHTML = '<div class="muted small">' + esc(t("drawer.archive.mgr.empty")) + '</div>'; return; }
  const dir = base + "/.strata-archive";
  let files = [];
  try {
    const raw = await mcpTxt("filesystem", "list", { path: dir });
    files = raw.split("\n").map((x) => x.trim()).filter(Boolean).filter((f) => /\.md$/i.test(f));
  } catch (e) { files = []; }
  if (!files.length) { box.innerHTML = '<div class="muted small">' + esc(t("drawer.archive.mgr.empty")) + '</div>'; return; }
  box.innerHTML = files.map((f) => {
    const path = dir + "/" + f;
    return '<div class="mem-kb-item"><div class="kb-source"><span class="kb-source__name" title="' + esc(f) + '">' + esc(f) +
      '</span><button class="st-btn st-btn--ghost st-btn--sm" data-arc-view="' + esc(path) + '">' + t("mem.kb.view") +
      '</button><button class="st-btn st-btn--ghost st-btn--sm" data-arc-edit="' + esc(path) + '">' + t("drawer.archive.edit") +
      '</button><button class="st-btn st-btn--ghost st-btn--sm" data-arc-del="' + esc(path) + '">' + t("side.delete") +
      '</button></div>' +
      '<pre class="mem-src-body" hidden></pre></div>';
  }).join("");
}
$("archive-mgr-refresh").onclick = () => renderArchiveManager();
$("archive-mgr-list").addEventListener("click", async (e) => {
  const view = e.target.closest("[data-arc-view]");
  const edit = e.target.closest("[data-arc-edit]");
  const del  = e.target.closest("[data-arc-del]");
  const item = e.target.closest(".mem-kb-item"); if (!item) return;
  const pre  = item.querySelector(".mem-src-body");
  if (view) {
    if (pre.dataset.loaded) { pre.hidden = !pre.hidden; return; }
    pre.textContent = t("drawer.archive.loading"); pre.hidden = false;
    const res = await fsRead(view.dataset.arcView);
    pre.textContent = res || t("drawer.archive.unloaded"); pre.dataset.loaded = "1";
  } else if (edit) {
    // unlock this row only: swap the read-only <pre> for an editable textarea
    const res = await fsRead(edit.dataset.arcEdit);
    pre.hidden = false;
    pre.innerHTML = '<textarea class="st-input" rows="10" style="width:100%">' + esc(res || "") + '</textarea>' +
      '<div class="st-btnrow" style="margin-top:6px">' +
      '<button class="st-btn st-btn--secondary st-btn--sm" data-arc-save="' + esc(edit.dataset.arcEdit) + '">' + t("drawer.archive.save") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-arc-cancel>' + t("drawer.archive.cancel") + '</button></div>';
    pre.dataset.loaded = "1";
  } else if (del) {
    const path = del.dataset.arcDel;
    const name = path.split(/[\\/]/).pop();
    if (!confirm(t("drawer.archive.del.confirm", { name }))) return;
    const txt = await fsRead(path);
    // real Windows Recycle Bin via the same /api/recycle path (COM, never a physical delete).
    const s0 = activeSession();
    const ws = (s0 && s0.workspace) ? s0.workspace.replace(/\/$/, "") : "";
    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "trash", workspace: ws, paths: [path]})});
    const j = await r.json();
    if (j && j.error) { toast("error", t("recycle.err"), esc(j.error.message || ""), 4000); }
    else { toast("success", (j && j.trashed && j.trashed.length) ? t("recycle.done").replace("{n}", String(j.trashed.length)) : t("recycle.none"), "", 2500); }
    renderArchiveManager();
  }
  // save / cancel live inside the row's textarea block (delegated here)
  const save = e.target.closest("[data-arc-save]");
  if (save) {
    const ta = item.querySelector("textarea");
    await fsWrite(save.dataset.arcSave, ta ? ta.value : "");
    toast("success", t("drawer.archive.saved"), "", 1800);
    renderArchiveManager();
  }
  const cancel = e.target.closest("[data-arc-cancel]");
  if (cancel) { renderArchiveManager(); }
});
async function renderMemory() { renderKbCard(); renderRulesCard(); renderNotesCard(); renderAutoMemoryCard(); renderGlobalCard(); }
// Item-level expand persistence (2026-10-30): which kb/note rows the user left open.
const memExpanded = { kb: expandSetLoad("strata.memExpand.kb"), notes: expandSetLoad("strata.memExpand.notes") };
// After a render, re-open the rows the user had left open. Loaded bodies show directly;
// not-yet-loaded ones go through the row's own view button (the existing lazy path).
function restoreMemExpand(listId, set){
  const list = $(listId); if (!list || !set.size) return;
  list.querySelectorAll(".mem-kb-item").forEach((item) => {
    const b = item.querySelector("[data-kb-view],[data-note-view]"); if (!b) return;
    const k = b.dataset.kbView || b.dataset.noteView;
    if (!set.has(k)) return;
    const pre = item.querySelector(".mem-src-body");
    if (pre && pre.dataset.loaded) { pre.hidden = false; } else { b.click(); }
  });
}
function memExpandAllPersisted(listId, expand){
  const set = (listId === "mem-kb-list") ? memExpanded.kb : memExpanded.notes;
  const list = $(listId);
  if (expand) {
    if (list) list.querySelectorAll(".mem-kb-item").forEach((item) => { const b = item.querySelector("[data-kb-view],[data-note-view]"); if (b) set.add(b.dataset.kbView || b.dataset.noteView); });
  } else {
    set.clear();
  }
  expandSetSave("strata.memExpand." + (listId === "mem-kb-list" ? "kb" : "notes"), set);
  memExpandAll(listId, expand);
}
// A+C landing (approved 2026-10-26): one-click expand/collapse-all over the memory inline
// lists. Default-folded + per-item lazy load already exist; this adds the batch action,
// reusing the existing lazy-load path via the row button click.
function memExpandAll(listId, expand) {
  const list = $(listId); if (!list) return;
  list.querySelectorAll(".mem-kb-item").forEach((item) => {
    const pre = item.querySelector(".mem-src-body"); if (!pre) return;
    if (expand) {
      if (pre.dataset.loaded) { pre.hidden = false; }
      else { const b = item.querySelector("[data-kb-view],[data-note-view]"); if (b) b.click(); }
    } else { pre.hidden = true; }
  });
}
if ($("mem-kb-expandall")) $("mem-kb-expandall").onclick = () => memExpandAllPersisted("mem-kb-list", true);
if ($("mem-kb-foldall")) $("mem-kb-foldall").onclick = () => memExpandAllPersisted("mem-kb-list", false);
if ($("mem-notes-expandall")) $("mem-notes-expandall").onclick = () => memExpandAllPersisted("mem-notes-list", true);
if ($("mem-notes-foldall")) $("mem-notes-foldall").onclick = () => memExpandAllPersisted("mem-notes-list", false);

let KB_SHOW_LIMIT = 50; // perf (A+B, 2026-10-27): recent sources shown before load-more
async function renderKbCard() {
  const list = $("mem-kb-list");
  if (!list) return;
  if (!mcpInfo.tools) { list.innerHTML = '<div class="kb-source muted">' + t("mem.kb.nomcp") + '</div>'; return; }
  const srcs = await mcpTxt("memory", "sources", {});
  const rows = srcs ? srcs.split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const sum = $("mem-kb-sum"); if (sum) sum.textContent = rows.length ? t("mem.kb.count", {n: rows.length}) : "";
  if (!rows.length) { list.innerHTML = '<div class="kb-source muted">' + t("mem.kb.empty") + '</div>'; return; }
  // perf (A+B, approved 2026-10-27): default to the most recent KB_SHOW_LIMIT rows + load-more,
  // so opening the page with hundreds of sources does not stamp the whole list in one paint.
  const showRows = rows.length > KB_SHOW_LIMIT ? rows.slice(rows.length - KB_SHOW_LIMIT) : rows;
  list.innerHTML = showRows.map((r) => {
    const m = r.match(/^(.*?):\s*(\d+)\s*chunks$/);
    const name = m ? m[1] : r, n = m ? m[2] : "";
    return '<div class="mem-kb-item"><div class="kb-source"><span class="kb-source__name" title="' + esc(name) + '">' + esc(name) +
      '</span><span class="muted small">' + esc(n) + ' ' + t("mem.kb.chunks") + '</span>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-kb-view="' + esc(name) + '">' + t("mem.kb.view") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-kb-edit="' + esc(name) + '">' + t("drawer.archive.edit") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-kb-del="' + esc(name) + '">' + t("side.delete") + '</button></div>' +
      '<pre class="mem-src-body" hidden></pre></div>';
  }).join("");
  restoreMemExpand("mem-kb-list", memExpanded.kb);
  if (rows.length > showRows.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "st-btn st-btn--ghost st-btn--sm kb-loadmore";
    more.setAttribute("data-kb-more", "1");
    more.textContent = t("mem.kb.more", {n: rows.length - showRows.length});
    list.appendChild(more);
  }
}
$("mem-kb-list").addEventListener("click", async (e) => {
  const more = e.target.closest("[data-kb-more]");
  if (more) { KB_SHOW_LIMIT += 50; renderKbCard(); return; }
  const view = e.target.closest("[data-kb-view]");
  const del = e.target.closest("[data-kb-del]");
  const edit = e.target.closest("[data-kb-edit]"); const save = e.target.closest("[data-kb-save]"); const cancel = e.target.closest("[data-kb-cancel]");
  if (edit) {
    const item = edit.closest(".mem-kb-item"); if (!item) return;
    const pre = item.querySelector(".mem-src-body"); if (!pre) return;
    const res = await mcpTxt("memory", "read_source", {source: edit.dataset.kbEdit});
    pre.hidden = false;
    const body = (res && !res.startsWith("no chunks")) ? res.replace(/^\[chunk \d+\]\n/gm, "") : "";
    pre.innerHTML = '<textarea class="st-input" rows="10" style="width:100%">' + esc(body) + '</textarea>' +
      '<div class="st-btnrow" style="margin-top:6px">' +
      '<button class="st-btn st-btn--secondary st-btn--sm" data-kb-save="' + esc(edit.dataset.kbEdit) + '">' + t("drawer.archive.save") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-kb-cancel>' + t("drawer.archive.cancel") + '</button></div>';
    pre.dataset.loaded = "1"; return;
  } else if (save) {
    const src = save.dataset.kbSave; const item = save.closest(".mem-kb-item"); const ta = item && item.querySelector("textarea");
    if (!ta) return; const ws = activeSession() && activeSession().workspace; if (!ws) return;
    const base = ws.replace(/\/$/, ""); const tmp = base + "/.strata-memory/edit-" + src.replace(/[\\/]/g, "_") + ".md";
    await fsWrite(tmp, ta.value);
    await mcpTxt("memory", "forget", {source: src});
    const r = await mcpTxt("memory", "ingest", {path: tmp, source: src});
    toast("ok", t("mem.kb.title"), t("mem.kb.deleted", {n: src}) + " = " + (r || ""));
    renderKbCard(); return;
  } else if (cancel) {
    renderKbCard(); return;
  } else
  if (view) {
    const item = view.closest(".mem-kb-item"); if (!item) return;
    const pre = item.querySelector(".mem-src-body"); if (!pre) return;
    const k = view.dataset.kbView;
    if (pre.dataset.loaded) { pre.hidden = !pre.hidden; if (pre.hidden) memExpanded.kb.delete(k); else memExpanded.kb.add(k); expandSetSave("strata.memExpand.kb", memExpanded.kb); return; }
    pre.textContent = t("mem.kb.loading"); pre.hidden = false;
    memExpanded.kb.add(k); expandSetSave("strata.memExpand.kb", memExpanded.kb);
    const res = await mcpTxt("memory", "read_source", {source: view.dataset.kbView});
    pre.textContent = res || t("mem.kb.nohit"); pre.dataset.loaded = "1";
  } else if (del) {
    const name = del.dataset.kbDel;
    if (!confirm(t("mem.kb.del.confirm", {n: name}))) return;
    await mcpTxt("memory", "forget", {source: name});
    toast("ok", t("mem.kb.title"), t("mem.kb.deleted", {n: name}));
    renderKbCard();
  }
});
$("mem-kb-preview").onclick = async () => {
  const q = $("mem-kb-search").value.trim(); const box = $("mem-kb-preview-box");
  if (!q || !box) { if (box) box.hidden = true; return; }
  box.hidden = false; box.textContent = t("mem.kb.searching");
  const res = await mcpTxt("memory", "recall", {query: q});
  box.textContent = res || t("mem.kb.nohit");
};
$("mem-kb-import").onclick = async () => {
  const p = $("mem-kb-path").value.trim();
  if (!p) { toast("warn", t("mem.kb.import"), t("mem.kb.path.ph")); return; }
  const src = p.split(/[\\/]/).pop();
  const res = await mcpTxt("memory", "ingest", {path: p, source: src});
  toast("ok", t("mem.kb.import"), res || t("mem.kb.import.ok"));
  renderKbCard();
};

async function renderRulesCard() {
  const ws = activeSession() && activeSession().workspace;
  const empty = $("mem-rules-empty"); const edit = $("mem-rules-edit"); const actions = $("mem-rules-actions");
  const tag = $("mem-rules-ws"); if (tag) tag.textContent = ws ? ws : "";
  if (!ws) {
    if (empty) empty.hidden = false; if (edit) edit.hidden = true; if (actions) actions.hidden = true;
    const dh = $("mem-draft-head"); if (dh) dh.hidden = true; const dl = $("mem-rules-draft"); if (dl) dl.innerHTML = "";
    return;
  }
  if (empty) empty.hidden = true; if (edit) edit.hidden = false; if (actions) actions.hidden = false;
  await loadMemoryState(ws);
  if (edit) edit.value = workspaceRules || "";
  renderRulesDraftCard();
}
function renderRulesDraftCard() {
  const head = $("mem-draft-head"); const list = $("mem-rules-draft");
  if (!list) return;
  if (!pendingDraft.length) { if (head) head.hidden = true; list.innerHTML = ""; return; }
  if (head) head.hidden = false;
  // index-based data attributes: rule text may contain quotes, which would break an
  // attribute that embeds it verbatim
  list.innerHTML = pendingDraft.map((e2, i) => '<div class="kb-source"><span class="kb-source__name" title="' + esc(e2) + '">' + esc(e2) +
    '</span><button class="st-btn st-btn--ghost st-btn--sm" data-rd-merge="' + i + '">' + t("rules.banner.merge") +
    '</button><button class="st-btn st-btn--ghost st-btn--sm" data-rd-discard="' + i + '">' + t("rules.banner.discard") + '</button></div>').join("");
}
$("mem-rules-save").onclick = async () => {
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  await fsWrite(base + "/RULES.md", $("mem-rules-edit").value);
  workspaceRules = ($("mem-rules-edit").value || "").trim();
  toast("ok", t("mem.rules.saved.title"), "");
};
$("mem-rules-draft").addEventListener("click", async (e) => {
  const merge = e.target.closest("[data-rd-merge]"); const discard = e.target.closest("[data-rd-discard]");
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  if (merge) {
    const item = pendingDraft[+merge.dataset.rdMerge];
    if (item == null) return;
    // partial merge: the other proposals stay in the draft (used to be silently dropped)
    await approveRulesDraft([item]);
    renderRulesCard();
  } else if (discard) {
    const item = pendingDraft[+discard.dataset.rdDiscard];
    if (item == null) return;
    pendingDraft = pendingDraft.filter((x) => x !== item);
    rulesSel.delete(item);
    await fsWrite(base + "/RULES.draft.md", pendingDraft.join("\n"));
    renderRulesDraftCard(); renderRulesBanner();
  }
});

// ------------------------------------------------------------------ autonomous memory panel
// The "自主沉淀" tab shows what the AI has auto-applied (rollback list from the audit trail) and any
// pending drafts for the three stores, plus a tidy action. This is the human safety net that replaces
// per-item approval: batch review + one-click undo, instead of approving each line by hand.
let memAutoEntries = [];   // [{store, scope, ts, text}] for index-based undo/archive/promote buttons
let memAutoScopeFilter = "all";   // all | workspace | group | global
// Localised scope name + badge used by both the auto panel and the weekly summary modal.
function scopeName(scope, group) {
  if (scope === "global") return t("mem.auto.scope.global");
  if (scope === "group") return t("mem.auto.scope.group", {g: group || ""});
  return t("mem.auto.scope.workspace");
}
function scopeBadge(scope, group) {
  const cls = scope === "global" ? "badge--global" : scope === "group" ? "badge--group" : "badge--ws";
  return `<span class="badge ${cls}">${esc(scopeName(scope, group))}</span>`;
}
// Direct human-authored entry into a scope (global / group) without going through a workspace promotion.
// Dedupes against the existing live file, writes the audit trace so it shows in the auto panel, and keeps
// the in-memory rules model in sync. Returns true if something was added.
async function createMemoryEntry(store, scope, text, base, group) {
  text = (text || "").trim();
  if (!text) { toast("warn", t("mem.ne.title"), t("mem.ne.empty")); return false; }
  const cfg = MEMORY_STORES[store];
  const existing = (await fsRead(storePath(store, scope, base, group))) || "";
  const lines = existing.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.includes(text)) { toast("warn", t("mem.ne.title"), t("mem.ne.dup")); return false; }
  lines.push(text);
  await fsWrite(storePath(store, scope, base, group), lines.join("\n") + "\n");
  const audit = (await fsRead(auditPath(store, scope, base, group))) || "";
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  await fsWrite(auditPath(store, scope, base, group), (audit.trim() ? audit.trimEnd() + "\n" : "") + `- [${stamp}] ${text}\n`);
  if (store === "rules") setRulesVar(scope, lines.join("\n"));
  else setMemoryVar(store, scope, lines.join("\n"));
  toast("ok", t("mem.ne.title"), t("mem.ne.added", {scope: scopeName(scope, group), s: cfg.title}));
  return true;
}
// ------------------------------------------------------------------ weekly summary modal (independent review view)
let weeklyEntries = [];   // [{store, scope, ts, text}] within the last 7 days
async function openWeeklyModal() {
  const ws = activeSession() && activeSession().workspace;
  if (!ws) return;
  const base = ws.replace(/\/$/, "");
  const wk = 7 * 24 * 3600 * 1000, now = Date.now();
  weeklyEntries = [];
  const scopes = currentGroup ? ["workspace", "group", "global"] : ["workspace", "global"];
  for (const scope of scopes) {
    for (const store of MEMORY_ORDER) {
      const audit = parseAudit(await fsRead(auditPath(store, scope, base, currentGroup)));
      for (const a of audit) {
        if (a.ts && (now - new Date(a.ts.replace(" ", "T")).getTime()) < wk) {
          weeklyEntries.push({store, scope, ts: a.ts, text: a.text});
        }
      }
    }
  }
  weeklyEntries.sort((x, y) => (y.ts || "").localeCompare(x.ts || ""));
  const list = $("weekly-list");
  if (!list) return;
  if (!weeklyEntries.length) {
    list.innerHTML = `<p class="muted small">${esc(t("mem.weekly.empty"))}</p>`;
  } else {
    list.innerHTML = weeklyEntries.map((e, i) => {
      const cfg = MEMORY_STORES[e.store];
      return `<div class="kb-source"><span class="kb-source__name" title="${esc(e.text)}">${esc(e.text)}</span>` +
        `<span class="muted small">${esc(e.ts || "")} · ${esc(cfg.title)} ${scopeBadge(e.scope, currentGroup)}</span>` +
        `<button class="st-btn st-btn--ghost st-btn--sm" data-weekly-undo="${i}">${t("mem.auto.undo")}</button></div>`;
    }).join("");
  }
  if ($("weekly-sub")) $("weekly-sub").textContent = t("mem.weekly.sub", {n: weeklyEntries.length});
  if ($("weekly-undoall")) $("weekly-undoall").hidden = !weeklyEntries.length;
  const modal = $("weekly-modal");
  if (modal) { modal.hidden = false; $("scrim").hidden = false; $("scrim").onclick = closeWeeklyModal; }
}
function closeWeeklyModal() {
  if ($("weekly-modal")) $("weekly-modal").hidden = true;
  if ($("scrim")) $("scrim").hidden = true;
}
// ------------------------------------------------------------------ new-entry modal (global / group)
let newEntryScope = "global";
function openNewEntry(scope) {
  newEntryScope = scope;
  const title = scope === "group" ? t("mem.ne.title.group") : t("mem.ne.title.global");
  if ($("newentry-title")) $("newentry-title").textContent = title;
  if ($("ne-text")) $("ne-text").value = "";
  const modal = $("newentry-modal");
  if (modal) { modal.hidden = false; $("scrim").hidden = false; $("scrim").onclick = closeNewEntry; }
  if ($("ne-text")) $("ne-text").focus();
}
function closeNewEntry() {
  if ($("newentry-modal")) $("newentry-modal").hidden = true;
  if ($("scrim")) $("scrim").hidden = true;
}
async function submitNewEntry() {
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  const store = $("ne-store") ? $("ne-store").value : "rules";
  const ok = await createMemoryEntry(store, newEntryScope, $("ne-text") ? $("ne-text").value : "", base, currentGroup);
  if (ok) {
    closeNewEntry();
    await loadMemoryState(ws);
    renderAutoMemoryCard(); renderGlobalCard();
  }
}
async function renderAutoMemoryCard() {
  const ws = activeSession() && activeSession().workspace;
  const list = $("mem-auto-list"); const empty = $("mem-auto-empty"); const sum = $("mem-auto-sum");
  const grpTag = $("mem-auto-group");
  if (!list) return;
  if (!ws) { if (empty) empty.hidden = false; if (sum) sum.textContent = ""; if (grpTag) grpTag.textContent = ""; list.innerHTML = ""; return; }
  if (empty) empty.hidden = true;
  const base = ws.replace(/\/$/, "");
  if (grpTag) grpTag.textContent = currentGroup ? t("mem.auto.group.of", {g: currentGroup}) : t("mem.auto.group.none");
  const newGroupBtn = $("mem-auto-newgroup");
  if (newGroupBtn) newGroupBtn.hidden = !currentGroup;
  const drafts = await loadPendingDrafts(ws);
  memAutoEntries = [];
  let html = "";
  let weekCount = 0;
  const wk = 7 * 24 * 3600 * 1000, now = Date.now();
  // Drafts (workspace only) — pending human approval.
  for (const store of MEMORY_ORDER) {
    const cfg = MEMORY_STORES[store];
    const pd = drafts[store] || [];
    if (pd.length) {
      html += `<div class="kb-source kb-source--head"><span class="kb-source__name"><b>${esc(t("mem.auto.pending", {s: cfg.title}))}</b></span></div>`;
      html += pd.map((e2, i) => `<div class="kb-source"><span class="kb-source__name" title="${esc(e2)}">${esc(e2)}</span>` +
        `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-merge="${store}:${i}">${t("rules.banner.merge")}</button>` +
        `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-discard="${store}:${i}">${t("rules.banner.discard")}</button></div>`).join("");
    }
  }
  // Auto-merged entries from all three scopes, each tagged with a scope badge and a promote/demote action.
  const scopes = currentGroup ? ["workspace", "group", "global"] : ["workspace", "global"];
  for (const scope of scopes) {
    for (const store of MEMORY_ORDER) {
      const cfg = MEMORY_STORES[store];
      const audit = parseAudit(await fsRead(auditPath(store, scope, base, currentGroup)));
      for (const a of audit) {
        if (scope === "workspace" && a.ts && (now - new Date(a.ts.replace(" ", "T")).getTime()) < wk) weekCount++;
        if (memAutoScopeFilter !== "all" && memAutoScopeFilter !== scope) continue;
        memAutoEntries.push({store, scope, ts: a.ts, text: a.text});
        const idx = memAutoEntries.length - 1;
        const badge = scope === "global"
          ? `<span class="badge badge--global">${esc(t("mem.auto.scope.global"))}</span>`
          : scope === "group"
            ? `<span class="badge badge--group">${esc(t("mem.auto.scope.group", {g: currentGroup}))}</span>`
            : `<span class="badge badge--ws">${esc(t("mem.auto.scope.workspace"))}</span>`;
        const up = nextScopeUp(scope, currentGroup);
        const down = nextScopeDown(scope, currentGroup);
        const move = (up !== scope)
          ? `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-promote="${idx}">${t("mem.auto.promote")} ▲</button>`
          : (down !== scope)
            ? `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-demote="${idx}">${t("mem.auto.demote")} ▼</button>`
            : "";
        html += `<div class="kb-source"><span class="kb-source__name" title="${esc(a.text)}">${esc(a.text)}</span>` +
          `<span class="muted small">${esc(a.ts || "")} · ${esc(cfg.title)} ${badge}</span>` +
          `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-undo="${idx}">${t("mem.auto.undo")}</button>` +
          `<button class="st-btn st-btn--ghost st-btn--sm" data-auto-archive="${idx}">${t("mem.auto.archive")}</button>` +
          move + `</div>`;
      }
    }
  }
  if (!html) html = `<p class="muted small">${esc(t("mem.auto.none"))}</p>`;
  list.innerHTML = html;
  if (sum) sum.textContent = t("mem.auto.weekly", {n: weekCount});
}
$("mem-auto-tidy").onclick = () => tidyMemory().then(() => renderAutoMemoryCard());
$("mem-auto-setgroup").onclick = async () => {
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  const cur = currentGroup || "";
  const input = prompt(t("mem.auto.group.prompt"), cur);
  if (input == null) return;                       // cancelled
  const label = input.trim();
  await setGroupLabel(base, label);
  await loadMemoryState(ws);
  renderAutoMemoryCard();
  toast("ok", t("mem.auto.group.saved"), label ? t("mem.auto.group.saved.n", {g: label}) : t("mem.auto.group.cleared"));
};
$("mem-auto-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-scope]"); if (!b) return;
  memAutoScopeFilter = b.dataset.scope;
  [...$("mem-auto-filter").children].forEach((c) => c.setAttribute("aria-checked", String(c.dataset.scope === memAutoScopeFilter)));
  renderAutoMemoryCard();
});
$("mem-auto-list").addEventListener("click", async (e) => {
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  const merge = e.target.closest("[data-auto-merge]");
  const discard = e.target.closest("[data-auto-discard]");
  const undo = e.target.closest("[data-auto-undo]");
  const archive = e.target.closest("[data-auto-archive]");
  const promote = e.target.closest("[data-auto-promote]");
  const demote = e.target.closest("[data-auto-demote]");
  if (merge) {
    const [store, i] = merge.dataset.autoMerge.split(":");
    const drafts = await loadPendingDrafts(ws);
    const item = (drafts[store] || [])[+i]; if (item == null) return;
    await approveMemoryDraft(store, [item]); renderAutoMemoryCard();
  } else if (discard) {
    const [store, i] = discard.dataset.autoDiscard.split(":");
    const drafts = await loadPendingDrafts(ws);
    const item = (drafts[store] || [])[+i]; if (item == null) return;
    await discardMemoryDraft(store, item); renderAutoMemoryCard();
  } else if (undo) {
    const ent = memAutoEntries[+undo.dataset.autoUndo]; if (!ent) return;
    await undoAutoMemory(ent.store, ent.scope, [ent.text], base, currentGroup); await loadMemoryState(ws); renderAutoMemoryCard();
  } else if (archive) {
    const ent = memAutoEntries[+archive.dataset.autoArchive]; if (!ent) return;
    await archiveAutoEntry(ent.store, ent.scope, ent.text, base, currentGroup); await loadMemoryState(ws); renderAutoMemoryCard();
  } else if (promote) {
    const ent = memAutoEntries[+promote.dataset.autoPromote]; if (!ent) return;
    const to = await promoteEntry(ent.store, ent.scope, ent.text, base, currentGroup); await loadMemoryState(ws); renderAutoMemoryCard();
    toast("ok", t("mem.auto.moved"), t("mem.auto.promote.n", {to: scopeLabel(to)}));
  } else if (demote) {
    const ent = memAutoEntries[+demote.dataset.autoDemote]; if (!ent) return;
    const to = await demoteEntry(ent.store, ent.scope, ent.text, base, currentGroup); await loadMemoryState(ws); renderAutoMemoryCard();
    toast("ok", t("mem.auto.moved"), t("mem.auto.demote.n", {to: scopeLabel(to)}));
  }
});
// ---- weekly summary + new-entry modal wiring ----
$("mem-auto-weekly").onclick = () => openWeeklyModal();
$("mem-auto-newgroup").onclick = () => openNewEntry("group");
$("mem-global-new").onclick = () => openNewEntry("global");
if ($("weekly-close")) $("weekly-close").onclick = closeWeeklyModal;
if ($("weekly-undoall")) $("weekly-undoall").onclick = async () => {
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  for (const ent of weeklyEntries) await undoAutoMemory(ent.store, ent.scope, [ent.text], base, currentGroup);
  await loadMemoryState(ws);
  openWeeklyModal();
};
if ($("weekly-list")) $("weekly-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-weekly-undo]"); if (!btn) return;
  const ws = activeSession() && activeSession().workspace; if (!ws) return;
  const base = ws.replace(/\/$/, "");
  const ent = weeklyEntries[+btn.dataset.weeklyUndo]; if (!ent) return;
  await undoAutoMemory(ent.store, ent.scope, [ent.text], base, currentGroup);
  await loadMemoryState(ws);
  openWeeklyModal();
});
if ($("newentry-close")) $("newentry-close").onclick = closeNewEntry;
if ($("newentry-cancel")) $("newentry-cancel").onclick = closeNewEntry;
if ($("newentry-submit")) $("newentry-submit").onclick = submitNewEntry;
// Human-readable label for a scope tier (localised, includes the group name when relevant).
function scopeLabel(scope) {
  if (scope === "global") return t("mem.auto.to.global");
  if (scope === "group") return t("mem.auto.to.group", {g: currentGroup});
  return t("mem.auto.to.workspace");
}

async function renderNotesCard() {
  const ws = activeSession() && activeSession().workspace;
  const list = $("mem-notes-list"); const empty = $("mem-notes-empty"); const tag = $("mem-notes-ws");
  if (tag) tag.textContent = ws ? ws : "";
  if (!ws) { if (empty) empty.hidden = false; if (list) list.innerHTML = ""; return; }
  if (empty) empty.hidden = true;
  const base = ws.replace(/\/$/, ""); const dir = base + "/.strata-memory";
  const files = (await mcpTxt("filesystem", "list", {path: dir})).split("\n").map((x) => x.trim()).filter(Boolean);
  const notes = files.filter((f) => /^auto-.*\.md$/i.test(f));
  if (!notes.length) { if (list) list.innerHTML = '<div class="kb-source muted">' + t("mem.notes.empty") + '</div>'; return; }
  if (list) list.innerHTML = notes.map((f) => {
    const path = dir + "/" + f;
    return '<div class="mem-kb-item"><div class="kb-source"><span class="kb-source__name" title="' + esc(f) + '">' + esc(f) +
      '</span><button class="st-btn st-btn--ghost st-btn--sm" data-note-view="' + esc(path) + '">' + t("mem.kb.view") +
      '</button><button class="st-btn st-btn--ghost st-btn--sm" data-note-edit="' + esc(path) + '">' + t("drawer.archive.edit") +
      '</button><button class="st-btn st-btn--ghost st-btn--sm" data-note-del="' + esc(path) + '">' + t("side.delete") + '</button></div>' +
      '<pre class="mem-src-body" hidden></pre></div>';
  }).join("");
  restoreMemExpand("mem-notes-list", memExpanded.notes);
}
$("mem-notes-list").addEventListener("click", async (e) => {
  const view = e.target.closest("[data-note-view]"); const del = e.target.closest("[data-note-del]");
  const edit = e.target.closest("[data-note-edit]"); const save = e.target.closest("[data-note-save]"); const cancel = e.target.closest("[data-note-cancel]");
  if (view) {
    const item = view.closest(".mem-kb-item"); if (!item) return;
    const pre = item.querySelector(".mem-src-body"); if (!pre) return;
    const k = view.dataset.noteView;
    if (pre.dataset.loaded) { pre.hidden = !pre.hidden; if (pre.hidden) memExpanded.notes.delete(k); else memExpanded.notes.add(k); expandSetSave("strata.memExpand.notes", memExpanded.notes); return; }
    pre.textContent = t("mem.kb.loading"); pre.hidden = false;
    memExpanded.notes.add(k); expandSetSave("strata.memExpand.notes", memExpanded.notes);
    const res = await fsRead(view.dataset.noteView);
    pre.textContent = res || t("mem.kb.nohit"); pre.dataset.loaded = "1";
  } else if (edit) {
    const item = edit.closest(".mem-kb-item"); if (!item) return;
    const pre = item.querySelector(".mem-src-body"); if (!pre) return;
    const res = await fsRead(edit.dataset.noteEdit);
    pre.hidden = false;
    pre.innerHTML = '<textarea class="st-input" rows="10" style="width:100%">' + esc(res || '') + '</textarea>' +
      '<div class="st-btnrow" style="margin-top:6px">' +
      '<button class="st-btn st-btn--secondary st-btn--sm" data-note-save="' + esc(edit.dataset.noteEdit) + '">' + t("drawer.archive.save") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" data-note-cancel>' + t("drawer.archive.cancel") + '</button></div>';
    pre.dataset.loaded = "1";
    return;
  } else if (save) {
    const item = save.closest(".mem-kb-item"); const ta = item && item.querySelector("textarea");
    await fsWrite(save.dataset.noteSave, ta ? ta.value : "");
    const nm = save.dataset.noteSave.split(/[\\/]/).pop().replace(/\.md$/i, "");
    await mcpTxt("memory", "forget", {source: nm});
    await mcpTxt("memory", "ingest", {path: save.dataset.noteSave});
    toast("ok", t("mem.notes.deleted.title"), t("mem.kb.import.ok"));
    renderNotesCard();
    return;
  } else if (cancel) { renderNotesCard(); return;
  } else if (del) {
    const path = del.dataset.noteDel;
    if (!confirm(t("mem.notes.del.confirm"))) return;
    const s0 = activeSession(); const ws0 = (s0 && s0.workspace) ? s0.workspace.replace(/\/$/, "") : "";
    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "trash", workspace: ws0, paths: [path]})});
    const j = await r.json();
    if (!(j && j.trashed && j.trashed.length)) { toast("error", t("recycle.err"), esc((j && j.error && j.error.message) || ""), 4000); return; }
    const src = path.split(/[\\/]/).pop().replace(/\.md$/i, "");
    await mcpTxt("memory", "forget", {source: src});
    toast("ok", t("mem.notes.deleted.title"), "");
    renderNotesCard();
  }
});

async function renderGlobalCard() {
  const pre = $("mem-global-body"); if (!pre) return;
  const txt = await fsRead(PROJECT_MEMORY);
  if (pre.dataset.editing){
    pre.textContent = "";
    const ta = document.createElement("textarea"); ta.className = "st-input"; ta.rows = 14; ta.style.width = "100%"; ta.value = txt || "";
    pre.appendChild(ta);
    const row = document.createElement("div"); row.className = "st-btnrow"; row.style.marginTop = "6px";
    row.innerHTML = '<button class="st-btn st-btn--primary st-btn--sm" id="mem-global-save">' + t("drawer.archive.save") + '</button>' +
      '<button class="st-btn st-btn--ghost st-btn--sm" id="mem-global-cancel">' + t("drawer.archive.cancel") + '</button>';
    pre.appendChild(row);
    const sb = row.querySelector("#mem-global-save"), cb = row.querySelector("#mem-global-cancel");
    if (sb) sb.onclick = async () => { await fsWrite(PROJECT_MEMORY, ta.value); toast("ok", t("mem.global.title"), t("mem.rules.saved.title")); renderGlobalCard(); };
    if (cb) cb.onclick = () => { delete pre.dataset.editing; renderGlobalCard(); };
    return;
  }
  pre.dataset.loaded = "1";
  pre.textContent = txt || t("mem.global.none");
}
// global memory edit button is injected into the card header by the delegated handler below.
if (!window.__memGlobalEditWired){
  window.__memGlobalEditWired = 1;
  document.addEventListener("click", (e) => {
    const gb = e.target.closest && e.target.closest("[data-global-edit]"); if (!gb) return;
    const pre = $("mem-global-body"); if (pre){ pre.dataset.editing = "1"; renderGlobalCard(); }
  });
}

// their results (as the model read them), then the rest - so the next question can build on what the tools found.
function assistantMessages(m) {
  const ran = (m.tools || []).filter((t) => t.round != null && t.result != null && t.state !== "skipped");
  // #1392: a turn with no answer text (only reasoning, a stop before the first content token, or an error) still goes
  // back as an assistant turn, so the history keeps alternating and a reasoning model sees that it already answered.
  // The server leaves such a turn out of the prompt itself (serve/frontend.py, #843); reasoning_content rides along.
  if (!ran.length) {
    const msg = {role: "assistant", content: m.text || ""};
    if (!m.text && m.reasoning) msg.reasoning_content = m.reasoning;
    return [msg];
  }
  const out = [];
  let pos = 0;
  for (const r of [...new Set(ran.map((t) => t.round))]) {
    const calls = ran.filter((t) => t.round === r);
    const at = Math.min(Math.max(pos, calls[0].at || 0), m.text.length);
    out.push({role: "assistant", content: m.text.slice(pos, at).trim(),
              tool_calls: calls.map((t) => ({id: t.id, type: "function", function: {name: t.name, arguments: JSON.stringify(t.arguments || {})}}))});
    for (const t of calls) out.push({role: "tool", tool_call_id: t.id, content: t.result});
    pos = at;
  }
  const rest = m.text.slice(pos).trim();
  if (rest) out.push({role: "assistant", content: rest});
  return out;
}

function setBusy(on) {
  $("stop-btn").hidden = !on;
  $("send-btn").disabled = on;
  $("composer-hint").textContent = on ? "" : "Shift+Enter: new line";
  // When the AI goes idle, flush any sparks the user queued while it was busy.
  if (!on) { setTimeout(drainSparkQueue, 0); setTimeout(autofixTick, 0); }
}

// ------------------------------------------------------------------ Sparks (灵感便签)
// A "spark" is a user-captured idea / note jotted down while the AI is busy. It waits
// in a pending list and is pushed into the current chat (as a normal user message) when
// the user runs it manually, or automatically once the AI goes idle if it was queued.
// M1: capture → list/manage → execute into the active chat. M2: done/error statuses,
// bounded auto-retry, run-all, clear, result write-back. M3: drag reorder, bulk select,
// tags + filter, and a zero-backend long-term memory bridge. All in localStorage.
const SPARK_MAX_RETRIES = 2;            // 1 initial send + up to 2 auto retries = 3 attempts
let sparkFilter = "all";                // "all" or a tag string
const sparkSel = new Set();             // ids selected for bulk delete
let sparkDragId = null;                 // id being dragged

function getSparks() { return store.get("spark", []); }
function setSparks(arr) { store.set("spark", arr); updateSparkBadge(); }
function getSparkMemory() { return store.get("spark_memory", []); }
function setSparkMemory(arr) { store.set("spark_memory", arr); }

function normalizeTags(v) {
  if (Array.isArray(v)) return [...new Set(v.map((t) => String(t).trim()).filter(Boolean))];
  if (typeof v !== "string") return [];
  return [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))];
}

// --- Rich-text safety (M3 rich editor) ----------------------------------------
// Allow-list sanitizer for user-authored spark notes. Strips every element not in
// the list (scripts/styles/imgs/handlers) and every attribute except a safe href.
const SPARK_HTML_ALLOW = new Set(["B", "STRONG", "I", "EM", "U", "BR", "P", "DIV", "UL", "OL", "LI", "SPAN", "A", "IMG", "BUTTON", "SVG", "USE"]);   // 2026-10-28: IMG added so pasted/persisted spark images survive sanitizeHtml; 2026-10-31: BUTTON/SVG/USE added so an inline thumbnail's delete button (and its sprite icon) survive sanitizeHtml instead of being flattened to text
const SPARK_IMG_SRC = /^(https?:\/\/|data:image\/|\/data\/uploads\/|\/)/i;   // src scheme allow-list: reject javascript:, blob: (dead after reload), and protocol-relative//offsite
const SPARK_ATTR_ALLOW = new Set(["class", "title", "alt", "aria-label", "type", "role"]);   // 2026-10-31: safe, non-executing attributes kept on surviving tags (the delete button needs class/data-delpid/aria-label/type); data-* also allowed; on* event handlers stay stripped
function sanitizeHtml(html) {
  const root = document.createElement("div");
  root.innerHTML = html || "";
  (function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) continue;            // text node: keep
      if (child.nodeType !== 1) { node.removeChild(child); continue; }
      if (!SPARK_HTML_ALLOW.has(child.tagName.toUpperCase())) {     // drop unsafe tag, keep its text
        node.replaceChild(document.createTextNode(child.textContent), child);
        continue;
      }
      for (const a of Array.from(child.attributes)) {
        if (child.tagName === "A" && a.name === "href") {
          if (!/^(https?:|mailto:)/i.test((a.value || "").trim())) child.removeAttribute("href");
        } else if (child.tagName === "IMG" && a.name === "src") {
          // image src must match the scheme allow-list; strip otherwise (XSS + dead blob URLs)
          if (!SPARK_IMG_SRC.test((a.value || "").trim())) child.removeAttribute("src");
        } else if (child.tagName === "IMG" && (a.name === "alt" || a.name === "title")) {
          // the filename lives on the image as alt/title -> hover; safe plain text, keep it
        } else if (child.tagName.toUpperCase() === "USE" && (a.name === "href" || a.name === "xlink:href")) {
          // sprite icon reference: an in-page fragment anchor (#i-trash) survives; 2026-11-02 also
          // accepts the in-page sprite file path (web/sprite.svg#...) because icon() emits exactly that
          // href -- without it the delete-button <use> is emptied and the button becomes a dead shell
          // after SAVE (the reported symptom). A scheme that could reach off-site is STILL stripped (XSS net intact).
          const _useval = (a.value || "").trim();
          if (!/^#/.test(_useval) && !/^web\/sprite\.svg#/i.test(_useval)) child.removeAttribute(a.name);
        } else if (SPARK_ATTR_ALLOW.has(a.name) || /^data-/.test(a.name)) {
          // structural/hook attributes on surviving tags (class/aria-label/type/role + data-*).
          // event handlers (on*) are NOT in the allow-set, so they fall through to the strip below.
        } else {
          child.removeAttribute(a.name);
        }
      }
      walk(child);
    }
  })(root);
  return root.innerHTML;
}

// Convert sanitized rich HTML back to plain text (used when pushing a spark into
// the chat as a normal user message, which is plain-text only).
function sparkHtmlToText(html) {
  const d = document.createElement("div");
  d.innerHTML = html || "";
  d.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
  d.querySelectorAll("div,p,li").forEach((b) => b.appendChild(document.createTextNode("\n")));
  return (d.textContent || "").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}

// 2026-11-03: a note with NO text is still valid if its sanitized HTML carries a real image whose
// src survived the scheme allow-list. sanitizeHtml already strips javascript:/blob:, so an img that
// still has a src here is safe; a dangerous pure-image note ends up with none and stays rejected.
function hasValidImageHtml(cleanHtml) {
  if (!cleanHtml) return false;
  const d = document.createElement("div");
  d.innerHTML = cleanHtml;
  for (const i of d.querySelectorAll("img")) { if (i.getAttribute("src")) return true; }
  return false;
}

function addSpark(text, tags, html) {
  const clean = html ? sanitizeHtml(html) : undefined;   // 2026-11-03: hoisted above the guard so a PURE-IMAGE note is judged against its sanitized HTML
  text = (text || "").trim();
  if (!text && !hasValidImageHtml(clean)) return false;   // 2026-11-03: image-only note (no text) now valid; empty + no-valid-image stays rejected (XSS net intact)
  const arr = getSparks();
  arr.unshift({
    id: "spk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
    text,
    html: clean,                // sanitized rich HTML; undefined → render as plain text
    status: "pending",          // pending → queued → sent → done | error
    createdAt: Date.now(),
    sentAt: null, executedAt: null, execDur: null, retries: 0,
    tags: normalizeTags(tags),
    archived: false,            // true once promoted to long-term memory
    target: "current",
  });
  setSparks(arr);
  renderSpark();                // keep the (possibly hidden) list in sync with storage
  return true;
}

function updateSparkBadge() {
  const badge = $("spark-tab-badge");
  if (!badge) return;
  // Count everything still open / needing attention (sent & done are settled).
  const n = getSparks().filter((s) => s.status === "pending" || s.status === "queued" || s.status === "error").length;
  if (n > 0) { badge.hidden = false; badge.textContent = n > 99 ? "99+" : String(n); }
  else badge.hidden = true;
}

function fmtSparkTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return t("side.time.now");
  if (diff < 3600) return t("side.time.min", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("side.time.hour", { n: Math.floor(diff / 3600) });
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function sparkVisible(s) {
  if (s.archived) return false;
  if (sparkFilter === "all") return true;
  return (s.tags || []).includes(sparkFilter);
}

function renderSpark() {
  const list = $("spark-list");
  if (!list) return;
  const all = getSparks();
  const active = all.filter((s) => !s.archived);
  const view = active.filter(sparkVisible);
  const empty = $("spark-empty");
  if (!active.length) {
    if (empty) empty.hidden = false;
    list.innerHTML = "";
    renderSparkFilters();
    renderSparkMemory();
    return;
  }
  if (empty) empty.hidden = true;
  list.innerHTML = view.map((s) => `
    <div class="kb-item spark-item" data-id="${s.id}" draggable="true">
      <label class="spark-item__sel"><input type="checkbox" class="spark-sel" data-id="${s.id}" ${sparkSel.has(s.id) ? "checked" : ""}></label>
      <div class="spark-item__body">
        <pre class="spark-item__text"></pre>
        <div class="spark-item__meta muted small">
          <span class="spark-status spark-status--${s.status}">${esc(t("spark.status." + s.status))}</span>
          ${(s.tags && s.tags.length) ? `<span class="spark-tags">${s.tags.map((tg) => `<span class="spark-tag">${esc(tg)}</span>`).join("")}</span>` : ""}
          ${s.status === "done" && s.execDur != null ? `<span class="spark-dur">${esc(t("spark.exec.dur", { n: s.execDur }))}</span>` : ""}
          ${(s.runCount > 0) ? `<span class="spark-runs">${esc(t("spark.run.count", { n: s.runCount }))}</span>` : ""}
          <span class="spark-item__time">${fmtSparkTime(s.createdAt)}</span>
        </div>
      </div>
      <div class="spark-item__actions">
        ${(s.status === "pending" || s.status === "error" || s.status === "done") ? `<button type="button" class="st-btn st-btn--small st-btn--primary ${s.status === "done" ? "spark-rerun" : "spark-exec"}" data-id="${s.id}" data-i18n="${s.status === "error" ? "spark.retry.btn" : (s.status === "done" ? "spark.rerun.btn" : "spark.item.exec")}">${s.status === "error" ? "Retry" : (s.status === "done" ? "Re-run" : "Run")}</button>` : ""}
        <button type="button" class="st-btn st-btn--small st-btn--secondary spark-edit" data-id="${s.id}" data-i18n="spark.item.edit">Edit</button>
        <button type="button" class="st-btn st-btn--small st-btn--ghost spark-del" data-id="${s.id}" data-i18n="spark.item.del">Delete</button>
        <button type="button" class="st-btn st-btn--small st-btn--ghost spark-promote" data-id="${s.id}" data-i18n="spark.promote.btn">Promote</button>
      </div>
    </div>`).join("");
  // Render note body. `html` is sanitized at save time, so innerHTML is safe here;
  // if a spark has no html we fall back to textContent (never innerHTML for raw text).
  for (const el of list.querySelectorAll(".spark-item")) {
    const s = all.find((x) => x.id === el.dataset.id);
    if (!s) continue;
    const txtEl = el.querySelector(".spark-item__text");
    if (s.html) txtEl.innerHTML = s.html; else txtEl.textContent = s.text;
  }
  if (window.i18n) window.i18n.applyI18n(list);   // repaint the data-i18n buttons inside the list
  renderSparkFilters();
  renderSparkMemory();
}

function renderSparkFilters() {
  const box = $("spark-filters");
  if (!box) return;
  const tags = [...new Set(getSparks().filter((s) => !s.archived && s.tags).flatMap((s) => s.tags))].sort();
  const chips = ["all", ...tags];
  box.innerHTML = chips.map((tg) => `<button type="button" class="spark-filter ${sparkFilter === tg ? "is-active" : ""}" data-filter="${esc(tg)}">${tg === "all" ? esc(t("spark.filter.all")) : esc(tg)}</button>`).join("");
}

function renderSparkMemory() {
  const list = $("spark-memory-list");
  if (!list) return;
  const mem = getSparkMemory();
  const empty = $("spark-memory-empty");
  if (!mem.length) { if (empty) empty.hidden = false; list.innerHTML = ""; return; }
  if (empty) empty.hidden = true;
  list.innerHTML = mem.map((m) => `
    <div class="kb-item spark-memory-item" data-id="${m.id}">
      <div class="spark-item__body">
        <pre class="spark-item__text"></pre>
        <div class="spark-item__meta muted small">
          ${(m.tags && m.tags.length) ? `<span class="spark-tags">${m.tags.map((tg) => `<span class="spark-tag">${esc(tg)}</span>`).join("")}</span>` : ""}
          <span class="spark-item__time">${fmtSparkTime(m.createdAt)}</span>
        </div>
      </div>
      <div class="spark-item__actions">
        <button type="button" class="st-btn st-btn--small st-btn--secondary spark-restore" data-id="${m.id}" data-i18n="spark.restore.btn">Restore</button>
        <button type="button" class="st-btn st-btn--small st-btn--ghost spark-mem-del" data-id="${m.id}" data-i18n="spark.item.del">Delete</button>
      </div>
    </div>`).join("");
  for (const el of list.querySelectorAll(".spark-memory-item")) {
    const m = mem.find((x) => x.id === el.dataset.id);
    if (!m) continue;
    const txtEl = el.querySelector(".spark-item__text");
    if (m.html) txtEl.innerHTML = m.html; else txtEl.textContent = m.text;
  }
  if (window.i18n) window.i18n.applyI18n(list);
}

// Manual run: if the AI is mid-task, queue it so it fires the moment the AI goes idle;
// otherwise send straight into the current chat and switch to it. Mutates `s` on the
// array we just read and writes THAT array back — calling getSparks() again would
// re-parse storage and silently drop the status change.
async function executeSpark(id) {
  const arr = getSparks();
  const s = arr.find((x) => x.id === id);
  if (!s || s.status === "sent") return;   // done/pending/error/queued are re-runnable
  if (busy) {
    if (s.status !== "queued") { s.status = "queued"; setSparks(arr); renderSpark(); }
    toast("info", t("spark.queued.toast", { n: arr.filter((x) => x.status !== "sent" && x.status !== "done").length }));
    return;
  }
  s.status = "sent";
  s.sentAt = Date.now();
  setSparks(arr);
  renderSpark();
  toast("success", t("spark.sent.toast"));
  showTab("chat");
  const _push = sparkToPush(s); await sendUserMessage(_push.text, id, _push.images);
}

// Called after a spark's turn finishes: stamp the outcome. On failure we auto-retry
// (bounded by SPARK_MAX_RETRIES); once exhausted we leave it as "error" for a manual retry.
async function markSparkExecuted(sparkId) {
  const arr = getSparks();
  const s = arr.find((x) => x.id === sparkId);
  if (!s) return;
  const last = messages[messages.length - 1];
  const failed = !!(last && last.error && !last.stopped);
  if (failed) {
    s.retries = (s.retries || 0) + 1;
    if (s.retries <= SPARK_MAX_RETRIES) {
      setSparks(arr);
      renderSpark();
      toast("warn", t("spark.retry.toast", { n: s.retries }));
      const _push = sparkToPush(s); await sendUserMessage(_push.text, sparkId, _push.images);   // busy is null now → immediate resend
      return;
    }
    s.status = "error";
    setSparks(arr);
    renderSpark();
    toast("error", t("spark.error.toast"));
    return;
  }
  s.status = "done";
  s.runCount = (s.runCount || 0) + 1;
  s.executedAt = Date.now();
  if (last && last.stats) s.execDur = Math.round((last.stats.dur || 0) * 10) / 10;
  setSparks(arr);
  renderSpark();
}

// Flush queued sparks once the AI is idle. Called (deferred) from setBusy(false).
async function drainSparkQueue() {
  const arr = getSparks();
  const queued = arr.filter((x) => x.status === "queued");
  if (!queued.length) return;
  for (const s of queued) { s.status = "sent"; s.sentAt = Date.now(); }
  setSparks(arr);
  renderSpark();
  for (const s of queued) { const _push = sparkToPush(s); await sendUserMessage(_push.text, s.id, _push.images); }
  toast("success", t("spark.sent.toast"));
}

function deleteSpark(id) {
  if (typeof window.confirm === "function") {
    try { if (!window.confirm(t("spark.del.confirm"))) return; } catch (e) { /* jsdom: ignore */ }
  }
  sparkSel.delete(id);
  setSparks(getSparks().filter((x) => x.id !== id));
  renderSpark();
}

function editSpark(id) {
  const arr = getSparks();
  const s = arr.find((x) => x.id === id);
  if (!s) return;
  const item = document.querySelector(`#spark-list .spark-item[data-id="${id}"]`);
  if (!item) return;
  item.querySelector(".spark-item__actions").hidden = true;
  const body = item.querySelector(".spark-item__body");
  const txtEl = body.querySelector(".spark-item__text");
  txtEl.hidden = true;
  const rich = document.createElement("div");
  rich.className = "spark-edit-rich";
  rich.innerHTML = `
    <div class="spark-rich__bar">
      <button type="button" class="spark-rich__btn" data-cmd="bold" data-i18n-attr="title:spark.fmt.bold"><b>B</b></button>
      <button type="button" class="spark-rich__btn" data-cmd="italic" data-i18n-attr="title:spark.fmt.italic"><i>I</i></button>
      <button type="button" class="spark-rich__btn" data-cmd="insertUnorderedList" data-i18n-attr="title:spark.fmt.list">&bull;</button>
    </div>
    <div class="st-input st-textarea spark-edit-ta rich" contenteditable="true"></div>`;
  const ed = rich.querySelector(".spark-edit-ta");
  ed.innerHTML = s.html || s.text || "";
  ed.addEventListener("paste", (e) => pasteImageToRich(e, ed));
  body.insertBefore(rich, txtEl.nextSibling);
  const tagInput = document.createElement("input");
  tagInput.className = "st-input spark-edit-tags";
  tagInput.placeholder = t("spark.tags.ph");
  tagInput.value = (s.tags || []).join(", ");
  body.appendChild(tagInput);
  const bar = document.createElement("div");
  bar.className = "spark-item__actions";
  bar.innerHTML = `
    <button type="button" class="st-btn st-btn--small st-btn--primary spark-edit-save" data-id="${id}" data-i18n="spark.edit.save">Save</button>
    <button type="button" class="st-btn st-btn--small st-btn--ghost spark-edit-cancel" data-id="${id}" data-i18n="spark.edit.cancel">Cancel</button>`;
  item.appendChild(bar);
  if (window.i18n) { window.i18n.applyI18n(rich); window.i18n.applyI18n(bar); }
  ed.focus();
}

function saveSparkEdit(id, html, tags) {
  const arr = getSparks();
  const s = arr.find((x) => x.id === id);
  if (s) {
    const clean = sanitizeHtml(html || "");
    const newText = clean ? sparkHtmlToText(clean) : (html || "").trim();
    if (newText) { s.text = newText; s.html = clean || undefined; }
    s.tags = normalizeTags(tags);
  }
  setSparks(arr);
  renderSpark();
}

// Push a stored spark into chat: its images live ONLY in s.html (paste lands them as a data-pid anchor + img). When the body carries such anchored images with a live src, extract them and rebuild the text WITH [img:pid] anchors so mixedSegments/serialize/bubble/modal all keep the picture; a spark with no real (anchored, src-valid) image pushes as plain text exactly as before (no markup leaks).
function sparkToPush(s) {
  const html = (s && s.html) || "";
  const d = document.createElement("div");
  d.innerHTML = html;
  const nodes = d.querySelectorAll("[data-pid]");
  const images = [];
  nodes.forEach((node) => {
    const pid = node.getAttribute("data-pid");
    const img = (node.tagName === "IMG") ? node : node.querySelector("img");
    const src = img && img.getAttribute("src");
    if (!src) return;   // sanitizer stripped an unsafe src: nothing to send
    const name = node.getAttribute("title") || node.getAttribute("alt") || (img && (img.getAttribute("alt") || img.getAttribute("title"))) || "image";
    images.push({ pid: pid, url: src, name: name });
  });
  if (!images.length) return { text: sparkHtmlToText(html) || ((s && s.text) || "").trim(), images: [] };
  return { text: ceTextFromDom(d).trim(), images: images };
}
// Send arbitrary text as a user message into the current chat (shared by spark exec).
// When sparkId is given, the turn's outcome is written back to that spark afterwards.
async function sendUserMessage(text, sparkId, images) {
  if (busy) return false;
  text = (text || "").trim();
  const imgs = images || [];
  if (!text && !imgs.length) return false;
  messages.push({ role: "user", text, images: imgs, files: [], time: Date.now() });
  ceSetText($("input"), "");
  await streamAssistant();
  if (sparkId) await markSparkExecuted(sparkId);
  return true;
}

// ---- M2: batch / queue management helpers ------------------------------------
async function runAllSparks() {
  const ids = getSparks().filter((s) => sparkVisible(s) && (s.status === "pending" || s.status === "error")).map((s) => s.id);
  if (!ids.length) return;
  for (const id of ids) await executeSpark(id);
}

function clearDoneSparks() {
  setSparks(getSparks().filter((s) => s.status !== "done"));
  renderSpark();
}

function clearAllSparks() {
  if (typeof window.confirm === "function") {
    try { if (!window.confirm(t("spark.clear.all.confirm"))) return; } catch (e) { /* jsdom: ignore */ }
  }
  setSparks(getSparks().filter((s) => s.archived));   // keep memory-promoted items alive
  sparkSel.clear();
  renderSpark();
  toast("info", t("spark.clear.all"));
}

function deleteSelectedSparks() {
  if (!sparkSel.size) return;
  const ids = new Set(sparkSel);
  sparkSel.clear();
  setSparks(getSparks().filter((s) => !ids.has(s.id)));
  renderSpark();
}

function updateSelAllState() {
  const selall = $("spark-selall");
  if (!selall) return;
  const visible = getSparks().filter(sparkVisible);
  const selectedVisible = visible.filter((s) => sparkSel.has(s.id)).length;
  selall.checked = visible.length > 0 && selectedVisible === visible.length;
  selall.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
}

// ---- M3: long-term memory bridge (zero backend, localStorage only) -----------
function promoteSpark(id) {
  const arr = getSparks();
  const s = arr.find((x) => x.id === id);
  if (!s) return;
  s.archived = true;
  const mem = getSparkMemory();
  mem.unshift({ id: s.id, text: s.text, html: s.html, tags: s.tags || [], createdAt: s.createdAt, promotedAt: Date.now() });
  setSparks(arr);
  setSparkMemory(mem);
  renderSpark();
  toast("success", t("spark.promoted.toast"));
}

function restoreSpark(memId) {
  const mem = getSparkMemory();
  const m = mem.find((x) => x.id === memId);
  if (!m) return;
  const arr = getSparks();
  const s = arr.find((x) => x.id === m.id);
  if (s) s.archived = false;     // un-archive the existing entry (no duplicate id)
  setSparks(arr);
  setSparkMemory(mem.filter((x) => x.id !== memId));
  renderSpark();
}

function deleteMemory(memId) {
  const mem = getSparkMemory();
  const arr = getSparks();
  const s = arr.find((x) => x.id === memId);
  if (s) s.archived = false;   // bring the idea back to the active list (don't silently lose it)
  setSparks(arr);
  setSparkMemory(mem.filter((x) => x.id !== memId));
  renderSpark();
}

// ---- M3: drag reorder (persisted in the stored array order) -------------------
function reorderSpark(dragId, dropId) {
  if (!dragId || dragId === dropId) return;
  const arr = getSparks();
  const from = arr.findIndex((x) => x.id === dragId);
  const to = arr.findIndex((x) => x.id === dropId);
  if (from < 0 || to < 0) return;
  const [moved] = arr.splice(from, 1);
  arr.splice(to, 0, moved);
  setSparks(arr);
  renderSpark();
}

// contenteditable paste: image bytes -> upload to server -> insert <img> at caret; offline
// or upload failure falls back to inline base64 data URL so the image still survives sanitizeHtml
// (the sanitizer now allows data:image/* per the scheme whitelist). Plain text paste untouched.
async function pasteImageToRich(e, editable) {
  const isComposer = (editable === $("input"));
  if (!modelAcceptsImages()) return;
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  let files = [...(cd.files || [])].filter((f) => f && f.type && f.type.startsWith("image/"));
  if (!files.length && typeof cd.items === "object") {
    files = [...cd.items]
      .filter((it) => it && it.kind === "file" && it.type && it.type.startsWith("image/"))
      .map((it) => (typeof it.getAsFile === "function" ? it.getAsFile() : null))
      .filter(Boolean);
  }
  if (!files.length) return;
  e.preventDefault();
  for (const f of files) {
    const reader = new FileReader();
    // Register the gate BEFORE the async read starts: at send time pendingPastes is already
    // populated even though onload has not fired yet, so send()/confirmEdit await it. onload
    // resolves it the instant DOM + array land; the upload stays background (after resolve).
    const _gate = new Promise((res) => { reader._landResolve = res; });
    pendingPastes.add(_gate);
    _gate.then(() => pendingPastes.delete(_gate));
    reader.onload = async () => {
        // A1: land the DOM node + the array entry SYNCHRONOUSLY, right when the local FileReader
        // result is ready and BEFORE any network upload, so a send/re-generate that fires the instant
        // you paste still has the [img:N] anchor (via data-pid) and the attachment to assemble from.
        // The base64 data URL is the storage fallback; the slow upload below only UPGRADES it to a ref.
        const dataUrl = String(reader.result);
        const _nm = f.name || "pasted";
        const pid = attachNextPid();
        const entry = {kind: "image", url: dataUrl, name: _nm, pid};
        if (document.queryCommandSupported && document.queryCommandSupported("insertHTML")) {
          document.execCommand("insertHTML", false,
            `<span class="ce-thumb" contenteditable="false" data-pid="${pid}" title="${esc(_nm)}"><span class="ce-thumb__box"><img class="inline-ce-img" src="${dataUrl}" alt="${esc(_nm)}" title="${esc(_nm)}"><button type="button" class="ce-thumb__x" data-delpid="${pid}" aria-label="${esc(t("attach.remove"))}">${icon("trash")}</button></span></span>`);
        } else {
          editable.appendChild(makeInlineThumb({ pid, url: dataUrl, name: _nm }, editable));
        }
        // Move the caret to AFTER the inserted chip (the chip is atomic, so typing lands OUTSIDE it).
        if (isCE(editable)) {
          const chipNode = editable.querySelector('[data-pid="' + pid + '"]');
          const sel = window.getSelection();
          if (chipNode && sel && sel.removeAllRanges) {
            const range = document.createRange(); range.setStartAfter(chipNode); range.collapse(true);
            sel.removeAllRanges(); sel.addRange(range);
          }
        }
        if (isComposer) { attachments.push(entry); renderAttachments(); }
        else { editAttachments.push(entry); renderEditAttachments(); }
        autosize(editable);
        if (reader._landResolve) reader._landResolve();   // DOM + array are real now -> the paste gate is safe to send on
        // best-effort: upgrade the stored base64 to a server ref in the BACKGROUND (never blocks the
        // paste). The DOM node + array entry already exist, so send is race-free either way.
        if (modelAcceptsImages()) {
          try {
            const j = await (await fetch("api/images/upload", {method: "POST", headers: headers(true),
              body: JSON.stringify({dataUrl, name: f.name || "pasted"})})).json();
            if (j && j.ref) {
              entry.ref = j.ref;
              const chipImg = editable.querySelector('[data-pid="' + pid + '"] .inline-ce-img');
              if (chipImg) chipImg.src = j.ref;
            }
          } catch (e) { /* offline: keep the base64 data URL as the source */ }
        }
    };
    reader.readAsDataURL(f);
  }
}

function bindSparks() {
  // dblclick on inline thumbnails in contenteditable inputs -> lightbox
  document.addEventListener("dblclick", (e) => {
    const img = e.target;
    if (img.tagName === "IMG" && (img.closest(".ce-input")||(img.classList&&img.classList.contains("inline-ce-img")&&img.closest("[data-bugtoggle]")))) {
      openImageView(img.src, img.alt || "image");
    }
  });
  const addBtn = $("spark-add-btn");
  if (addBtn) addBtn.onclick = () => {
    const ed = $("spark-add-input");
    const tags = $("spark-add-tags");
    if (!ed) return;
    const html = ed.innerHTML;
    const text = sparkHtmlToText(html);
    if (addSpark(text, tags ? tags.value : "", html)) {
      ed.innerHTML = ""; if (tags) tags.value = "";
      updateSparkBadge(); toast("success", t("spark.saved.toast"));
    }
  };
  const addInput = $("spark-add-input");
  if (addInput) addInput.addEventListener("paste", (e) => pasteImageToRich(e, addInput));
  // double-click an inline image in the add box to open the viewer (mirrors the chat-bubble handler)
  if (addInput) addInput.addEventListener("dblclick", (e) => { const im = e.target.closest && e.target.closest("img"); if (im && im.getAttribute("src")) openImageView(im.getAttribute("src"), im.alt); });
  const toggle = $("spark-toggle");
  const strip = $("spark-strip");
  if (toggle && strip) toggle.onclick = () => {
    strip.hidden = !strip.hidden;
    if (!strip.hidden) { const i = $("spark-strip-input"); if (i) i.focus(); }
  };
  const stripSave = $("spark-strip-save");
  if (stripSave) stripSave.onclick = () => {
    const i = $("spark-strip-input");
    if (!i) return;
    if (addSpark(i.value)) {
      i.value = ""; strip.hidden = true; updateSparkBadge(); toast("success", t("spark.saved.toast"));
    }
  };
  const stripInput = $("spark-strip-input");
  if (stripInput) stripInput.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); if (stripSave) stripSave.click(); }
  });

  const filters = $("spark-filters");
  if (filters) filters.addEventListener("click", (e) => {
    const btn = e.target.closest(".spark-filter");
    if (!btn) return;
    sparkFilter = btn.dataset.filter;
    renderSpark();
  });

  const selall = $("spark-selall");
  if (selall) selall.onchange = () => {
    const ids = getSparks().filter(sparkVisible).map((s) => s.id);
    for (const id of ids) { if (selall.checked) sparkSel.add(id); else sparkSel.delete(id); }
    renderSpark();
  };
  const delSel = $("spark-delselected");
  if (delSel) delSel.onclick = deleteSelectedSparks;
  const runAll = $("spark-runall");
  if (runAll) runAll.onclick = runAllSparks;
  const clearDone = $("spark-cleardone");
  if (clearDone) clearDone.onclick = clearDoneSparks;
  const clearAll = $("spark-clearall");
  if (clearAll) clearAll.onclick = clearAllSparks;

  const list = $("spark-list");
  if (list) {
    // double-click an image inside a spark note to open the viewer (notes render their html via innerHTML)
    list.addEventListener("dblclick", (e) => { const im = e.target.closest && e.target.closest("img"); if (im && im.getAttribute("src")) openImageView(im.getAttribute("src"), im.alt); });
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-id]");
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.classList.contains("spark-exec") || btn.classList.contains("spark-rerun")) executeSpark(id);
      else if (btn.classList.contains("spark-edit")) editSpark(id);
      else if (btn.classList.contains("spark-del")) deleteSpark(id);
      else if (btn.classList.contains("spark-promote")) promoteSpark(id);
      else if (btn.classList.contains("spark-edit-save")) {
        const ta = list.querySelector(`.spark-item[data-id="${id}"] .spark-edit-ta`);
        const tg = list.querySelector(`.spark-item[data-id="${id}"] .spark-edit-tags`);
        saveSparkEdit(id, ta ? ta.innerHTML : "", tg ? tg.value : "");
      } else if (btn.classList.contains("spark-edit-cancel")) renderSpark();
    });
    list.addEventListener("change", (e) => {
      const cb = e.target.closest(".spark-sel");
      if (!cb) return;
      const id = cb.dataset.id;
      if (cb.checked) sparkSel.add(id); else sparkSel.delete(id);
      updateSelAllState();
    });
    list.addEventListener("dragstart", (e) => {
      const item = e.target.closest(".spark-item");
      if (!item) return;
      sparkDragId = item.dataset.id;
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        try { e.dataTransfer.setData("text/plain", sparkDragId); } catch (_) { /* jsdom */ }
      }
    });
    list.addEventListener("dragover", (e) => {
      const item = e.target.closest(".spark-item");
      if (!item || item.dataset.id === sparkDragId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    });
    list.addEventListener("drop", (e) => {
      const item = e.target.closest(".spark-item");
      if (!item || !sparkDragId) return;
      e.preventDefault();
      reorderSpark(sparkDragId, item.dataset.id);
      sparkDragId = null;
    });
  }

  const memList = $("spark-memory-list");
  if (memList) memList.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-id]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.classList.contains("spark-restore")) restoreSpark(id);
    else if (btn.classList.contains("spark-mem-del")) deleteMemory(id);
  });

  // Rich-text toolbar (used by the add box and by inline edit): keep the caret /
  // selection in the contenteditable when the button is clicked, then run the command.
  document.addEventListener("mousedown", (e) => {
    const b = e.target.closest && e.target.closest(".spark-rich__btn");
    if (b) e.preventDefault();
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest(".spark-rich__btn");
    if (!b) return;
    const cmd = b.dataset.cmd;
    try { if (document.queryCommandSupported && document.queryCommandSupported(cmd)) document.execCommand(cmd, false, null); } catch (_) { /* jsdom: no-op */ }
  });

  updateSparkBadge();
  updateSelAllState();
}

// ------------------------------------------------------------------ Models (which endpoint answers)
// The list belongs to the SERVER (models.json, shared by both server flavours). The chip names the selected
// entry and every request carries its id; the server then decides whether to answer itself, relay to a sibling
// Strata instance, or forward to an external OpenAI-compatible endpoint. See serve/model_registry.py.
window.__strataBuild = "compact-chunked/2026-10-20-r1";   // a bug report can say which build the tab runs
let modelsDoc = null;              // {selected, models:[...]} - as the server shows it (never with the keys)
let modelEditId = null;            // entry being edited in the modal; null = a new one
const POLL_MS = 4000;              // how often the dot asks the server again (probe cache is 3s)
let polling = false;               // one probe in flight at a time

// ── Read-only hardware / parallelism chip (plan A tiered probe) ──────────
// The browser cannot see the host core count, so the numbers come from the
// server (GET /api/parallel-probe) — the SAME probe module that feeds run_tests
// and the recycle pool, so what the chip shows is what actually runs. Visible
// text is language-neutral (the four numbers); i18n drives the tooltip + labels.
let hwChipData = null;                 // last probe snapshot; chip stays hidden until we have it
async function loadHwChip() {
  try {
    const r = await fetch("api/parallel-probe", { headers: headers(false) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    hwChipData = await r.json();
  } catch (e) {
    hwChipData = null;                     // old server / offline: keep the chip hidden, never lie
  }
  paintHwChip();
  return hwChipData;
}
function paintHwChip() {
  const el = $("hw-chip");
  if (!el) return;
  if (!hwChipData || !hwChipData.loads) { el.hidden = true; return; }
  const ld = hwChipData.loads;
  const V = (k) => (ld[k] && ld[k].value != null ? ld[k].value : "–");
  const seg = (k, v) => '<dt>' + esc(t("hw.chip." + k)) + '</dt><dd>' + esc(v) + '</dd>';
  el.title = t("hw.chip.tooltip", { cores: hwChipData.cores, tests: V("tests"),
                                    recycle: V("recycle_workers"), batch: V("recycle_batch") });
  el.setAttribute("aria-label", el.title);
  el.innerHTML = seg("cores", hwChipData.cores) +
                   seg("tests", V("tests")) + seg("recycle", V("recycle_workers")) +
                   seg("batch", V("recycle_batch"));
  el.hidden = false;
}

async function loadModels() {
  try {
    const r = await fetch("models/config", {headers: headers(false)});
    if (!r.ok) throw new Error("HTTP " + r.status);
    modelsDoc = await r.json();
    // Stale-tab guard: this tab runs an app.js OLDER than the one the gateway serves (a tab opened
    // before an update never re-fetches app.js on its own — no-cache only helps at load time). The
    // build id rides on every poll, so a superseded tab reloads itself instead of silently running
    // old code. sessionStorage makes it a one-shot: after the reload the ids match and we stop.
    if (modelsDoc && modelsDoc.build && modelsDoc.build !== window.__strataBuild
        && !sessionStorage.getItem("strata.build.reloaded")) {
      try { sessionStorage.setItem("strata.build.reloaded", "1"); } catch (e) {}
      toast("info", t("app.stale"), undefined, 2500);
      setTimeout(() => { try { location.reload(); } catch (e) { /* headless/test env */ } }, 600);
    }
  } catch (e) {
    modelsDoc = modelsDoc || {selected: "", models: [], probe: null};   // old server: the chip stays hidden
  }
  paintModelChip();
  autoAlignSelected();
  if (typeof renderInspector === "function") renderInspector();  // repaint panel now that modelsDoc is live (metrics/poll path is dead under custom mode)
  return modelsDoc;
}
// The engine can neither announce that it started nor that its window was closed, so the dot has to
// look for itself. A click used to be the ONLY thing that refreshed it - which meant a status light
// you had to poke to make honest. This poll is what turns it into a light that simply tells the truth.
async function pollModels() {
  if (polling || document.visibilityState === "hidden") return;   // a hidden tab has nobody to inform
  polling = true;
  try {
    await loadModels();
    const pop = $("model-pop");
    // Keep an OPEN list live too - but never rebuild it under a hovering pointer (it would kill
    // the highlight every tick). `:hover` is not supported everywhere, hence the guard.
    let hovering = false;
    try { hovering = !!pop && pop.matches(":hover"); } catch (e) { hovering = false; }
    if (pop && !pop.hidden && !hovering) renderModelPop();
  } catch (e) {
    /* keep the last known state; the next tick retries */
  } finally {
    polling = false;
  }
}
// iq3-s and iq3-xxs share one GPU and one 8080, so only the running engine knows which weights are
// live. If the engine is actually serving a model different from what the UI has selected, follow the
// engine automatically — no manual click needed. We only pull OFF a local selection (never a cloud one),
// and only when there is a single local entry the engine clearly holds (its dot is "on").
let alignAt = 0;                   // last automatic alignment (ms): a failing POST retries at most every 15s
let manualAt = 0;                  // last HUMAN pick (ms): outranks the poll for a minute (see below)
function autoAlignSelected() {
  if (!modelsDoc || !Array.isArray(modelsDoc.models)) return;
  const cur = modelsDoc.models.find((m) => m.id === modelsDoc.selected);
  if (cur && modelDot(cur) === "on") { alignAt = 0; return; }  // already on the live model — nothing to do
  if (cur && cur.kind !== "local") return;                    // don't yank a cloud selection onto a local engine
  // A self-refreshing light must not fight the hand that just moved it: picking the other engine
  // is how you pre-select a model you are about to start, and the 4s poll would otherwise undo it
  // before the engine even came up. One minute of immunity, then the engine wins again.
  if (Date.now() - manualAt < 60000) return;
  const live = modelsDoc.models.find((m) => m.kind === "local" && modelDot(m) === "on");
  if (!live || live.id === modelsDoc.selected) return;
  const now = Date.now();
  if (now - alignAt < 15000) return;                          // don't hammer a POST that is failing
  alignAt = now;
  selectModel(live.id, true).then((ok) => {
    if (ok) alignAt = 0;                                      // success: the next change may follow at once
    if (!$("model-pop").hidden) renderModelPop();
  });
}
function currentModel() {
  const d = modelsDoc;
  return (d && d.models && (d.models.find((m) => m.id === d.selected) || d.models[0])) || null;
}
function requestModel() {                                   // what the request names (the server routes on it)
  const m = currentModel();
  return (m && m.id) || health.model;
}
const THINK_ORDER = ["off", "low", "medium", "high"];
const THINK_AUTO = "auto";                  // 跟随模型: send NO reasoning_effort, let the engine choose
// Explicit levels carry a reasoning_budget_tokens CAP so the user actually controls how LONG the
// model may think. 跟随模型 (auto) sends NEITHER effort NOR budget and lets the engine decide
// (its default is xhigh, uncapped) — that is the honest meaning of "follow the model". The engine
// treats reasoning_budget_tokens=0 / absent as "unlimited", so omitting it == uncapped.
const THINK_BUDGET = { low: 1024, medium: 4096, high: 32768 };
function normThink(v) {                     // legacy: the old Off button wrote "none"
  const x = String(v || "").trim().toLowerCase();
  if (x === "none") return "off";
  return (x === THINK_AUTO || THINK_ORDER.includes(x)) ? x : "";   // anything unknown = unset
}
// Budget cap attached to an explicit level (null for auto / off). Pure, so it is unit-testable
// without the whole composer state. This is the knob the old "长度" wording was missing: effort
// (off/low/medium/high) picks the *mode*, this caps the *length*.
function thinkingBudget(level) {
  const lv = normThink(level);
  return (lv && THINK_BUDGET[lv]) || null;
}
// PER-TASK first: the active task's own level wins, so switching tasks switches thinking with it.
// Then the global sampling default, then "high" (what an untouched install always did).
function sessionThink(s) {
  return normThink((s && s.thinking) || settings.thinking) || "high";
}
// What to send upstream -> a level string, or null (= follow the model; omit the key entirely).
function modelThinking() {
  const m = currentModel();
  const modes = (m && Array.isArray(m.think_modes) && m.think_modes.length) ? m.think_modes : THINK_ORDER;
  let want = sessionThink(activeSession());
  if (want === THINK_AUTO) {
    const pinned = normThink(m && m.think_default);
    if (!pinned || pinned === THINK_AUTO) return null;   // nothing declared -> truly follow the model
    want = pinned;
  }
  if (modes.includes(want)) return want;
  // An unsupported level is clamped DOWN to the closest one this model does offer - never sent raw,
  // because the endpoint would ignore it (or 400: it validates the value).
  const i = Math.max(0, THINK_ORDER.indexOf(want));
  return THINK_ORDER.slice(0, i + 1).reverse().find((x) => modes.includes(x)) || modes[0];
}
// Drawer readout. 跟随模型 also NAMES what it currently resolves to -- an "auto" that shows nothing
// is indistinguishable from a bug, so this is the one place we make the resolution visible.
function thinkOutput(v) {
  const x = normThink(v);
  if (!x) return "";                 // never echo a raw i18n key back to the user
  if (x !== THINK_AUTO) return t("drawer.thinking.out." + x);
  const pinned = normThink(currentModel() && currentModel().think_default);
  if (!pinned || pinned === THINK_AUTO) return t("drawer.thinking.out.auto.free");
  // short name keeps this readable: "跟随模型（模型指定：高）", not a nested description
  return t("drawer.thinking.out.auto.pinned", {level: t("drawer.thinking.short." + pinned)});
}
// Images: a custom entry must say it takes them; this instance answers for itself via /health.
function modelAcceptsImages() {
  const m = currentModel();
  if (!m) return health.images !== false;
  if (m.kind === "local" && !m.base_url) return health.images !== false;
  return m.vision !== false;
}
function paintModelChip() {
  const btn = $("model-btn"), name = $("model-name");
  if (!btn || !name) return;
  const m = currentModel();
  btn.hidden = !m;
  if (!m) return;
  name.textContent = m.name || m.model || m.id;
  btn.title = t("model.current") + " · " + name.textContent;
  btn.dataset.kind = m.kind || "custom";
  btn.dataset.local = (m.kind === "local" && !m.base_url) ? "1" : "0";
  const dot = modelDot(m);
  btn.dataset.dot = dot;
  btn.title = t("model.current") + " · " + name.textContent + "\n" + dotHint(dot);
}
// Endpoint liveness the server probed for each entry (null = this server does not report it,
// e.g. an older build or the Strata proxy — then we say nothing rather than guess).
function modelOnline(m) {
  const p = modelsDoc && modelsDoc.probe && modelsDoc.probe[m.id];
  return p && typeof p.ok === "boolean" ? p.ok : null;
}
// Two endpoints "are the same" once scheme, trailing slash and the /v1 suffix are ignored:
// config/models.json says "http://127.0.0.1:8080" while the gateway's upstream is ".../v1".
function endpointKey(u) {
  return String(u || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").replace(/\/+$/, "").replace(/\/v1$/, "");
}
// The dot answers exactly one question: would a message sent right now actually reach this model?
//   on        endpoint answers AND the engine names this very model   -> green
//   mismatch  endpoint answers but the engine holds its sibling       -> amber
//   off       nothing accepts a connection there                     -> hollow ring
//   na        this server reports no probe (old build / proxy mode)   -> dimmed, no claim
// "mismatch" exists because iq3-s and iq3-xxs share one GPU and one 8080: the port being
// alive says nothing about *which* weights are loaded.
function modelDot(m) {
  const on = modelOnline(m);
  if (on === null) return "na";
  if (!on) return "off";
  const e = (modelsDoc && modelsDoc.probe && modelsDoc.probe.__engine__) || null;
  if (!e || !e.loaded) return "on";                 // it answers but will not name itself
  const url = String(m.base_url || "").trim();
  // A local entry with no base_url is served by THIS gateway's own upstream, which IS the probed
  // engine — so it can never be a "sibling instance". Compare by model name, not by endpoint.
  if (!url) {
    return String(m.model || "").trim().toLowerCase() === String(e.loaded).trim().toLowerCase() ? "on" : "mismatch";
  }
  // A local entry pointing at an explicit base_url: green only when that base_url is the engine
  // AND the engine names this exact model; same port but a sibling weight => amber (mismatch).
  if (endpointKey(url) !== endpointKey(e.url)) return "on";   // genuinely a different instance
  const want = String(m.model || "").trim();
  if (!want) return "on";
  return want.toLowerCase() === String(e.loaded).trim().toLowerCase() ? "on" : "mismatch";
}
function engineLoaded() {
  const e = (modelsDoc && modelsDoc.probe && modelsDoc.probe.__engine__) || null;
  return (e && e.loaded) || "";
}
function dotHint(dot) {
  if (dot === "mismatch") {
    const e = modelsDoc && modelsDoc.probe && modelsDoc.probe.__engine__;
    return t("model.dot.mismatch", {model: (e && e.loaded) || "?"});
  }
  return t("model.dot." + (dot || "na"));
}
function modelSub(m) {
  if (m.kind === "local") {
    const on = modelOnline(m);
    if (!m.base_url) {
      if (modelDot(m) === "mismatch") return t("model.sub.self.mismatch", {model: engineLoaded()});
      if (on === true) return t("model.sub.self");
      if (on === false) return t("model.sub.self.down");
      return t("model.sub.self.na");
    }
    const base = m.base_url.replace(/^https?:\/\//, "");
    return on === false ? base + " · " + t("model.sub.down") : base;
  }
  return (m.base_url || "").replace(/^https?:\/\//, "") + (m.model ? " · " + m.model : "");
}
function renderModelPop() {
  const pop = $("model-pop");
  if (!pop) return;
  const d = modelsDoc || {selected: "", models: []};
  const row = (m) => `<button type="button" role="menuitem" class="model-pop__item${m.id === d.selected ? " is-on" : ""}" data-model="${esc(m.id)}">` +
    `<span class="model-pop__grip"></span><span class="model-pop__text">` +
    `<span class="model-pop__name">${esc(m.name || m.model || m.id)}</span>` +
    `<span class="model-pop__sub">${esc(modelSub(m))}</span></span><span class="model-pop__tick"></span></button>`;
  const locals = d.models.filter((m) => m.kind === "local");
  const customs = d.models.filter((m) => m.kind === "custom");
  // s and xxs share one engine, so the list must say which model the engine actually holds —
  // otherwise an entry looks ready while the GPU is serving its sibling.
  const engine = d.probe && d.probe.__engine__;
  const loaded = (engine && engine.loaded) ? String(engine.loaded) : "";
  const localHead = locals.length
    ? `<div class="model-pop__group">${esc(t("model.group.local"))}` +
      `${loaded ? " · " + esc(t("model.group.loaded", {model: loaded})) : ""}</div>`
    : "";
  pop.innerHTML =
    (locals.length ? localHead + locals.map(row).join("") : "") +
    (customs.length ? `<div class="model-pop__group">${esc(t("model.group.custom"))}</div>` + customs.map(row).join("") : "") +
    (!d.models.length ? `<div class="model-pop__group">${esc(t("model.empty"))}</div>` : "") +
    `<div class="model-pop__sep"></div>` +
    `<button type="button" class="model-pop__act" data-act="add">+ ${esc(t("model.add"))}</button>` +
    `<button type="button" class="model-pop__act" data-act="manage">${esc(t("model.manage.short"))}</button>`;
}
function openModelPop() {
  const pop = $("model-pop"), btn = $("model-btn");
  if (!pop || !btn || !modelsDoc) return;
  renderModelPop();
  pop.hidden = false;
  btn.setAttribute("aria-expanded", "true");
  // Repaint once the server re-probes the endpoints: a model must not keep reading "online"
  // just because the page was loaded before its engine was closed.
  loadModels().then(() => { if (!pop.hidden) renderModelPop(); }).catch(() => {});
}
function closeModelPop() {
  const pop = $("model-pop"), btn = $("model-btn");
  if (pop) pop.hidden = true;
  if (btn) btn.setAttribute("aria-expanded", "false");
}
async function saveModels(patch) {
  const body = {selected: patch.selected !== undefined ? patch.selected : (modelsDoc ? modelsDoc.selected : ""),
                models: patch.models || (modelsDoc ? modelsDoc.models : [])};
  const before = modelsDoc;
  const r = await fetchWithRetry("models/config", {method: "POST", headers: headers(true), body: JSON.stringify(body)});
  if (!r.ok) throw new Error("HTTP " + r.status);
  modelsDoc = await r.json();
  // An older server answers a write without `probe`; replacing the doc wholesale would blank the
  // liveness we already knew (the dot would read "unknown" until the next poll). Keep the last
  // known probe in that case — a stale-for-a-second dot beats a dot that lies by omission.
  if (before && before.probe && !modelsDoc.probe) modelsDoc = {...modelsDoc, probe: before.probe};
  paintModelChip();
  return modelsDoc;
}
// `silent` = an automatic alignment driven by the liveness poll: it must never toast, or a
// transient POST failure would repeat the same red banner every few seconds.
async function selectModel(id, silent) {
  if (!modelsDoc || modelsDoc.selected === id) return false;
  const m = modelsDoc.models.find((x) => x.id === id);
  if (!silent) manualAt = Date.now();          // a deliberate pick: see autoAlignSelected's 60s grace
  try {
    await saveModels({selected: id});
    if (!silent) toast("success", t("model.switched", {name: (m && (m.name || m.model)) || id}));
    return true;
  } catch (e) {
    if (!silent) toast("error", t("model.save.failed"), String((e && e.message) || e));
    return false;
  }
}
function renderModelList() {
  const box = $("model-list");
  if (!box) return;
  const d = modelsDoc || {selected: "", models: []};
  box.innerHTML = d.models.map((m) => `<div class="model-item${m.id === d.selected ? " is-on" : ""}" data-id="${esc(m.id)}">` +
      `<span class="model-pop__grip"></span><span class="model-pop__text">` +
      `<span class="model-pop__name">${esc(m.name || m.model || m.id)}</span>` +
      `<span class="model-pop__sub">${esc(modelSub(m))}${m.api_key_set ? " · " + esc(t("model.key.saved")) : ""}</span></span>` +
      `<button type="button" class="st-btn st-btn--secondary" data-mact="edit">${esc(t("model.edit"))}</button>` +
      `<button type="button" class="st-btn st-btn--secondary" data-mact="del">${esc(t("model.delete"))}</button></div>`).join("") ||
    `<p class="muted small">${esc(t("model.empty"))}</p>`;
}
function openModelModal(mode, id) {
  if (!$("model-modal")) return;
  $("model-modal").hidden = false;
  $("model-form").hidden = true;
  $("model-list").hidden = false;
  $("model-add").hidden = false;
  $("model-done").hidden = false;
  renderModelList();
  if (mode === "add") openModelForm(null);
  else if (mode === "edit") openModelForm(id);
}
function closeModelModal() { if ($("model-modal")) $("model-modal").hidden = true; }
// A local entry is a Strata instance on this PC: it has no external address at all ("" = the instance that
// is serving this page), so the URL rule and the fields it needs are NOT the ones an external endpoint needs.
function syncModelFormKind() {
  const local = $("mf-kind").value === "local";
  $("mf-url").placeholder = local ? t("model.f.url.local.ph") : t("model.f.url.ph");
  $("mf-key-field").hidden = local;              // no key: it is your own instance
  $("mf-tools-field").hidden = local;            // its MCP loop is its own; we never run tools for it
  if (local) $("mf-test-out").hidden = true;     // and there is nothing to probe when the address is empty
  // say what an empty context field means HERE: this instance knows its own window, a remote one does not
  const self = local && !$("mf-url").value.trim();
  const hint = $("mf-ctx-hint");
  if (hint) hint.textContent = (self && health.max_context)
    ? t("model.f.ctx.engine", {n: kfmt(health.max_context)}) : t("model.f.ctx.remote");
}
function openModelForm(id) {
  const m = id && modelsDoc ? modelsDoc.models.find((x) => x.id === id) : null;
  modelEditId = m ? m.id : null;
  const kind = m ? (m.kind || "local") : "custom";
  $("mf-kind").value = kind;
  $("mf-name").value = m ? (m.name || "") : "";
  $("mf-url").value = m ? (m.base_url || "") : (kind === "custom" ? "https://" : "");
  $("mf-key").value = "";
  $("mf-key").placeholder = m && m.api_key_set ? t("model.f.key.keep") : t("model.f.key.ph");
  $("mf-model").value = m ? (m.model || "") : "";
  $("mf-ctx-in").value = m && m.ctx_in ? m.ctx_in : "";
  $("mf-ctx-out").value = m && m.ctx_out ? m.ctx_out : "";
  $("mf-context-window").value = m && m.context_window ? m.context_window : "";
  $("mf-tools").checked = m ? m.tools !== false : true;
  $("mf-vision").checked = m ? m.vision !== false : true;   // a Strata endpoint with mmproj reads images
  const modes = (m && Array.isArray(m.think_modes) && m.think_modes.length)
    ? m.think_modes : ["off", "low", "medium", "high"];
  document.querySelectorAll(".mf-mode").forEach((c) => { c.checked = modes.includes(c.value); });
  $("mf-think").value = (m && m.think_default) || "auto";
  $("mf-test-out").hidden = true;
  syncModelFormKind();
  $("model-list").hidden = true;
  $("model-add").hidden = true;
  $("model-done").hidden = true;                            // the form has its own Save: no second primary
  $("model-form").hidden = false;
  $("mf-name").focus();
}
async function submitModelForm() {
  const kind = $("mf-kind").value === "local" ? "local" : "custom";
  const modes = [...document.querySelectorAll(".mf-mode")].filter((c) => c.checked).map((c) => c.value);
  const entry = {kind,
                 name: $("mf-name").value.trim(),
                 base_url: $("mf-url").value.trim().replace(/\/+$/, ""),
                 model: $("mf-model").value.trim(),
                 tools: $("mf-tools").checked,
                 vision: $("mf-vision").checked,
                 think_modes: modes,
                 think_default: $("mf-think").value,
                 ctx_in: $("mf-ctx-in").value.trim(),
                 ctx_out: $("mf-ctx-out").value.trim(),
                 context_window: $("mf-context-window").value.trim()};
  if (modelEditId) entry.id = modelEditId;
  const key = $("mf-key").value.trim();
  if (key) entry.api_key = key;                             // empty = keep the stored one
  if (!entry.name) { toast("warn", t("model.err.name")); return; }
  // a local instance may have NO address at all ("" = this one); an external endpoint must have one
  if (kind === "custom" && !/^https?:\/\//.test(entry.base_url)) { toast("warn", t("model.err.url")); return; }
  if (kind === "local" && entry.base_url && !/^https?:\/\//.test(entry.base_url)) {
    toast("warn", t("model.err.url.local")); return;
  }
  if (entry.think_default !== "auto" && !modes.includes(entry.think_default)) {
    toast("warn", t("model.err.think")); return;      // a default nobody supports would silently do nothing
  }
  const list = (modelsDoc ? modelsDoc.models : []).filter((m) => m.id !== modelEditId);
  list.push(entry);
  try {
    await saveModels({models: list});
    $("model-form").hidden = true;
    $("model-list").hidden = false;
    $("model-add").hidden = false;
    $("model-done").hidden = false;
    renderModelList();
    toast("success", t("model.saved"));
  } catch (e) {
    toast("error", t("model.save.failed"), String((e && e.message) || e));
  }
}
async function deleteModel(id) {
  if (!confirm(t("model.delete.confirm"))) return;
  try {
    await saveModels({models: (modelsDoc ? modelsDoc.models : []).filter((m) => m.id !== id)});
    renderModelList();
  } catch (e) {
    toast("error", t("model.save.failed"), String((e && e.message) || e));
  }
}
async function testModelForm() {
  const out = $("mf-test-out");
  out.hidden = false;
  out.dataset.state = "";
  if ($("mf-kind").value === "local" && !$("mf-url").value.trim()) {
    out.textContent = t("model.test.self");       // this PC: there is no endpoint to reach
    return;
  }
  out.textContent = t("model.f.testing");
  try {
    const r = await fetch("models/test", {method: "POST", headers: headers(true), body: JSON.stringify({
      id: modelEditId || undefined,
      base_url: $("mf-url").value.trim(),
      model: $("mf-model").value.trim(),
      api_key: $("mf-key").value.trim() || undefined})});
    const j = await r.json();
    out.textContent = (j.ok ? t("model.test.ok") : t("model.test.fail")) + (j.message ? " · " + j.message : "");
    out.dataset.state = j.ok ? "ok" : "err";
  } catch (e) {
    out.textContent = t("model.test.fail") + " · " + String((e && e.message) || e);
    out.dataset.state = "err";
  }
}
(function bindModelSwitcher() {
  if (!$("model-btn")) return;
  $("model-btn").onclick = (e) => { e.stopPropagation(); $("model-pop").hidden ? openModelPop() : closeModelPop(); };
  $("model-pop").onclick = (e) => {
    const item = e.target.closest("[data-model]");
    if (item) { closeModelPop(); selectModel(item.dataset.model); return; }
    const act = e.target.closest("[data-act]");
    if (act) { closeModelPop(); openModelModal(act.dataset.act === "add" ? "add" : "list"); }
  };
  document.addEventListener("click", (e) => {
    if (!$("model-pop").hidden && !e.target.closest("#model-pop") && !e.target.closest("#model-btn")) closeModelPop();
  });
  $("model-close").onclick = closeModelModal;
  $("model-done").onclick = closeModelModal;
  $("model-add").onclick = () => openModelForm(null);
  $("mf-kind").onchange = syncModelFormKind;
  $("mf-url").oninput = syncModelFormKind;         // the context hint depends on whether an address is set
  $("mf-save").onclick = submitModelForm;
  $("mf-cancel").onclick = () => {
    $("model-form").hidden = true;
    $("model-list").hidden = false;
    $("model-add").hidden = false;
    $("model-done").hidden = false;
  };
  $("mf-test").onclick = testModelForm;
  $("model-list").onclick = (e) => {
    const row = e.target.closest("[data-id]");
    const act = e.target.closest("[data-mact]");
    if (!row || !act) return;
    if (act.dataset.mact === "edit") openModelForm(row.dataset.id); else deleteModel(row.dataset.id);
  };
  $("model-modal").onclick = (e) => { if (e.target === $("model-modal")) closeModelModal(); };
  $("model-form").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); submitModelForm(); }
  });
  // Four seconds, not twenty: an engine that was just started or closed has to show up while the
  // human is still looking at the composer, without anyone clicking the chip to "refresh" it.
  // Cheap enough - the server caches its TCP + /v1/models probe for 3s and only visible tabs ask.
  setInterval(() => { pollModels(); refreshIdleTimeout(); }, POLL_MS);
  // Coming back to the tab must be instant rather than "up to one tick later".
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") { pollModels(); refreshIdleTimeout(); }
  });
  window.addEventListener("focus", () => { pollModels(); refreshIdleTimeout(); });
  loadHwChip();   // hardware chip: host core count is server-side, pull once at boot (low frequency)
})();
document.addEventListener("strata:langchange", () => {
  paintHwChip();                                   // labels/tooltip follow the language switch
  paintModelChip();
  if (!$("model-pop").hidden) renderModelPop();
  if (!$("model-modal").hidden) renderModelList();
});

// ── contenteditable text helpers ────────────────────────────
// Rebuild the text stream from the DOM, restoring [img:N] anchors from inline <img data-pid>
// nodes and keeping <br> as newlines (same newline semantics as innerText). Only used when the
// composer/modal body actually carries inline image nodes; otherwise ceText keeps innerText.
function ceTextFromDom(el) {
  let out = "";
  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.textContent; continue; }          // TEXT_NODE
      if (n.tagName === "BR") { out += "\n"; continue; }
      if (n.getAttribute && n.getAttribute("data-pid")) { out += " [img:" + n.getAttribute("data-pid") + "] "; for (const c of n.childNodes) { if (c.nodeType === 3) { out += c.textContent; continue; } if (c.tagName === "BUTTON" || c.tagName === "IMG") continue; walk(c); } continue; }   // atomic anchor: emit it, then KEEP any user text that landed inside the chip (a real-browser caret can drop inside an atomic chip); skip the hover button/icon so they do not pollute
      const block = /^(DIV|P|LI|BLOCKQUOTE|PRE|H[1-6])$/.test(n.tagName);
      walk(n);
      if (block) out += "\n";
    }
  };
  walk(el);
  return out;
}
function ceText(el) {
  if (!el) return "";
  // A body that carries inline image nodes is rebuilt from the DOM so the [img:N] anchors that
  // mixedSegments/serialize depend on are restored, even though the visible DOM is now a real <img>.
  if (el.querySelector && el.querySelector("[data-pid]")) {
    return ceTextFromDom(el).replace(/\u200B/g, "").trim();
  }
  // innerText is the browser-authoritative read (keeps <br> as newlines); jsdom does not
  // implement it, so fall back to textContent and let the gates exercise this for real.
  return (el.innerText || el.textContent || "").replace(/\u200B/g, "").trim();
}
function ceSetText(el, txt) {
  if (!el) return;
  el.textContent = txt;
  autosize(el);
}
// Render a text+images message into a contenteditable body the way the composer will look after a
// paste: text runs as text nodes, each image as an inline thumbnail that carries its data-pid anchor.
// mixedSegments drives the order; with no anchors it degrades to text + thumbs appended at the end,
// so an image loaded from storage (ref-only, no inline text anchor) is never silently dropped.
function ceSetRich(el, text, images) {
  if (!el) return;
  el.innerHTML = "";
  const list = (images || []).filter((a) => a && (a.url || a.ref));
  let segs = mixedSegments({ text: text || "", images: list });
  if (!segs && !list.length) { el.textContent = text || ""; autosize(el); return; }
  if (!segs) {
    // no inline anchors in the stored text: emit the whole text then every image, so nothing is lost.
    segs = [{ type: "text", text: text || "" }];
    for (const a of list) segs.push({ type: "image", url: a.ref || a.url, name: a.name, entry: a });
  }
  for (const s of segs) {
    if (s.type === "image") {
      const entry = list.find((a) => (a.ref || a.url) === s.url) || { url: s.url, name: s.name };
      el.appendChild(makeInlineThumb(entry, el));
    } else if (s.text) {
      el.appendChild(document.createTextNode(s.text));
    }
  }
  autosize(el);
}

function isCE(el) {
  return !!(el && (el.isContentEditable || el.getAttribute("contenteditable") === "true"));
}

async function send(human = true) {
  if (busy) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }   // the composer guard now speaks up, like the other 6 guards
  if (chunkedCompacting) return;   // chunked pre-compaction owns the transcript while it folds (kept silent: the auto path must not spam)
  if (human) { autoDriveDepth = 0; autoDriveAbort = false; showAutoDrivePill(false); autoResumeChain = 0; emptyRoundChain = 0; }  // a human turn starts a fresh chain on every lane
  if (pendingPastes.size) await Promise.allSettled(pendingPastes);   // 2026-11: a paste still landing (DOM+array) must not read as empty here
  let text = ceText($("input"));
  reconcileArray($("input"));   // 方案1: the array is the source of truth for sending -- drop any chip the DOM no longer shows (browser-native Backspace bypasses our handler)
  // A chip selection on the newest answer plus whatever was typed in the composer go out TOGETHER as one
  // message (Enter included): "按建议做，另外再顺手把字体调大" in a single turn.
  if (!pendingCompact) {
    const lastA = [...messages].reverse().find((mm) => mm.role === "assistant");
    if (lastA && lastA.selSteps && lastA.selSteps.length) {
      const composed = composeStepsMessage(lastA.steps, [...lastA.selSteps].sort((a, b) => a - b), text);
      if (composed) text = composed;
      lastA.selSteps = [];
      const host = $("chat").querySelector(`.st-msg[data-i="${messages.indexOf(lastA)}"]`);
      if (host) renderNextSteps(host, lastA);
    }
  }
  if ((!text && !attachments.length) || busy) return;
  if (attachments.some((a) => a.kind !== "file") && !modelAcceptsImages()) {
    toast("warn", t("model.err.vision"));        // say so instead of sending an image it will drop
    return;
  }
  messages.push({role: "user", text, images: attachments.filter((a) => a.kind !== "file"),
                 files: attachments.filter((a) => a.kind === "file"), time: Date.now()});
  attachments = [];
  renderAttachments();
  ceSetText($("input"), "");
  await streamAssistant();
}

// A fresh seed for one turn, used when the drawer's field is left empty ("留空 = 随机"). crypto keeps
// it from being guessable and the range stays inside a positive int32 — the engine treats seed <= 0 as
// "unset" and would fall back to its own invisible random, which is the one case we must avoid here.
function pickSeed() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return 1 + (a[0] % 2147483646);
  } catch (e) {
    return 1 + Math.floor(Math.random() * 2147483646);
  }
}
// The last seed actually sent, mirrored to localStorage so the drawer can still answer "what did it
// use?" after a reload (the per-turn chips live in the saved chat, but the drawer line is global).
let lastSeedUsed = null, lastSeedPinned = false;
try {                                    // survives a reload: the drawer can still answer "what did it use?"
  const _ls = store.get("lastSeed", null);
  if (_ls && _ls.n) { lastSeedUsed = _ls.n; lastSeedPinned = !!_ls.pinned; }
} catch (e) { /* a corrupt entry just means no line */ }
function noteSeedUsed(seed, pinned) {
  lastSeedUsed = seed; lastSeedPinned = !!pinned;
  try { store.set("lastSeed", {n: seed, pinned: !!pinned, at: Date.now()}); } catch (e) { /* best effort */ }
  renderSeedNote();
}
function renderSeedNote() {
  const box = $("seed-note"), txt = $("seed-note-text"), lock = $("seed-lock");
  if (!box || !txt) return;
  if (lastSeedUsed == null) { box.hidden = true; return; }
  box.hidden = false;
  txt.textContent = t(lastSeedPinned ? "drawer.seed.last.pinned" : "drawer.seed.last", {n: lastSeedUsed});
  // "Pin" only means something while the field is empty: once the user has typed a seed there is
  // nothing to lock, and offering it again would look like the button did nothing.
  if (lock) lock.hidden = lastSeedPinned || String(settings.seed) === String(lastSeedUsed);
}

// Stream a fresh assistant reply for the LAST message in `messages` (which must already be a
// user message). Shared by send() (a new prompt) and doRegenerate() (re-answering a past user
// message), so the streaming / tool-call / finalize logic lives in exactly one place.
// ─────────────────────────────────────────────────────────────────────
// Step1-F · Streaming client-side exception capture
//
// streamAssistant's try/catch only sees the *surface* error of a failed
// fetch/read. Two whole classes of client failure are invisible to it:
//   (1) a throw inside the rAF paint (updateAssistant/scrollDown) or the 500 ms
//       live-timer (renderStats/renderInspector/tickToolTimers) — both run
//       OUTSIDE the try block, so a crash there freezes the UI silently while
//       tokens keep arriving;
//   (2) a client render bug that throws mid-loop and gets mislabelled as
//       "连接中断 / 请求失败" because the catch can't tell a transport drop
//       from a client crash.
// Global onerror / unhandledrejection hooks record, while a turn is live, the
// error with the chunk index + bytes received so far, attach it to the message,
// and expose a queryable object for the debug drawer (Step1-G) + tests.
// Zero backend change.
// ─────────────────────────────────────────────────────────────────────
const _dbg = {
  turn: null,            // the live message object
  chunkIndex: 0,         // SSE data events parsed this turn
  bytes: 0,              // total bytes received this turn
  errors: [],            // [{ts, phase, msg, stack, chunkIndex, bytes}]
  lastError: null,
  _lastTs: 0,
};
function _recordClientError(phase, err) {
  if (!_dbg.turn) { _recordBugCapture(phase, err); return; }  // off-turn: straight to the bug collection box
  const now = Date.now();
  const msg = err && err.message != null ? err.message : String(err);
  // de-dupe: the same throw can surface as both `error` and `unhandledrejection`
  if (_dbg.lastError && now - _dbg._lastTs < 60 && _dbg.lastError.msg === msg) return;
  const rec = {
    ts: now,
    phase,                                       // "window.onerror" | "unhandledrejection"
    msg,
    stack: err && err.stack ? err.stack : "",
    chunkIndex: _dbg.chunkIndex,
    bytes: _dbg.bytes,
  };
  _dbg.errors.push(rec);
  _dbg.lastError = rec;
  _dbg._lastTs = now;
  (_dbg.turn._clientErrors = _dbg.turn._clientErrors || []).push(rec);
}
// Off-turn exception collector: fires when an error arrives while NO stream is active.
// This is what makes 'a bug found during workspace development gets recorded' work -- the
// old guard dropped every off-turn exception. De-dupes, then feeds the SAME dual sink as
// the interruption log: localStorage mirror (strata.bugBox) + gateway JSONL (api/interrupt-log).
function _recordBugCapture(phase, err) {
  const now = Date.now();
  const msg = err && err.message != null ? err.message : String(err);
  const sig = msg;                                  // signature = error first-line (function/type encoded in it)
  if (_bugBox._lastTs && now - _bugBox._lastTs < 60 && _bugBox._lastMsg === msg) return;  // sub-60ms burst: drop silently
  try {
    const _box = Array.isArray(store.get(BUGBOX_KEY, [])) ? store.get(BUGBOX_KEY, []) : [];
    const _hit = _box.find((e) => (e.sig != null ? e.sig : e.msg) === sig);   // same signature already in the box?
    if (_hit) {
      _hit.sig = sig; _hit.count = (_hit.count || 1) + 1; _hit.lastSeen = now;
      store.set(BUGBOX_KEY, _box.slice(-BUGBOX_MAX));
      postQuiet("api/interrupt-log", { entry: Object.assign({}, _hit, { merged: true }) });
      _bugBox._lastTs = now; _bugBox._lastMsg = msg;
      return;                                                                       // merged into the existing row, not a new one
    }
  } catch (e) { /* localStorage read failed: fall through and record fresh */ }
  _bugBox._lastTs = now; _bugBox._lastMsg = msg;
  const rec = {
    ts: now,
    sig: sig,          // signature for same-root-cause merge
    count: 1,          // number of merged occurrences
    kind: 'bug:' + phase,                          // bug:window.onerror | bug:unhandledrejection
    status: 'open',                                // open->fixing->verified (audit lives in the JSONL append-only sink)
    origin: 'ui',                                  // ui = off-turn; stream errors stay on the message
    sourceTab: (typeof tab !== 'undefined' ? tab : null),
    session: (typeof activeId !== 'undefined' ? activeId : null),
    msg,
    stack: err && err.stack ? err.stack : '',
  };
  try {
    const box = store.get(BUGBOX_KEY, []);
    store.set(BUGBOX_KEY, (Array.isArray(box) ? box : []).concat([rec]).slice(-BUGBOX_MAX));
  } catch (e) { /* localStorage full: the gateway JSONL stays the authoritative sink */ }
  postQuiet('api/interrupt-log', { entry: rec });
}
// ── Bug collection box (memory layer read) ────────────────────────────────────
// Persists via the SAME dual sink _recordBugCapture writes (localStorage mirror strata.bugBox
// + gateway JSONL). UI reads the localStorage mirror (offline-capable leg); the file is the archive.
function bugBoxEntries() {
  const box = store.get(BUGBOX_KEY, []);
  return Array.isArray(box) ? box : [];
}
function bugBoxFindByTs(ts) {
  return bugBoxEntries().find((e) => String(e.ts) === String(ts)) || null;
}
function bugBoxSave(box) {
  store.set(BUGBOX_KEY, (Array.isArray(box) ? box : []).slice(-BUGBOX_MAX));
}
function bugCardDiagnose(e) {
  // Reflection-layer verdict reuses diagnoseStream front-end-error semantics: an off-turn
  // exception is a front-end code issue; phrased with the captured source tab.
  const head = t('debug.diag.client', { n: '-', bytes: '-', msg: e.msg || '', phase: e.kind || 'ui' });
  return head + " [" + t("debug.flag.source") + ": " + (e.sourceTab || "?") + "]";
}
function bugBoxSigKey(e) {          // signature = same key the capture uses for merge
  return (e && e.sig != null) ? e.sig : (e && e.msg != null ? e.msg : '');
}
function bugBoxStats(all) {         // counts over the FULL box (status field already on every record)
  const s = { total: all.length, open: 0, fixing: 0, verified: 0 };
  for (const e of all) {
    const st = (!e.status || e.status === 'open') ? 'open' : e.status;   // pre-status legacy rows count as open
    if (st in s) s[st] += 1;
  }
  return s;
}
function bugBoxGroups(entriesDesc) { // fold same-signature rows into one representative + count
  const order = []; const bySig = new Map();
  for (const e of entriesDesc) {
    const sig = bugBoxSigKey(e);
    let g = bySig.get(sig);
    if (!g) { g = { rep: e, count: 1, tsList: [e.ts] }; bySig.set(sig, g); order.push(g); }
    else {
      g.count += 1; g.tsList.push(e.ts);
      if (e.ts > g.rep.ts) g.rep = e;            // representative = newest occurrence
    }
  }
  return order;
}
function renderBugBox() {
  const box = $("bugbox-list"); if (!box) return;
  const all = bugBoxEntries();
  // stats hero — always rendered into #bugbox-hero (counts over the FULL box, not filtered)
  const hero = $("bugbox-hero");
  if (hero) {
    if (!all.length) { hero.innerHTML = ''; }
    else {
      const st = bugBoxStats(all);
      const stat = (label, n, color) => '<span class="muted small">' + esc(label) + ' <b style="color:' + color + ';font-weight:700">' + n + '</b></span>';
      hero.innerHTML = '<div class="bugbox-stats" style="display:flex;gap:16px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--st-border);border-radius:8px">'
        + stat(t("debug.bugbox.stats.total"), st.total, "var(--st-text)")
        + stat(t("debug.bugbox.stats.open"), st.open, "var(--st-accent-text)")
        + stat(t("debug.bugbox.stats.fixing"), st.fixing, "var(--st-warn)")
        + stat(t("debug.bugbox.stats.verified"), st.verified, "var(--st-accent-text)") + '</div>';
    }
  }
  if (!all.length) { box.innerHTML = '<p class="muted small">' + esc(t("debug.bugbox.empty")) + '</p>'; return; }
  // search/filter
  const q = ($("bugbox-search") ? $("bugbox-search").value : "").trim().toLowerCase();
  const ft = $("bugbox-filter") ? $("bugbox-filter").value : "";
  let filtered = all;
  if (q || ft) {
    filtered = all.filter((e) => {
      if (ft) { const st = (!e.status || e.status === 'open') ? 'open' : e.status; if (st !== ft) return false; }
      if (q) { const msg = (e.msg || '').toLowerCase(); if (!msg.includes(q)) return false; }
      return true;
    });
  }
  if (!filtered.length) { box.innerHTML = '<p class="muted small">' + esc(t("debug.bugbox.empty")) + '</p>'; return; }
  // group by signature
  const groups = bugBoxGroups(filtered.slice().reverse());
  if (!groups.length) { box.innerHTML = '<p class="muted small">' + esc(t("debug.bugbox.empty")) + '</p>'; return; }
  const shown = groups.length > BUGBOX_SHOW_LIMIT ? groups.slice(0, BUGBOX_SHOW_LIMIT) : groups;
  box.innerHTML = shown.map((g) => {
    const e = g.rep;
    const collapsed = bugBoxExpanded.has(String(e.ts)) ? "" : " is-collapsed";
    const when = new Date(e.ts).toLocaleTimeString();
    const tsAttr = esc(String(e.ts));
    const vTxt = e.verdict ? '<div class="debug-bug__verdict">' + esc(t("debug.verdict")) + ': ' + esc(e.verdict) + '</div>' : '';
    const statusBadge = (e.status && e.status !== "open")
      ? '<span class="badge badge--ws badge--status">' + esc(t("debug.bugbox.status." + e.status) || e.status) + '</span>'
      : '';
    const dupBadge = g.count > 1 ? '<span class="badge" style="color:var(--st-warn);border-color:var(--st-warn)">\u00d7' + g.count + '</span>' : '';
    return '<div class="debug-item debug-item--bug' + collapsed + '" data-bugtoggle="' + tsAttr + '">'
      + '<div class="debug-item__head"><span class="badge badge--ws">' + esc(t("debug.bugbox.tag")) + '</span>' + statusBadge + dupBadge
      + '<span>' + esc(e.kind || "") + '</span><span class="muted small">' + esc(e.sourceTab || "?") + ' \u00b7 ' + esc(when) + '</span></div>'
      + '<div class="debug-err"><div class="debug-err__msg">' + ((e.kind==="bug:manual" && e.msgHtml) ? e.msgHtml : esc(e.msg || "")) + '</div>'
      + '<pre class="debug-err__stack">' + esc(e.stack || "") + '</pre></div>'
      + vTxt
      + '<div class="debug-bug__acts">'
        + '<button type="button" class="st-btn st-btn--secondary st-btn--sm" data-bugact="copy" data-bugts="' + tsAttr + '">' + esc(t("debug.copy")) + '</button>'
        + '<button type="button" class="st-btn st-btn--secondary st-btn--sm" data-bugact="diagnose" data-bugts="' + tsAttr + '">' + esc(t("debug.bugbox.pf.diag")) + '</button>'
        + '<button type="button" class="st-btn st-btn--primary st-btn--sm" data-bugact="push" data-bugts="' + tsAttr + '">' + esc(t("debug.bugbox.push")) + '</button>'
        + '<button type="button" class="st-btn st-btn--secondary st-btn--sm" data-bugact="edit" data-bugts="' + tsAttr + '">' + esc(t("debug.bugbox.edit")) + '</button>'
        + '<button type="button" class="st-btn st-btn--ghost st-btn--sm" data-bugact="dismiss" data-bugts="' + tsAttr + '">' + esc(t("debug.bugbox.dismiss")) + '</button>'
      + '</div></div>';
  }).join("");
  if (groups.length > shown.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "st-btn st-btn--ghost st-btn--sm bugbox-loadmore";
    more.setAttribute("data-bugmore", "1");
    more.textContent = t("debug.bugbox.more", { n: groups.length - shown.length });
    box.appendChild(more);
  }
}
function bugBoxExpandAll(expand) {   // batch toggle for the bug-box (aligns memExpandAll); persisted 2026-10-30
  if (expand) {
    const list = $("bugbox-list");
    if (list) list.querySelectorAll("[data-bugtoggle]").forEach((row) => bugBoxExpanded.add(row.getAttribute("data-bugtoggle")));
  } else {
    bugBoxExpanded.clear();
  }
  expandSetSave('strata.bugBoxExpanded', bugBoxExpanded);
  renderBugBox();
}

async function copyBugEvidence(ts) {
  const e = bugBoxFindByTs(ts); if (!e) return;
  const ev = ["=== BUG ===", "time: " + new Date(e.ts).toISOString(),
    "tab: " + (e.sourceTab || "?"), "kind: " + (e.kind || ""),
    "msg: " + (e.msg || ""), "stack:\n" + (e.stack || ""),
    e.verdict ? ("diagnosis: " + e.verdict) : ""].join("\n");
  await copyText(ev);   // reuse the app-wide clipboard helper
}
function diagnoseBugCard(ts) {
  const box = bugBoxEntries(); const e = box.find((x) => String(x.ts) === String(ts)); if (!e) return;
  e.verdict = bugCardDiagnose(e);            // persist the verdict ON the record -> survives reload
  bugBoxSave(box);
  postQuiet("api/interrupt-log", { entry: e });   // keep the gateway JSONL leg in sync
  renderBugBox();
}
function dismissBug(ts) {
  const box = bugBoxEntries().filter((x) => String(x.ts) !== String(ts));
  bugBoxSave(box);   // drop from the box; the gateway file stays an append-only audit log
  renderBugBox();
}

// -- self-evolving fix loop: state transitions the UI + agent drive --------------------
function setBugStatus(ts, status) {
  const box = bugBoxEntries();
  const e = box.find((x) => String(x.ts) === String(ts));
  if (!e) return false;
  e.status = status;
  bugBoxSave(box);
  postQuiet("api/interrupt-log", { entry: e });   // keep the gateway JSONL leg in sync
  renderBugBox();
  return true;
}
// verified = repro + gate both green (asserted from outside). A VERIFIED bug leaves the box;
// its audit stays in the append-only JSONL. open/fixing rows remain visible until verified.
function markBugVerified(ts) {
  const box = bugBoxEntries();
  const e = box.find((x) => String(x.ts) === String(ts));
  if (!e) return false;
  e.status = "verified";
  postQuiet("api/interrupt-log", { entry: e });   // audit: append the verified state before removal
  bugBoxSave(box.filter((x) => String(x.ts) !== String(ts)));   // verified -> leave the box
  renderBugBox();
  return true;
}
// idle driver: opt-in, at most ONE fix per idle, take the OLDEST open bug, mark fixing at once
// (so it can't be re-picked / feed back into itself).
function autofixTick() {
  if (!settings.autofix) return;
  if (busy) return;                                 // another task already owns the idle slot
  const open = bugBoxEntries().filter((x) => !x.status || x.status === "open").sort((a, b) => a.ts - b.ts);
  if (!open.length) return;
  pushBugFix(String(open[0].ts));
}
// Layer 4 PUSH-FIX: reuses the continueTask mechanism (fill input + send). When a stream is busy
// the button queues (idle-only), so it never interrupts a live task.
function pushBugFix(ts) {
  const e = bugBoxFindByTs(ts); if (!e) return;
  if (busy) { toast("warn", t("debug.bugbox.push"), t("debug.bugbox.busy"), 4000); return; }
  const when = new Date(e.ts).toLocaleString();
  const prompt = [
    t("debug.bugbox.pushprompt"),
    "- " + t("debug.bugbox.pf.tab") + ": " + (e.sourceTab || "?"),
    "- " + t("debug.bugbox.pf.time") + ": " + when,
    "- " + t("debug.bugbox.pf.kind") + ": " + (e.kind || ""),
    "- " + t("debug.bugbox.pf.msg") + ": " + (e.msg || ""),
    "- " + t("debug.bugbox.pf.stack") + ":",
    (e.stack || "(no stack)"),
    e.verdict ? ("- " + t("debug.bugbox.pf.diag") + ": " + e.verdict) : ""
  ].filter(Boolean).join("\n");
  setBugStatus(e.ts, "fixing");   // push = fix task in flight: mark fixing so the idle loop won't re-pick it
  ceSetText($("input"), prompt);
  send();
}


window.addEventListener("error", (ev) => _recordClientError("window.onerror", ev.error || ev));
window.addEventListener("unhandledrejection", (ev) => _recordClientError("unhandledrejection", ev.reason));
// Public, testable hook for the debug drawer + regression tests.
window.__strataDebug = {
  get current() { return _dbg.turn ? {chunkIndex: _dbg.chunkIndex, bytes: _dbg.bytes, errors: _dbg.errors.slice()} : null; },
  errorsFor(m) { return (m && m._clientErrors) ? m._clientErrors.slice() : []; },
  last() { return _dbg.lastError; },
  reset() { _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0; },
  setBugStatus(ts, status) { return setBugStatus(ts, status); },
  markBugVerified(ts) { return markBugVerified(ts); },
};

async function streamAssistant() {
  const m = {role: "assistant", text: "", reasoning: "", time: Date.now()};
  if (resumeBadge) { m.autoResume = true; m.meta = resumeBadge; resumeBadge = null; }   // this turn is the auto-resume, not human input
  messages.push(m);
  renderChat();
  const el = $("chat").lastElementChild;
  const controller = new AbortController();
  // A unique id for this stream: sent to the gateway so the Stop button can address it via
  // /api/chat/stop and truly cancel inference on the backend (not just abort the browser fetch).
  const stopId = "s" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  busy = {controller, msg: m, stopId, sessionId: activeId, origin: activeSession()};   // tail write-back is attributed to the session that started the stream
  // Step1-F: arm the per-turn capture buffer so a client crash during this
  // stream is recorded with how far we got (which chunk / how many bytes).
  _dbg.turn = m; _dbg.chunkIndex = 0; _dbg.bytes = 0; _dbg.errors = []; _dbg.lastError = null; _dbg._lastTs = 0;
  m._clientErrors = [];
  setBusy(true);
  streamingFollow = true;
  renderSessions();   // sidebar badge: light the row of the session that is running                  // every new turn starts by following the live tail
  const latestBtn = $("scroll-latest"); if (latestBtn) latestBtn.hidden = true;

  // F3: on-demand knowledge recall — only when enabled, the query looks substantive, and the KB has hits.
  lastRag = "";
  const uq = recallQuery();
  if (settings.recall && mcpInfo.tools && uq && uq.length >= 4 && !uq.startsWith("/")) {
    try { const hit = await recallKnowledge(uq); if (hit) lastRag = hit; } catch (e) { /* non-fatal */ }
  }

  const body = {model: requestModel(), messages: apiMessages(), stream: true};
  const _te = modelThinking();
  if (_te) {
    body.reasoning_effort = _te;             // explicit level (off/low/medium/high)
    // 思考预算：显式数值框(settings.thinkBudget)优先，否则跟随档位(thinkingBudget)。
    const _tb = (settings.thinkBudget && +settings.thinkBudget > 0) ? +settings.thinkBudget : thinkingBudget(_te);
    if (_tb) body.reasoning_budget_tokens = _tb;
  }
  // 方案A增强：正文保底额度随请求发出(后端 compute_output_cap 据此给正文留独立预算)。
  if (settings.answerFloor && +settings.answerFloor > 0) body.answer_floor_tokens = +settings.answerFloor;
  // auto (跟随模型): omit BOTH -> the engine's own default (currently xhigh, uncapped)
  if (settings.temperature > 0) {
    Object.assign(body, {temperature: +settings.temperature, top_p: +settings.top_p, top_k: +settings.top_k});
  } else {
    body.temperature = 0;
  }
  // Seed: an EMPTY field means "random", so the random number is drawn HERE, in the client — the
  // sender is the only party that can know what was used. The engine invents its own seed when a
  // request omits one and never reports it back (`serve/server.py` only forwards `seed=N` to the
  // sampler, for a positive seed; nothing in the reply echoes it). Measured against 8080: same seed
  // + same context state -> byte-identical answer, different seeds -> different answers. So the
  // number this turn shows in its footer is exactly the number to type back to replay it.
  // Cost: none. The engine's prefix cache is keyed by prompt ids; sampling keys only ride the GEN
  // line (server.py: `sampling_keys`), so a fresh seed per turn does not lose prompt reuse.
  const seedPinned = !!settings.seed;
  const turnSeed = seedPinned ? +settings.seed : pickSeed();
  body.seed = turnSeed;
  m.seed = turnSeed;                    // footer chip + saved session (m.stats.seed)
  m.seedPinned = seedPinned;
  noteSeedUsed(turnSeed, seedPinned);   // the drawer's "this turn" line updates at send, not at the end
  if (settings.max) body.max_tokens = +settings.max;
  if (settings.maxCeiling) body.max_ceiling = +settings.maxCeiling;
  if (projectionLoaded()) body.experimental_speed_projection = !!settings.esp;
  if (settings.mcp !== false && mcpInfo.tools > 0) body.strata_mcp = true;   // this server may run MCP tools for it
  body.stop_id = stopId;                       // lets the gateway cancel this exact stream on Stop
  body.strata_session = activeId;              // per-conversation context tracking: keeps the gateway's
                                               // proactive guard from leaking a previous task's occupancy
                                               // into a brand-new (empty) workspace/task
  const _ws = (activeSession() || {}).workspace;
  if (_ws) body.strata_workspace = _ws;
  // Mark a compaction turn so the gateway's proactive context guard lets it through (the whole point
  // of a compact is to escape an overflowing context, so blocking it there would wedge the chat
  // permanently -- see reset_prompt_tokens / the _is_compact guard in http_server.py).
  if (pendingCompact) {
    body.strata_compact = true;
    // #compactthink: the post-fold single-shot is the SAME pure-summarise task as the
    // chunked fold (capped in llmSummarize). A long thinking chain here is what produced
    // the thinking-only empty summary + 85-181s first token, so force the short level
    // (overrides the chat档位 set above at the body build).
    body.reasoning_effort = COMPACT_THINK_EFFORT;
    body.reasoning_budget_tokens = compactThinkBudget();
  }
  // Per-workspace approval tier: sent on every request so the server can gate tool calls.
  // Missing on a session -> "full" (preserves the old autonomous behaviour for pre-existing tasks).
  const _perm = sessionPerm(activeSession() || {});
  if (_perm !== "full") body.strata_permission = _perm;   // full is the server default; omit to keep payload small

  // `usage` is the NEWEST upstream usage chunk (prompt side of the window); the two sums below
  // accumulate the whole agent turn, because a multi-round turn (tool call -> answer -> tool call)
  // reports one usage chunk per round and only the last one used to survive (2026-10-19).
  let firstAt = null, thinkStart = null, usage = null, frame = 0;
  let sawUsage = false, sumCompletion = 0, sumReasoning = 0, turnReasoning = null;
  let sawDone = false;                // the gateway closes every healthy turn with [DONE]; missing = cut off
  let finishReason = null;              // last non-null choices[0].finish_reason this turn ("length" = output budget ran dry mid-turn)
  let rawContent = "";                   // Step4-E: exact concatenation of content deltas (raw model output)
  const t0 = performance.now();          // request start: the basis for total task duration
  let genStart = null;                    // first *content* token (decode-speed base, excludes thinking/tool gaps)
  m.startAt = t0;                         // persisted so the footer can tick live and survive reloads
  m._lastActivityAt = Date.now();         // idle-watchdog clock for the running-tool timeout timer
  const paint = () => { frame = 0; const el = liveMsgEl(m); if (el) updateAssistant(el, m, true); if (busy.sessionId === activeId) scrollDown(); };
  // Live duration ticker: updates the footer clock every 500ms while this turn streams. The task panel is
  // repainted here too — its checklist is derived from the streaming text, so it must not wait for the
  // 1 Hz /metrics poll (and it used to wait for the end of the turn, which made it look frozen).
  const liveTimer = setInterval(() => {
    if (!(busy && busy.msg === m)) return;
    const el = liveMsgEl(m);          // null while viewing another session: DOM rows have no home
    if (el) renderStats(el, m, true);
    renderInspector();
    if (el) tickToolTimers(el, m);    // live "timeout-wait" countdown on running tool cards
    if (el && document.hidden) updateAssistant(el, m, true);   // A: rAF is PAUSED on a hidden page, so the live session's body text would freeze; this 500ms timer paints it. Visible state: no change.
    if (streamingFollow && busy.sessionId === activeId) scrollDown();
    if (tab === "debug") { renderDebug(); renderGatewayDebug(); renderBugBox(); }   // live capture view: the debug page (tab) is showing
  }, 500);
  try {
    const r = await fetchWithRetry("v1/chat/completions", {method: "POST", headers: headers(true), body: JSON.stringify(body),
                                                           signal: controller.signal}, {retries: 3, base: 800});
    const reader = r.body.getReader(), dec = new TextDecoder();  m._phase = "reading";   // 方案A：请求已发出、首token未到=读取中(估算态)
    let buf = "";
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buf += dec.decode(value, {stream: true});
      _dbg.bytes += value ? value.byteLength : 0;       // Step1-F: bytes received so far this turn
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;              // ": keep-alive" comments while a long prompt is read
        const data = line.slice(5).trim();
        _dbg.chunkIndex++;                                    // Step1-F: every SSE data event counts as a chunk
        // The terminal marker. The gateway writes the OpenAI-standard bare `data: [DONE]`, but it
        // used to write `data: "[DONE]"` (json.dumps of the string), which never matched here --
        // so EVERY healthy turn was flagged as "连接中断" and auto-resumed. Accept both forms:
        // a transport detail must never masquerade as a dropped connection.
        const marker = data.length > 2 && data.startsWith("\"") && data.endsWith("\"")
          ? data.slice(1, -1) : data;
        if (marker === "[DONE]") { sawDone = true; continue; }
        let j;
        try { j = JSON.parse(data); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || "the engine reported an error");
        // A recoverable stop (turn budget / idle watchdog / round cap). Deliberately NOT an
        // error: the work already streamed is kept and 继续 picks the task back up.
        if (j.strata_notice) {
          m.notice = j.strata_notice;
          // A notice may say "do not just retry" (e.g. two empty rounds in a row: the fix is a
          // setting change, not another identical attempt). Honour that flag instead of always
          // arming the Continue path.
          m.canContinue = j.strata_notice.resumable !== false;
        }
        if (j.usage) {
          usage = j.usage;
          sawUsage = true;
          if (usage.completion_tokens != null) sumCompletion += usage.completion_tokens;   // turn total
          lastPromptTokens = usage.prompt_tokens || lastPromptTokens;     // R5: live context fill
          const det = usage.prompt_tokens_details || {};
          lastCacheTokens = det.cached_tokens != null ? det.cached_tokens
            : (det.cache_read_input_tokens != null ? det.cache_read_input_tokens : lastCacheTokens);
          // D12: when the engine reports it, split reasoning tokens from content tokens so the
          // output-speed figure isn't inflated by reasoning tokens counted against generation time.
          const cd = usage.completion_tokens_details || {};
          // Turn-local on purpose: the old global leaked a previous turn's reasoning count into this
          // turn's content-token maths whenever the engine stopped reporting the split.
          if (cd.reasoning_tokens != null) { turnReasoning = cd.reasoning_tokens; sumReasoning += cd.reasoning_tokens; }
        }
        if (j.strata_mcp) { m._lastActivityAt = Date.now(); onTool(m, j.strata_mcp); }
        if (j.strata_approval) { onApproval(j.strata_approval); }
        const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
        if (fr) finishReason = fr;
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        const lastTool = m.tools && m.tools.length ? m.tools[m.tools.length - 1] : null;   // a new round after a tool
        if (d.reasoning_content) {
          if (!firstAt) firstAt = performance.now();
          if (!thinkStart) thinkStart = performance.now();
          if (lastTool && m.reasoning && lastTool.rat === m.reasoning.length) m.reasoning += "\n\n";
          m.reasoning += d.reasoning_content;
          bumpLiveSpeed(m, 1);               // real throughput: reasoning chunk counts in the shared curve
          m._lastActivityAt = Date.now();    // any token touches the idle watchdog
          noteStreamPhase(m, "thinking");
        }
        if (d.content) {
          if (!firstAt) firstAt = performance.now();
          if (!genStart) genStart = performance.now();
          if (thinkStart && m.thinkSecs == null) m.thinkSecs = (performance.now() - thinkStart) / 1000;
          if (lastTool && m.text && lastTool.at === m.text.length) m.text += "\n\n";
          m.text += d.content;
          rawContent += d.content;                // Step4-E: exact model output, before any render/post-processing
          bumpLiveSpeed(m, 1);                   // real throughput: content chunk feeds the SAME shared curve
          m._lastActivityAt = Date.now();        // any token touches the idle watchdog
          noteStreamPhase(m, "answering");
          extractProposalsFromText(m);            // lift ```proposal fences out of m.text -> cards (zero context bloat)
        }
        if (!frame) frame = requestAnimationFrame(paint);
      }
    }
  } catch (e) {
    // `progress` decides recoverability: text, thinking or tool work already on screen means the
    // task is genuinely half-done, so "继续" (or the auto-resume chain) can pick it up. A link
    // that died before producing anything has nothing to continue and is reported as an error.
    const progress = !!(m.text || m.reasoning || (m.tools && m.tools.length));
    if (e.name === "AbortError") m.stopped = true;
    else if (isTransportError(e) && progress) {
      // The TRANSPORT died, the turn did not fail. Leave m.error EMPTY on purpose: that keeps this
      // a plain truncation, so markTruncatedIfCut() marks it, the orphaned server turn is stopped,
      // and maybeAutoResume() carries the task on by itself. The raw text is kept in `cutError`
      // (surfaced in the interruption log) so the evidence is not lost.
      m.cutError = e.message || String(e);
      toast("warn", t("toast.conncut.title"), t("toast.conncut.msg"), 6000);
    } else {
      m.error = e.message || String(e);
      // Step1-F: if a client-side exception was already captured this turn (rAF
      // paint / live-timer crash), this surface error is a red herring — the real
      // root cause is the client crash, not a transport drop. Tag it so the debug
      // drawer shows the true cause instead of a misleading "连接中断".
      if (_dbg.errors.length) { m.clientError = true; m.rootCause = "client"; }
      // A compact-request-overflow of this EXACT wording is OWNED by the pendingCompact branch
      // below (it surfaces ONE accurate quiet notice and reroutes through the chunked path -- the
      // escape hatch that works). Drawing the generic "request failed" red toast here too would
      // DOUBLE-report it and put a scary banner on the path designed to be quiet. Keep m.error
      // (the pendingCompact branch still reads it for its own match) but stay silent here; the
      // pendingCompact branch is the single owner. A plain error (no pendingCompact) still draws
      // the red toast -- differential control.
      if (!(pendingCompact && /context window exceeded even when compacting/i.test(m.error))) {
        toast("error", t("toast.reqfailed.title"), m.error, 6000);
      }
    }
  } finally {
    clearInterval(liveTimer);
  }
  // Step1-F: a client-side crash was captured this turn (it may have surfaced as a
  // thrown error in a rAF paint / live-timer that the try never saw). Never let it
  // be silently swallowed — flag the message and tell the user it was the UI.
  if (_dbg.errors.length) {
    m.clientError = true;
    m.rootCause = "client";
    toast("error", t("toast.clienterr.title"), t("toast.clienterr.msg", {n: _dbg.chunkIndex, bytes: _dbg.bytes}), 6000);
  }
  // A healthy turn always ends with the gateway's [DONE]. Ending WITHOUT it (and without an error,
  // a notice or a Stop) means the connection was cut mid-turn: dropped socket, proxy timeout, gateway
  // restart. Without this check a half-streamed answer looked exactly like a finished one -- the "it
  // just stopped for no reason" report. Mark it so the UI says so and the auto-resume can pick it up.
  markTruncatedIfCut(m, sawDone, stopId);
  // A single-round turn whose own output budget ran dry (finish_reason=length) is an
  // interruption too: the model stopped mid-task because ITS budget ran dry, not because
  // the task is done. The gateway still sent a clean [DONE], so markTruncatedIfCut above
  // correctly returned false and the connection is healthy -- but the TASK is unfinished.
  // Stamp it so the already-proven auto-resume rail (which keys on m.truncated) carries it
  // on. Guarded so it cannot mis-fire: only a length-capped turn that made real progress,
  // and only when no fatal/notice/stopped path already owns this turn. lengthCapped keeps
  // the provenance distinct from a transport cut.
  if (finishReason === "length" && !m.error && !m.stopped && !m.notice && !m.truncated
      && (m.text || m.reasoning || (m.tools && m.tools.length))) {
    m.truncated = true;
    m.lengthCapped = true;
  }
  // A dead turn and a dead gateway look identical in the stream, but the user's next move is
  // completely different (press Continue vs restart the service). One cheap probe settles it.
  if (m.truncated) m.gatewayDown = await gatewayIsDown();
  recordInterruption(m);            // log time + phase for every turn that did not finish cleanly
  const endAt = performance.now();
  if (thinkStart && m.thinkSecs == null) m.thinkSecs = (endAt - thinkStart) / 1000;
  const n = sawUsage ? sumCompletion : null;      // whole turn, not just its last agent round
  const pt = usage ? usage.prompt_tokens : null;
  const genSecs = genStart ? (endAt - genStart) / 1000 : 0;
  // D12: separate reasoning from content when the engine reports it, so the output speed uses only
  // content tokens over generation time (not reasoning tokens counted against the same clock).
  const reasoningTok = turnReasoning != null ? sumReasoning : null;   // only what THIS turn reported
  const outTok = (n != null && reasoningTok != null) ? Math.max(0, n - reasoningTok) : n;
  const thinkTokS = (reasoningTok != null && m.thinkSecs != null && m.thinkSecs > 0.25) ? reasoningTok / m.thinkSecs : null;
  const outTokS = (outTok != null && genSecs > 0.25) ? outTok / genSecs : null;
  // Per-turn stats: total duration (read + tools + generate) and decode speed over text generation.
  // ALWAYS recorded, even when the turn failed / was stopped before any usage chunk arrived: the
  // duration, the thinking time and the round count are known locally, and dropping the whole footer
  // made an interrupted run look like it had never happened (2026-10-19). The token / speed / context
  // chips simply stay out when the engine never reported them (see `partial` in renderStats).
  m.stats = {
    dur: (endAt - t0) / 1000,
    prompt: pt,
    completion: n,
    outTokens: outTok,
    reasoningTokens: reasoningTok,
    tokS: outTokS,               // output-phase speed (content tokens / generation time)
    thinkTokS: thinkTokS,        // reasoning-phase speed (when the engine reports reasoning tokens)
    ctxUsed: pt,                 // context consumed this turn ≈ its prompt tokens (null = unknown)
    ctxMax: maxCtx || 0,
    cache: lastCacheTokens || 0, // so switching sessions can restore the fill + cache-hit readout
    thinkSecs: m.thinkSecs != null ? Math.round(m.thinkSecs * 10) / 10 : null,
    partial: n == null,          // no usage arrived: the footer carries duration-only figures
    // The seed this turn actually ran on. Kept in stats (not only on m) so it rides saveChat() into
    // the session file: reopening an old conversation still shows which seed produced that answer.
    seed: m.seed != null ? m.seed : null,
    seedPinned: !!m.seedPinned,
  };
  if (m.stats) recordSpeedBaseline(m.stats);  // low-occupancy turns calibrate the speed rule
  const extras = [];
  if (m.stopped) extras.push(t("stat.stopped"));
  if (projectionLoaded()) extras.push(settings.esp ? t("chat.proj.on") : t("chat.proj.off"));
  if (extras.length) m.meta = extras.join(" · ");
  for (const t of m.tools || []) if (t.state === "writing" || t.state === "running") { t.state = "skipped"; t.ms = null; }
  const ran = (m.tools || []).filter((t) => t.state === "done" || t.state === "error").length;
  if (ran) m.meta = `${m.meta ? `${m.meta} · ` : ""}${t("chat.toolcalls", {n: ran})}`;
  if (m.limit) m.meta = `${m.meta ? `${m.meta} · ` : ""}${t("chat.toollimit", {n: m.limit})}`;
  const _ownerSid = busy.sessionId, _origin = busy.origin;
  busy = null;
  setBusy(false);
  if (m && !m.stopped) bumpNebDone();          // 回合正常收尾：星云闪一下「完成」表情
  if (frame) cancelAnimationFrame(frame);
  const _ex = extractNextSteps(m.text || "");          // pull the suggestion block out of history (it is shown as chips)
  if (_ex.steps.length) { m.text = _ex.text; m.steps = _ex.steps; }
  const _pl = applyPlan(m);                            // R5: the checklist moves to the panel, out of the prose
  if (_pl.length) m.plan = _pl;
  updateAssistant(el, m, false);
  // Step4-E: reconcile the exact model output against what the bubble actually rendered.
  m._renderVerdict = reconcileRender(rawContent, el ? el.textContent : (m.text || ""));
  if (_ownerSid && _ownerSid !== activeId) {
    // the user switched away mid-stream: the finish belongs to the session that
    // started it; the current view is re-rendered from its own saved history.
    const owner = _origin || findSession(_ownerSid);
    if (owner) { if (!owner.messages.includes(m)) owner.messages.push(m); owner.updatedAt = Date.now(); }
    saveSessions();
    if (pendingCompact) pendingCompact = false;   // the pending turn belonged to the originating session; don't feed THIS view's compaction path
    renderChat();
  } else {
    saveChat();
    settleBottom();
  }
  renderSessions();   // the running badge goes out (either path)            // the turn just added the stats footer + next-step chips: keep them above the composer
  _dbg.turn = null;          // Step1-F: this turn's capture window is closed; later errors aren't attributed to it
  renderDebug();             // Step1-G: refresh the debug drawer with this turn's anomalies (if it's open)
  if (pendingCompact) {                                 // R5: a compact turn just finished (manual or automatic)
    const auto = pendingCompact === "auto";
    pendingCompact = false;
    // An EMPTY summary means the compaction request itself died (over-window chats die here:
    // the gateway refuses to loop them, http_server "exceeded even when compacting"). Rebuilding
    // [empty summary, tail] would trade the transcript's focus for nothing. Roll the failed
    // [compact-request, empty-reply] pair back off, keep history AND the resume snapshot, and
    // reroute through the chunked path whose requests demonstrably fit the window.
    // #chunkfix (2026-11): a thinking-only compaction (finish=thinking, content_chars:0 on a
    // slow quantized model) leaves m.text empty while m.reasoning is full -- the SAME gap the
    // chunked fold already honors at llmSummarize (#chunkfail). Promote the reasoning to the
    // summary body so the post-fold single-shot compact is not judged empty just because the
    // model thought out loud; this is what silently broke manual compaction on the custom model.
    if (!(m.text || "").trim() && (m.reasoning || "").trim()) { m.text = m.reasoning; }
    if (!(m.text || "").trim()) {
      messages = messages.slice(0, -2);
      saveChat(); renderChat();
      toast("err", t("insp.compact.chunkfail"), m.error || "", 9000);
      if (m.error && /context window exceeded even when compacting/i.test(m.error)) {
        // A: the escape hatch itself overflowed. Cap re-entry -- past PRECONDENSE_MAX a third fold
        // won't fit either (the window is genuinely full + injection); stop the loop and tell the
        // user how to self-rescue (shrink the tail target / pin a lower auto-compact %).
        if (precondenseDepth >= precondenseCap()) {
          precondenseDepth = 0;
          toast("err", t("insp.compact.loopstop.title"), t("insp.compact.loopstop.msg"), 12000);
          renderInspector();
          return;
        }
        precondenseAndCompact(auto);                  // bounded chunks: the escape hatch that works
        return;
      }
      renderInspector();
      return;                                         // plain failure: history untouched, user can retry
    }
    compactCount++;
    precondenseDepth = 0;   // A: a real compaction succeeded -- reset the re-entry cap for the next overflow
    const summary = m.text || "";
    const withoutPair = messages.slice(0, -2);          // drop [user compact-request, assistant summary]
    // Size-aware tail: keep recent messages verbatim only while under a token-derived
    // budget (~25% of the context window); always keep at least 2 (the last exchange).
    // A single huge tail message (e.g. a big file write) is folded instead of kept raw.
    const tailBudgetChars = computeTailBudgetChars();   // slider-driven; default 25% (must free room, not just reshuffle)
    const MIN_TAIL = 2;
    let tail = [];
    let acc = 0;
    for (let i = withoutPair.length - 1; i >= 0; i--) {
      const c = estMsgChars(withoutPair[i]);
      const haveMin = tail.length >= MIN_TAIL;
      if (tail.length && ((haveMin && acc + c > tailBudgetChars) || (c > tailBudgetChars && tail.length >= 1))) break;
      tail.unshift(withoutPair[i]); acc += c;
    }
    const origLen = withoutPair.length;
    // Recoverable archive (feature default ON): the messages about to be dropped are
    // persisted to the workspace archive folder so a later turn can re-read them; only
    // a compact summary + search-pointer stay in the window. A WHITELIST (the most recent
    // N decisions / open task-state, hard rule) is kept RESIDENT so the model never
    // silently forgets what it must not. When archiveOn is off this is the old lossy path.
    const ARCHIVE_WHITELIST_N = 3;
    const dropped = withoutPair.slice(0, withoutPair.length - tail.length);
    let archivePointer = "";
    let whitelistKeep = "";
    if (settings.archiveOn && dropped.length && activeSession() && activeSession().workspace) {
      const abase = activeSession().workspace.replace(/\/$/, "");
      const aid = "ar_" + Math.random().toString(36).slice(2, 14);
      const blob = dropped.map((d) => `${d.role}: ${(typeof d.content === "string" ? d.content : JSON.stringify(d.content))}`).join("\n\n");
      try {
        await fsWrite(`${abase}/.strata-archive/${aid}.md`, blob);
        archivePointer = `\n\n[archived verbatim: full text of the ${dropped.length} dropped messages is in .strata-archive/${aid}.md \u2014 read it back if needed]`;
        // whitelist: the last N decision/task-state lines stay resident in the summary block
        const keep = [];
        for (const d of dropped) {
          const c = typeof d.content === "string" ? d.content : "";
          for (const ln of c.split("\n")) {
            const low = ln.toLowerCase();
            if (/(decision|chose|decided|=>|->|fix|\u51b3\u7b56|\u51b3\u5b9a|\u91c7\u7eb3|\u9009\u62e9|todo|next|\u5f85\u529e|\u4e0b\u4e00\u6b65|\u8ba1\u5212)/.test(low)) keep.push(ln.trim());
          }
        }
        whitelistKeep = keep.slice(-ARCHIVE_WHITELIST_N).join("\n");
      } catch (e) { /* archive failed -> degrade to the old lossy rebuild, never block compact */ }
    }
    messages = [{role: "system", content: `【对话压缩摘要】\n${summary}${archivePointer}${whitelistKeep ? ("\n\n[kept resident \u2014 recent decisions/task-state]\n" + whitelistKeep) : ""}`}, ...tail];
    // the old occupancy described a conversation that no longer exists: show "–" until the next turn
    // reports the real prompt size again (the note under the bar explains why).
    lastPromptTokens = 0; lastCacheTokens = 0;
    saveChat(); renderChat();       // saveChat (NOT saveSessions): the rebuilt transcript must survive a reload renderInspector();
    toast("ok", auto ? t("insp.compact.autodone") : t("insp.compact.done"),
          `${origLen} → ${messages.length} ${t("insp.compact.msgs")}`, auto ? 8000 : undefined);
    if (resumeSnapshot) {                             // auto-resume: the compact turn interrupted an unfinished task (auto or manual, approved 2026-10)
      const snap = resumeSnapshot; resumeSnapshot = null;   // one-shot: never resume twice
      ceSetText($("input"), t("chat.resume.cmd"));
      toast("ok", t("chat.resume.auto"),
            snap.leftItems ? t("chat.resume.left", {n: snap.leftItems}) : undefined, 6000);
      resumeBadge = t("chat.resume.meta");            // badge consumed by the stream the deferred send() starts
      // Undo window (approved 2026-10): send() fires 3s from now; while it waits the panel row
      // carries an undo button, and clicking it clears this timer before any send() happens.
      pendingResume = { timer: setTimeout(() => { pendingResume = null; send(); }, 3000) };
      renderInspector();                              // show the undo affordance on the panel row now
    }
  } else {
    renderInspector();
    maybeAutoLearn(m);          // F5: capture this task into the knowledge base (if enabled)
    maybeProposeMemory(m);       // H2: auto-merge or stage any of the three memory proposals
    maybeProposeDesign(m);      // Design-doc: stage any `design` block as a saveable draft
    maybeAutoCompact();         // F4: summarise if we're near the context ceiling (if enabled)
    // Interrupted turn -> carry on by itself; otherwise keep driving the suggested next steps.
    // Never both: an automatic resume already puts the task back on the rails.
    if (!pendingCompact) { if (!maybeAutoResume(m)) maybeAutoDrive(m); }
  }
}

$("composer").onsubmit = (e) => { e.preventDefault(); send(); };
$("stop-btn").onclick = () => abortStream();
$("autodrive-stop").onclick = () => stopAutoDrive();
$("input").addEventListener("keydown", (e) => {
  onThumbBackspace(e, $("input")); if (e.defaultPrevented) return;
  // P1-2: slash command navigation
  const menu = $("slash-menu");
  if (menu && menu.classList.contains("open")) {
    const items = [...menu.querySelectorAll(".slash-menu__item")];
    const selIdx = items.findIndex((el) => el.classList.contains("sel"));
    if (e.key === "ArrowDown") { e.preventDefault(); items.forEach((el) => el.classList.remove("sel")); items[Math.min(selIdx + 1, items.length - 1)].classList.add("sel"); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); items.forEach((el) => el.classList.remove("sel")); items[Math.max(selIdx - 1, 0)].classList.add("sel"); return; }
    if (e.key === "Enter" && !e.shiftKey && selIdx >= 0) { e.preventDefault(); items[selIdx].click(); return; }
    if (e.key === "Escape") { e.preventDefault(); closeSlashMenu(); return; }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
// P1-2: slash command menu
const SLASH_COMMANDS = [
  {cmd: "/ingest", i18n: "cmd.ingest"},
  {cmd: "/sources", i18n: "cmd.sources"},
  {cmd: "/recall", i18n: "cmd.recall"},
  {cmd: "/forget", i18n: "cmd.forget"},
  {cmd: "/remember", i18n: "cmd.remember"},
];
function openSlashMenu() {
  const menu = $("slash-menu");
  if (!menu) return;
  menu.innerHTML = SLASH_COMMANDS.map((c) => `<div class="slash-menu__item" data-cmd="${esc(c.cmd)}"><code>${esc(c.cmd)}</code><span>${esc(t(c.i18n))}</span></div>`).join("");
  menu.classList.add("open");
  const first = menu.querySelector(".slash-menu__item");
  if (first) first.classList.add("sel");
  menu.querySelectorAll(".slash-menu__item").forEach((el) => {
    el.onclick = () => { ceSetText($("input"), el.dataset.cmd + " "); $("input").focus(); $("input").dispatchEvent(new Event("input")); closeSlashMenu(); };
  });
}
function closeSlashMenu() { $("slash-menu").classList.remove("open"); }
$("input").addEventListener("input", () => {
  if (ceText($("input")).startsWith("/")) openSlashMenu(); else closeSlashMenu();
  syncStepsSendLabel();                    // a selected chip + typed text sends both: say so on the button
});
function autosize(el) {
  // called both as a helper (arg = an element) AND as a DOM event handler (arg = an Event).
  // A bare Event is truthy but has no .style, so the old `el || $("input")` fell through to
  // Event.style === undefined and threw. Pick a real element defensively, then guard.
  const t = (el && el.style) ? el : (el && el.target && el.target.style) ? el.target : $("input");
  if (!t || !t.style) return;
  t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, innerHeight * 0.4)}px`;
}
$("input").addEventListener("input", autosize);
// IME / paste do not always fire a standard "input" event the instant text lands (a known gap for
// CJK input). Bind compositionend + paste so the send label & custom preview refresh on commit.
const __nsSync = () => { syncStepsSendLabel(); };
$("input").addEventListener("compositionend", __nsSync);
$("input").addEventListener("paste", () => setTimeout(__nsSync, 0));

// ------------------------------------------------------------------ P0-1: Regenerate & Edit
function doRegenerate(i) {
  if (busy) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  // Find the user message that prompted this assistant reply.
  let userIdx = -1;
  for (let j = i - 1; j >= 0; j--) { if (messages[j] && messages[j].role === "user") { userIdx = j; break; } }
  if (userIdx < 0) { toast("info", t("toast.nothingtoregen.title")); return; }
  // Keep the conversation up to and including the user message; drop this assistant reply
  // and everything after it. (The old code did `slice(0, i)` then `.pop()`, which deleted the
  // USER message instead of the assistant — leaving `messages[userIdx]` undefined and throwing
  // inside userText, which blanked the UI and left `busy` stuck on.)
  const removed = messages.slice(userIdx + 1);
  undoStack = {at: userIdx + 1, removed, editedFrom: null, editedTo: null};
  messages = messages.slice(0, userIdx + 1);
  saveChat();
  renderChat();
  // Stream a fresh assistant reply for that user message. streamAssistant() appends the new
  // assistant turn itself, so the user prompt stays in `messages` exactly once — no duplicate,
  // no corrupted request, and the backend/model run normally.
  streamAssistant();
  showUndoToast(removed.length);
}

// ------------------------------------------------------------------ Edit-in-place (WorkBuddy-style fork)
// The bubble becomes a textarea in place; the edit is confirmed; then the message is rewritten
// and everything after it is discarded and regenerated. Reuses doRegenerate's contract:
// streamAssistant() must be called with the edited user message as the LAST element of messages.
// ------------------------------------------------------------------ Edit & resend (custom box + strategy: soft / hard / branch)
// Open a modal with the editable text, a live preview of the downstream messages that will be
// affected, and a 3-way strategy selector. Cancel = nothing changes. On send the chosen strategy is
// applied and a fresh answer streams. Soft delete keeps the removed turns on an undo stack (toast to
// recover); hard delete discards them; branch preserves the old history as a switchable branch.
// Any in-flight stream is aborted first (streaming protection).
function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return Array.isArray(o) ? o.slice() : o; } }

function ensureEditUI() {
  if ($("edit-modal")) return;
  const style = document.createElement("style");
  style.textContent =
    "#edit-modal .st-modal__card{max-width:min(880px,94vw)}\n" +
    ".edit-preview{max-height:180px;overflow:auto;border:1px solid var(--st-line,#dee5ee);border-radius:10px;padding:8px 10px;margin-top:10px;background:var(--st-bg,#f9fafb)}\n" +
    ".edit-preview__ph{font-size:12px;color:var(--st-ink-muted,#6f6f6f);margin-bottom:6px}\n" +
    ".edit-preview__item{font-size:13px;color:var(--st-ink-muted,#6f6f6f);text-decoration:line-through;opacity:.85;padding:3px 0;border-bottom:1px solid var(--st-line-soft,#eee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n" +
    ".edit-preview__item:last-child{border-bottom:none}\n" +
    ".edit-strategy{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}\n" +
    "@media (max-width:640px){.edit-strategy{grid-template-columns:1fr}}\n" +
    ".edit-strategy__opt{border:1px solid var(--st-line,#dee5ee);border-radius:10px;padding:8px 10px;cursor:pointer;background:var(--st-surface,#fff);color:var(--st-ink,#221e1f);transition:border-color var(--st-dur,160ms) var(--st-ease),background var(--st-dur,160ms) var(--st-ease)}\n" +
    ".edit-strategy__opt:hover{border-color:var(--st-accent,#10b981)}\n" +
    ".edit-strategy__opt[aria-checked=\"true\"]{border-color:var(--st-accent,#10b981);background:var(--st-accent-tint,#ecfdf5);box-shadow:0 0 0 2px color-mix(in srgb,var(--st-accent,#10b981) 20%,transparent)}\n" +
    ".edit-strategy__opt .t{font-size:13px;font-weight:600;color:var(--st-ink,#221e1f)}\n" +
    ".edit-strategy__opt .h{font-size:11px;color:var(--st-ink-muted,#6f6f6f);margin-top:2px;line-height:1.45}\n" +
    ".branch-bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--st-line,#dee5ee);background:var(--st-bg,#f9fafb)}\n" +
    ".branch-bar[hidden]{display:none}\n" +
    ".branch-bar__label{font-size:12px;color:var(--st-ink-muted,#6f6f6f);margin-right:4px}\n" +
    ".branch-chip{border:1px solid var(--st-line,#dee5ee);background:var(--st-surface,#fff);color:var(--st-ink,#221e1f);border-radius:999px;padding:3px 12px;font-size:12px;cursor:pointer}\n" +
    ".branch-chip:hover{border-color:var(--st-accent,#10b981)}\n" +
    ".branch-chip[aria-current=\"true\"]{border-color:var(--st-accent,#10b981);background:var(--st-accent,#10b981);color:var(--st-accent-ink,#fff)}\n";
  document.head.appendChild(style);
  const m = document.createElement("div");
  m.className = "st-modal"; m.id = "edit-modal"; m.hidden = true; m.setAttribute("role", "dialog"); m.setAttribute("aria-modal", "true");
  m.innerHTML =
    '<div class="st-modal__card">' +
      '<div class="st-modal__head"><span class="card-title" data-i18n="ctx.edit.title">编辑这条任务对话</span>' +
        '<span class="st-modal__grip"><svg class="st-icon st-icon--sm st-modal__grip-icon"><use href="web/sprite.svg#i-grip"/></svg></span>' +
        '<button class="st-btn st-btn--icon" id="edit-x" aria-label="Close"><svg class="st-icon st-icon--sm"><use href="web/sprite.svg#i-close"/></svg></button></div>' +
      '<div class="st-modal__body" style="padding:14px 16px">' +
        '<div id="edit-area" class="st-textarea ce-input" contenteditable="true" role="textbox" aria-multiline="true"></div>' +
        '<div class="attachments" id="edit-attachments" hidden></div>' +
        '<div class="edit-preview" id="edit-preview"></div>' +
        '<div style="font-size:13px;font-weight:600;margin-top:12px" data-i18n="ctx.edit.strategy">发送后如何处理此后的内容</div>' +
        '<div class="edit-willapply" id="edit-willapply"></div>' +
        '<div class="edit-strategy" id="edit-strategy" role="radiogroup">' +
          '<div class="edit-strategy__opt" role="radio" data-v="hard" aria-checked="true" tabindex="0"><div class="t" data-i18n="ctx.edit.hard">真删除</div><div class="h" data-i18n="ctx.edit.hard.hint">直接永久删除，无撤销</div></div>' +
          '<div class="edit-strategy__opt" role="radio" data-v="soft" aria-checked="false" tabindex="0"><div class="t" data-i18n="ctx.edit.soft">软删除</div><div class="h" data-i18n="ctx.edit.soft.hint">删除但保留在撤销栈，5 秒内可恢复</div></div>' +
          '<div class="edit-strategy__opt" role="radio" data-v="branch" aria-checked="false" tabindex="0"><div class="t" data-i18n="ctx.edit.branch">分支保留</div><div class="h" data-i18n="ctx.edit.branch.hint">旧历史另存为分支，可在上方切换器切回</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="st-modal__actions">' +
        '<button class="st-btn st-btn--secondary" id="edit-cancel" data-i18n="ctx.edit.cancel">取消</button>' +
        '<span class="spacer"></span>' +
        '<button class="st-btn st-btn--primary" id="edit-send" data-i18n="ctx.edit.send">重新生成</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);
  if (window.i18n && window.i18n.applyI18n) window.i18n.applyI18n(m);
  const setStrategy = (v) => { m.querySelectorAll(".edit-strategy__opt").forEach(o => o.setAttribute("aria-checked", o.dataset.v === v ? "true" : "false")); m.dataset.strategy = v; const w = m.querySelector("#edit-willapply"); if (w) w.textContent = t("ctx.edit.willapply", {s: t("ctx.edit." + v)}); };
  m.querySelectorAll(".edit-strategy__opt").forEach(opt => {
    opt.addEventListener("click", () => setStrategy(opt.dataset.v));
    opt.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setStrategy(opt.dataset.v); } });
  });
  // design dim1+2: autosize the edit box like the composer; paste routes through addFiles
  // (target=#edit-area, list=editAttachments) so the modal can hold its own images.
  const _ea = m.querySelector("#edit-area");
  _ea.addEventListener("input", () => autosize(_ea));
  _ea.addEventListener("paste", (e) => pasteImageToRich(e, _ea));
  _ea.addEventListener("keydown", (e) => onThumbBackspace(e, _ea));
  m.querySelector("#edit-x").onclick = closeEditModal;
  m.querySelector("#edit-cancel").onclick = closeEditModal;
  makeDraggableCard(m);
  m.querySelector("#edit-send").onclick = confirmEdit;
  document.addEventListener("keydown", (e) => { if (!m.hidden && e.key === "Escape") closeEditModal(); });
}

let editingIndex = -1;
let editAttachments = [];             // modal-scoped images (never shared with the composer globals)
function openEditModal(i) {
  if (busy) abortStream();                 // streaming protection: stop any in-flight generation first
  const msg = messages[i];
  if (!msg || msg.role !== "user") return;
  ensureEditUI();
  bindInlineThumbDelete();   // inline thumbnails in the modal body need their delete delegation wired once
  editingIndex = i;
  const m = $("edit-modal");
  ceSetRich(m.querySelector("#edit-area"), msg.text, msg.images);
  const after = messages.slice(i + 1);
  const n = after.length;
  const prev = m.querySelector("#edit-preview");
  prev.innerHTML = '<div class="edit-preview__ph">' + esc(t("ctx.edit.preview", {n})) + "</div>" +
    (n > 0 ? after.map(x => '<div class="edit-preview__item">' + esc(((x.role === "user" ? "▸ " : "◆ ") + (x.text || "")).slice(0, 90)) + "</div>").join("") : '<div class="edit-preview__item">（无）</div>');
  m.dataset.strategy = "hard";
  m.querySelectorAll(".edit-strategy__opt").forEach(o => o.setAttribute("aria-checked", o.dataset.v === "hard" ? "true" : "false"));
  editAttachments = (msg.images || []).filter((a) => a && (a.url || a.ref)).map((a) => ({...a}));
  renderEditAttachments();
  m.hidden = false;
  const _ea2 = m.querySelector("#edit-area"); autosize(_ea2);
  m.querySelector("#edit-area").focus();
}
function makeDraggableCard(m){
  const card = m.querySelector(".st-modal__card") || m.firstElementChild;
  const head = m.querySelector(".st-modal__head");
  if (!card || !head) return;
  head.classList.add("st-modal__head--draggable");
  let ox=0, oy=0, sx=0, sy=0, dragging=false;
  head.addEventListener("mousedown", (e)=>{ if(e.target.closest("button")) return; dragging=true; sx=e.clientX; sy=e.clientY; card.style.transform="translate("+ox+"px,"+oy+"px)"; card.classList.add("is-dragging"); e.preventDefault(); });
  document.addEventListener("mousemove", (e)=>{ if(!dragging) return; card.style.transform="translate("+(e.clientX-sx+ox)+"px,"+(e.clientY-sy+oy)+"px)"; });
  document.addEventListener("mouseup", (e)=>{ if(!dragging) return; dragging=false; card.classList.remove("is-dragging"); ox=ox+(e.clientX-sx); oy=oy+(e.clientY-sy); sx=e.clientX; sy=e.clientY; });
}

function closeEditModal() { const m = $("edit-modal"); if (m) m.hidden = true; editingIndex = -1; editAttachments = []; }

async function confirmEdit() {   // 2026-11: async so the modal paste gate can be awaited; sole caller is #edit-send.onclick (fire-and-forget)
  const i = editingIndex;
  if (i < 0) return;
  const m = $("edit-modal");
  const strategy = m.dataset.strategy || "hard";
  if (pendingPastes.size) await Promise.allSettled(pendingPastes);   // 2026-11: same gate as composer send
  const newText = ceText(m.querySelector("#edit-area"));
  reconcileArray(m.querySelector("#edit-area"));   // 方案1: modal side, same source-of-truth rule as the composer
  const imgs = editAttachments.slice();   // capture BEFORE closeEditModal clears the modal list
  closeEditModal();
  if (!newText) { toast("warn", t("ctx.edit.empty")); return; }
  // Same-text resend is ALLOWED on purpose: it means "regenerate from here" (retry this turn).
  // Only an empty body is rejected. (2026-10-20: the old unchanged-guard blocked legit retries.)
  editResend(i, newText, strategy, imgs);
}

function editResend(i, newText, strategy, images) {
  if (busy) abortStream();
  const removed = messages.slice(i + 1);
  const originalText = messages[i].text;
  if (strategy === "branch") {
    branchSeq += 1;
    branches.push({id: branchSeq, label: t("branch.view") + " " + branchSeq + t("branch.fork", {n: i + 1}), messages: clone(messages), at: i});
  }
  const _beforeImgs = messages[i].images;   // what the edited message had before this edit
  undoStack = {at: i + 1, removed, editedFrom: originalText, editedTo: newText, editedFromImages: _beforeImgs};
  messages.length = i + 1;                          // truncate in place
  messages[i] = {...messages[i], text: newText, images: Array.isArray(images) ? images : messages[i].images};   // an empty modal list is a REAL intent (every image was deleted), not "no change"
  saveChat();
  renderChat();
  if (strategy === "soft" || strategy === "hard") showUndoToast(removed.length);
  streamAssistant();
}

function showUndoToast(n) {
  toast("warn", t("edit.undoredo.title"), t("edit.undoredo.msg", {n}), 5000, {label: t("toast.undo"), run: undoEdit});
}
function undoEdit() {
  if (!undoStack) return;
  if (busy) abortStream();
  const {at, removed, editedFrom, editedFromImages} = undoStack;
  messages.length = at;                             // drop the regenerated tail
  for (const x of removed) messages.push(x);        // restore the downstream turns
  if (editedFrom != null && messages[at - 1]) messages[at - 1].text = editedFrom;  // revert the edit itself
  if (messages[at - 1]) messages[at - 1].images = editedFromImages;  // revert pasted images too
  undoStack = null;
  saveChat();
  renderChat();
}

// ------------------------------------------------------------------ Branch switcher
// Saved branches (created by the branch strategy) plus the live thread are shown as chips above the
// chat. Clicking switches the visible thread; the thread you leave is stashed so it is never lost.
function renderBranchBar() {
  const view = $("view-chat");
  if (!view) return;
  let bar = $("branch-bar");
  if (!bar) { bar = document.createElement("div"); bar.id = "branch-bar"; bar.className = "branch-bar"; view.insertBefore(bar, view.firstChild); }
  const has = branches.length > 0 || activeBranchId !== null;
  bar.hidden = !has;
  if (!has) return;
  const chips = ['<span class="branch-bar__label">' + esc(t("branch.bar")) + "</span>"];
  chips.push('<button class="branch-chip" data-bid="" aria-current="' + (activeBranchId === null) + '">' + esc(t("branch.live")) + "</button>");
  for (const b of branches) chips.push('<button class="branch-chip" data-bid="' + b.id + '" aria-current="' + (activeBranchId === b.id) + '">' + esc(b.label) + "</button>");
  bar.innerHTML = chips.join("");
  bar.querySelectorAll(".branch-chip").forEach(c => c.onclick = () => switchBranch(c.dataset.bid === "" ? null : c.dataset.bid));
}
function switchBranch(rawId) {
  if (busy) abortStream();
  const id = (rawId === null || rawId === "" || rawId === undefined) ? null : Number(rawId);  // dataset gives strings; branch ids are numbers
  if (id === activeBranchId) return;
  if (activeBranchId === null) {
    liveMessages = clone(messages);                 // currently on the live thread; stash it
  } else {
    const cur = branches.find(b => b.id === activeBranchId);
    if (cur) cur.messages = clone(messages);        // currently viewing a branch; update its snapshot
  }
  if (id === null) {
    messages = liveMessages; liveMessages = null; activeBranchId = null;
  } else {
    const b = branches.find(x => x.id === id);
    if (!b) return;
    messages = clone(b.messages); activeBranchId = id;
  }
  saveChat(); renderChat(); renderBranchBar();
}

// ------------------------------------------------------------------ P0-2: Approval modal
const approvalQueue = [];
let approvalOpen = false;
function showApprovalModal(id, toolName, description) {
  const modal = $("approval-modal");
  if (!modal) return;
  $("approval-tool").textContent = toolName;
  $("approval-desc").textContent = description || `The model wants to run ${toolName}.`;
  $("approval-approve").onclick = () => { respondApproval(id, true); closeApprovalModal(); };
  $("approval-deny").onclick = () => { respondApproval(id, false); closeApprovalModal(); };
  modal.hidden = false;
  $("scrim").hidden = false;
  $("scrim").onclick = closeApprovalModal;
  approvalOpen = true;
  $("approval-approve").focus();
}
function closeApprovalModal() {
  $("approval-modal").hidden = true;
  $("scrim").hidden = true;
  approvalOpen = false;
  // process next in queue
  if (approvalQueue.length) {
    const next = approvalQueue.shift();
    showApprovalModal(next.id, next.tool, next.desc);
  }
}
async function respondApproval(id, approved) {
  try {
    await fetch("approval/respond", {method: "POST", headers: headers(true),
      body: JSON.stringify({id, approved})});
  } catch (e) { toast("error", t("toast.apprfailed.title"), e.message, 4000); }
}
// ------------------------------------------------------------------ Image viewer (double-click to enlarge)
function openImageView(src, name) {
  const m = $("img-modal");
  if (!m) return;
  $("img-modal-img").src = src;
  $("img-modal-img").alt = name || "image";
  $("img-modal-name").textContent = name || "";
  m.hidden = false;
}
function closeImageView() {
  const m = $("img-modal");
  if (!m) return;
  m.hidden = true;
  $("img-modal-img").src = "";
}
$("img-close").onclick = closeImageView;
$("img-modal").addEventListener("click", (e) => { if (e.target.id === "img-modal") closeImageView(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("img-modal").hidden) closeImageView(); });
// double-click any picture inside a chat message to open the viewer
$("chat").addEventListener("dblclick", (e) => {
  const img = e.target.closest("img.msg-img, img.inline-msg-img");
  if (img) openImageView(img.src, img.alt);
});
function onApproval(x) {
  // x = {id, tool, description} from SSE stream (strata_approval field)
  const item = {id: x.id, tool: x.tool || x.name, desc: x.description || ""};
  if (!approvalOpen) { showApprovalModal(item.id, item.tool, item.desc); }
  else { approvalQueue.push(item); }
}

$("new-btn").onclick = () => {
  if (busy) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  if (!messages.length) return;
  const backup = messages;
  messages = [];
  saveChat();
  renderChat();
  syncCtxFromSession();
  toast("info", t("toast.newchat.title"), t("toast.newchat.msg"), 6000, {label: t("toast.undo"), run: () => { messages = backup; saveChat(); renderChat(); }});
};
$("export-btn").onclick = () => {
  if (!messages.length) { toast("info", t("toast.nothingtosave.title")); return; }
  // Params are `tool`, not `t`: `t` is the i18n helper at the top of this file.
  const tools = (m) => (m.tools || []).filter((tool) => tool.result != null).map((tool) =>
    `<details><summary>Tool ${tool.server ? `${tool.server} / ` : ""}${tool.tool || tool.name}${tool.ok ? "" : " (error)"}</summary>\n\n` +
    `\`\`\`json\n${JSON.stringify(tool.arguments || {}, null, 2)}\n\`\`\`\n\n\`\`\`\n${tool.result}\n\`\`\`\n\n</details>\n\n`).join("");
  const md = messages.map((m) => m.role === "user" ? `## You\n\n${m.text}\n` :
    `## ${health.model}\n\n${m.reasoning ? `<details><summary>Thinking</summary>\n\n${m.reasoning}\n\n</details>\n\n` : ""}${tools(m)}${m.text || m.error || ""}\n`).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([md], {type: "text/markdown"}));
  a.download = `strata-chat-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// pictures and text files: the attach button, dropping them on the chat, or pasting a picture (issue #30)
const TEXT_EXT = /\.(txt|md|markdown|rst|tex|py|pyi|ipynb|js|mjs|cjs|ts|tsx|jsx|vue|svelte|json|jsonl|csv|tsv|log|ya?ml|toml|ini|cfg|conf|env|xml|html?|css|scss|less|c|cc|cpp|cxx|h|hh|hpp|cu|cuh|rs|go|java|kt|kts|swift|rb|php|pl|lua|r|jl|scala|sql|sh|bash|zsh|fish|ps1|psm1|bat|cmd|diff|patch|gradle|cmake|mk|dockerfile|gitignore|proto|graphql)$/i;
const MAX_TEXT_FILE = 512 * 1024;
function isTextFile(f) {
  return f.type.startsWith("text/") || /json|xml|javascript|yaml|toml|x-sh|x-python/.test(f.type) ||
         TEXT_EXT.test(f.name) || /(^|[\\/])(makefile|dockerfile|readme|license)$/i.test(f.name);
}
// Mixed text+image message support (the 'image between the words' request). A textarea cannot hold
// image pixels, so an attached image is referenced by a stable [img:N] placeholder typed at the caret;
// send-assembly and bubble-render both route through mixedSegments() so they agree on the layout.
// Returns null when the message has no placeholders, meaning the caller keeps the old
// 'text bubble + top gallery' behaviour (so existing tests that pass images without placeholders pass).
let attachPidSeq = 0;                                // stable per-attachment number (deleting the middle never renumbers the rest)
function attachNextPid() { return ++attachPidSeq; }
// One visual shape for a pasted/attached image: a small thumbnail that lives IN the text flow,
// name on hover, a hover-revealed delete button. data-pid is the stable anchor; ceText() rebuilds
// [img:N] from it so mixedSegments/serialize see it (single visual representation, no separate chip).
function makeInlineThumb(entry, target) {
  const pid = entry.pid;
  const src = entry.ref || entry.url || "";
  const name = entry.name || "image";
  const span = document.createElement("span");
  span.className = "ce-thumb";
  span.setAttribute("contenteditable", "false");   // atomic: the browser must not drop the caret inside, so typed text stays OUTSIDE the chip
  span.setAttribute("data-pid", String(pid));
  span.setAttribute("tabindex", "0");   // focusable so Backspace can target it (primary path)
  span.title = name;
  const img = document.createElement("img");
  img.className = "inline-ce-img";
  img.src = src;
  img.alt = name;
  img.title = name;
  const box = document.createElement("span");
  box.className = "ce-thumb__box";
  span.appendChild(box);
  box.appendChild(img);
  const x = document.createElement("button");
  x.type = "button"; x.className = "ce-thumb__x"; x.setAttribute("aria-label", t("attach.remove"));
  x.innerHTML = icon("trash");
  x.setAttribute("data-delpid", String(pid));
  box.appendChild(x);
  span.addEventListener("dblclick", (e) => { if (e.target.closest(".ce-thumb__x")) return; e.stopPropagation(); openImageView(src, name); });
  return span;
}
// Delegation: a delete button on any inline thumbnail (composer or edit modal). The button lives in
// the DOM but the ARRAY is the source of truth for sending, so removal must drop the array entry too.
// 2026-11-02: spark-note inline thumbnail delete. A spark image is ONLY ever in the stored s.html
// string (paste lands it as a data-pid chip + img); the composer/modal arrays (attachments /
// editAttachments) are NOT the source of truth for a stored spark. So when the chip sits inside a
// spark item (has data-id) we drop the chip node and persist the box's remaining HTML back through
// the existing saveSparkEdit path. The add-box is the only spark container whose live images ride in
// the shared editAttachments runtime array, so it uses the array-splice path instead.
function sparkThumbDelete(e) {
  const btn = e.target.closest(".ce-thumb__x");
  if (!btn) return;            // not one of our inline delete buttons: leave to the existing delegation
  e.preventDefault(); e.stopPropagation();
  const chip = btn.closest("[data-pid]");
  if (!chip) return;
  const box = chip.parentElement;   // the live box whose innerHTML we persist (.spark-item__text / .spark-edit-ta / #spark-add-input)
  const item = chip.closest(".spark-item[data-id]");
  if (item) {                       // stored spark (list preview / inline edit): source of truth is the stored s.html
    chip.remove();
    const tg = item.querySelector(".spark-edit-tags");
    saveSparkEdit(item.dataset.id, box.innerHTML, tg ? tg.value : "");
    return;
  }
  // add-box (not yet a stored spark): its live images ride in the shared editAttachments runtime array
  const pid = chip.getAttribute("data-pid");
  const idx = editAttachments.findIndex((a) => String(a.pid) === String(pid));
  chip.remove();
  if (idx >= 0) editAttachments.splice(idx, 1);
  renderEditAttachments();
  autosize(box);
}

function bindInlineThumbDelete() {
  const onClick = (e) => {
    const btn = e.target.closest(".ce-thumb__x");
    if (!btn) return;
    e.preventDefault(); e.stopPropagation();
    removeThumb(+(btn.getAttribute("data-delpid")), e.currentTarget);
  };
  const inp = $("input"); if (inp && !inp._thumbBound) { inp.addEventListener("click", onClick); inp._thumbBound = true; }
  if (inp) attachChipObserver(inp);
  const ea = $("edit-area"); if (ea && !ea._thumbBound) { ea.addEventListener("click", onClick); ea._thumbBound = true; }
  if (ea) attachChipObserver(ea);
  // 2026-11-02: spark side. The composer/modal removeThumb arrays do NOT apply to the three spark
  // containers (their images live in the stored s.html string), so spark chips get their OWN delete
  // delegation routed through the spark data path. Bound once; spark-list already covers both the
  // list preview (.spark-item__text) and the inline edit box (.spark-edit-ta) since both are inside it.
  const sa = $("spark-add-input"); if (sa && !sa._thumbBound) { sa.addEventListener("click", sparkThumbDelete); sa._thumbBound = true; }
  const sl = $("spark-list"); if (sl && !sl._sparkDelBound) { sl.addEventListener("click", sparkThumbDelete); sl._sparkDelBound = true; }
}
// Shared removal: the ARRAY is the source of truth for sending, so every delete path (hover
// button click, Backspace on a focused/adjacent chip) MUST splice the array AND drop the DOM node
// through this one helper — never let the browser delete only the DOM (an orphan image would
// be appended at the end of the message on send). box is the composer #input or the modal #edit-area.
function removeThumb(pid, box) {
  const isModal = box.id === "edit-area";
  const list = isModal ? editAttachments : attachments;
  const idx = list.findIndex((a) => a.pid === pid);
  const node = box.querySelector(`[data-pid="${pid}"]`);
  if (node && node.parentNode) { for (const c of Array.from(node.childNodes)) { if (c.nodeType === 3 && c.textContent.trim()) node.parentNode.insertBefore(c, node); } }   // rescue caret-dropped text so deleting the image keeps the text
  if (idx >= 0) list.splice(idx, 1);
  if (node) node.remove();
  if (isModal) renderEditAttachments(); else renderAttachments();
  autosize(box);
}
// Backspace handler shared by the composer and the edit modal. When the caret sits on / just
// before an inline chip, or a chip has focus, Backspace removes that chip (array + DOM together)
// instead of deleting a text character. Anything else is a normal text edit we leave to the browser.
function onThumbBackspace(e, box) {
  if (e.key !== "Backspace") return;
  const pid = chipForBackspace(box);
  if (pid === null || pid === undefined) return;
  e.preventDefault();
  removeThumb(+pid, box);
}
// Which chip a Backspace should delete: a chip the selection covers, OR the chip sitting
// immediately BEFORE a collapsed caret (the unit Backspace would remove), OR a chip that has
// keyboard focus. Returns the pid, or null when Backspace should stay a normal text edit.
function chipForBackspace(box) {
  const active = document.activeElement;
  if (active && active.closest && active.closest("[data-pid]") && box.contains(active.closest("[data-pid]")))
    return active.closest("[data-pid]").getAttribute("data-pid");
  const sel = window.getSelection && window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!r.collapsed) {
    const chips = box.querySelectorAll("[data-pid]");
    for (const n of chips) { if (r.intersectsNode && r.intersectsNode(n)) return n.getAttribute("data-pid"); }
    return null;
  }
  const c = r.startContainer, off = r.startOffset;
  const own = c.nodeType === 1 ? c : c.parentNode;
  if (own && own.closest && own.closest("[data-pid]") && box.contains(own.closest("[data-pid]")))
    return own.closest("[data-pid]").getAttribute("data-pid");
  if ((c.nodeType === 3 && off === 0) || (c.nodeType === 1 && off === 0)) {
    const prev = c.previousSibling;
    if (prev && prev.getAttribute && prev.getAttribute("data-pid")) return prev.getAttribute("data-pid");
  }
  return null;
}

// Insert a [img:N] reference at the caret in the composer, so the user can see WHERE the image sits.
function insertPlaceholder(pid, target, entry) {
  const inp = target || $("input");
  if (!inp) return;
  const tag = ` [img:${pid}] `;
  const src = entry && (entry.ref || entry.url);
  if (isCE(inp) && src) {
    // visual path: a real inline thumbnail node carries the image; ceText() rebuilds the
    // [img:N] anchor from data-pid so mixedSegments/serialize still see it (no ordering loss).
    const node = makeInlineThumb(entry, inp);
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      range.insertNode(node);
      range.setStartAfter(node); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } else {
      inp.appendChild(node);
    }
  } else if (isCE(inp)) {
    // fallback: no url to show -> text anchor (kept for callers that pass only a pid)
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = document.createTextNode(tag);
      range.insertNode(node);
      range.setStartAfter(node); range.collapse(true);
      sel.removeAllRanges(); sel.addRange(range);
    } else {
      inp.appendChild(document.createTextNode(tag));
    }
  } else {
    const s = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
    const e = inp.selectionEnd != null ? inp.selectionEnd : s;
    inp.value = inp.value.slice(0, s) + tag + inp.value.slice(e);
    try { inp.setSelectionRange(s + tag.length, s + tag.length); } catch (err) { /* jsdom */ }
  }
  autosize(target);
}
// Remove a removed attachment's [img:N] placeholder from the composer (kept in sync with the gallery).
function removePlaceholder(pid, target) {
  const inp = target || $("input");
  if (!inp) return;
  // an inline thumbnail node for this pid? remove it directly (no text anchor to strip).
  if (isCE(inp) && inp.querySelector) {
    const node = inp.querySelector(`[data-pid="${pid}"]`);
    if (node) { node.remove(); autosize(target); return; }
  }
  const re2 = new RegExp(`\\s*\\[img:${pid}\\]\\s*`, "g");
  if (isCE(inp)) {
    const NF = (window.NodeFilter && window.NodeFilter.SHOW_TEXT) || 4; // jsdom: doc.NodeFilter can be null
    const walker = document.createTreeWalker(inp, NF);
    while (walker.nextNode()) {
      const tn = walker.currentNode;
      if (re2.test(tn.textContent)) {
        tn.textContent = tn.textContent.replace(re2, " ").replace(/ {2,}/g, " ");
      }
    }
  } else {
    inp.value = inp.value.replace(re2, " ").replace(/ {2,}/g, " ").trim();
  }
  autosize(target);
}
// Split a message into alternating text/image segments driven by [img:N] placeholders. images are
// matched by their stable pid. Any image no placeholder references is appended at the END so nothing
// is ever lost. null = no placeholders (caller keeps the old gallery layout).
function wireImageUrl(a){ return a.url || a.ref || ""; }   // engine wire format: data URL first (the engine can resolve it); ref is render/persist-only

function mixedSegments(m) {
  const imgs = (m.images || []).filter((a) => a && (a.url || a.ref));
  const byPid = {};
  for (const a of imgs) byPid[a.pid] = a;
  const text = m.text || "";
  const re = /\[img:(\d+)\]/g;
  const segs = [];
  let last = 0, used = {}, hit = false;
  let mm;
  while ((mm = re.exec(text))) {
    hit = true;
    if (mm.index > last) segs.push({type: "text", text: text.slice(last, mm.index)});
    const a = byPid[mm[1]];
    if (a && !used[a.pid]) { segs.push({type: "image", url: a.ref || a.url, wire: wireImageUrl(a), name: a.name}); used[a.pid] = 1; }
    last = mm.index + mm[0].length;
  }
  if (!hit) return null;
  if (last < text.length) segs.push({type: "text", text: text.slice(last)});
  for (const a of imgs) if (!used[a.pid]) segs.push({type: "image", url: a.ref || a.url, wire: wireImageUrl(a), name: a.name});
  return segs;
}
function addFiles(files, opts = {}, target) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      if (!health.images) { toast("warn", t("toast.imgoff.title"), t("toast.imgoff.msg")); continue; }
      if (f.size > 20e6) { toast("warn", t("toast.imgtoolarge.title"), t("toast.imgtoolarge.msg", {name: f.name})); continue; }
      const r = new FileReader();
        r.onload = async () => {
          const a = {kind: "image", name: f.name || "pasted image", url: r.result, pid: attachNextPid()};
          const _list = opts.list || attachments; const _render = opts.render || renderAttachments;
          _list.push(a); _render();
          insertPlaceholder(a.pid, target, a);   // always inline in the composer (single visual = the thumbnail; file chip strip is for files only)
          // Plan A persistence: write the bytes to the server (data/uploads/) so the image survives a
          // reload; the message then keeps a light ref. The in-memory url keeps the preview instant.
          try {
            const j = await (await fetch("api/images/upload", {method: "POST", headers: headers(true),
              body: JSON.stringify({dataUrl: r.result, name: a.name})})).json();
            if (j && j.ref) { a.ref = j.ref; _render(); }   // best-effort: offline keeps the url only
          } catch (e) { /* persistence is best-effort; the in-memory url still renders this session */ }
        };
      r.readAsDataURL(f);
      continue;
    }
    if (!isTextFile(f)) {
      toast("warn", t("toast.nottext.title"),
            t("toast.nottext.msg", {name: f.name, extra: health.images ? t("toast.nottext.pictures") : ""}));
      continue;
    }
    if (f.size > MAX_TEXT_FILE) { toast("warn", t("toast.filetoolarge.title"), t("toast.filetoolarge.msg", {name: f.name})); continue; }
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result);
      if (text.includes("\u0000")) { toast("warn", t("toast.binary.title"), t("toast.binary.msg", {name: f.name})); return; }
      attachments.push({kind: "file", name: f.name, text});
      renderAttachments();
    };
    r.readAsText(f);
  }
}
// a file's text in the message, fenced with more backticks than it contains itself
function fileBlock(f) {
  const longest = Math.max(2, ...(f.text.match(/`+/g) || []).map((s) => s.length));
  const fence = "`".repeat(longest + 1);
  return `File: ${f.name}\n${fence}\n${f.text}\n${fence}`;
}
function userText(m) {
  const files = (m.files || []).filter((f) => f.text != null);
  return [m.text, ...files.map(fileBlock)].filter((s) => s).join("\n\n");
}
function renderAttachments(list) {
  const box = $("attachments");
  const _l = list || attachments;
  // images ride inline in the composer body (single visual = the thumbnail); only file attachments
  // get a management chip, so the box is visible only when a file is present.
  const _files = _l.filter((a) => a.kind === "file");
  box.hidden = !_files.length;
  box.innerHTML = "";
  _files.forEach((a0) => {
    const i = _l.indexOf(a0);
    const a = a0;
    const c = document.createElement("span");
    c.className = "chip chip--t";
    c.innerHTML = icon(a.kind === "file" ? "attach" : "image", "st-icon st-icon--sm");
    c.title = a.name || "file";
    const x = document.createElement("button");
    x.type = "button"; x.className = "st-btn st-btn--icon"; x.setAttribute("aria-label", t("attach.remove"));
    x.innerHTML = icon("trash");
    x.onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    c.appendChild(x);
    box.appendChild(c);
  });
}
function renderEditAttachments() {
  const box = document.getElementById("edit-attachments");
  if (!box) return;
  // the modal body (#edit-area) now carries the inline thumbnails; the chip box has no file-only
  // role here, so it stays hidden. Images are managed on the inline thumbnail (hover reveal).
  box.hidden = true;
  box.innerHTML = "";
}
$("attach-btn").onclick = () => $("file").click();
// drop files on the chat or the message box
for (const id of ["chat", "composer"]) {
  const el = $(id);
  el.addEventListener("dragover", (e) => {
    if (![...(e.dataTransfer || {}).types || []].includes("Files")) return;
    e.preventDefault();
    $("composer").classList.add("dragging");
  });
  el.addEventListener("dragleave", () => $("composer").classList.remove("dragging"));
  el.addEventListener("drop", (e) => {
    $("composer").classList.remove("dragging");
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    // P2-2: Ctrl+Drop → ingest to knowledge base; normal drop → attach to chat
    if (e.ctrlKey) {
      const files = [...e.dataTransfer.files];
      ingestDrop(files);
      return;
    }
    addFiles(e.dataTransfer.files);
    $("input").focus();
  });
}
$("file").onchange = () => { addFiles($("file").files); $("file").value = ""; };

// ------------------------------------------------------------------ P2-2: Ctrl+Drop → ingest to knowledge base
async function ingestDrop(files) {
  for (const f of files) {
    // Use the full path from the File API (Chromium exposes it via webkitRelativePath for folder drops)
    const path = f.webkitRelativePath || f.name;
    try {
      // memory/ingest answers in plain text: "ingested N chunks from X" / "skipped: ..."
      const msg = await mcpText("memory", "ingest", {path});
      toast("success", t("toast.ingest.ok", {name: f.name}), msg || t("toast.ingest.msg"));
    } catch (e) { toast("error", t("toast.ingest.fail", {name: f.name}), e.message, 5000); }
  }
  loadKnowledgePanel();
}
function handlePasteImage(e, textarea, opts) {
  if (!health.images) return;
  const cd = e.clipboardData || window.clipboardData;
  if (!cd) return;
  // Most clipboard sources (screenshot tools, IM apps, the OS clipboard) hand the image
  // through clipboardData.items and leave .files empty; getAsFile() is the only way to
  // reach them. .files alone silently dropped every such paste (the "paste stopped working" report).
  let files = [...(cd.files || [])].filter((f) => f && f.type && f.type.startsWith("image/"));
  if (!files.length && typeof cd.items === "object") {
    files = [...cd.items]
      .filter((it) => it && it.kind === "file" && it.type && it.type.startsWith("image/"))
      .map((it) => (typeof it.getAsFile === "function" ? it.getAsFile() : null))
      .filter(Boolean);
  }
  if (files.length) { e.preventDefault(); addFiles(files, opts, textarea); }
}
$("input").addEventListener("paste", (e) => pasteImageToRich(e, $("input")));

// ─────────────────────────────────────────────────────────────────────
// Step1-G · Debug drawer + one-click diagnosis
// A slide-in panel that surfaces the Step1-F capture buffer, the per-turn
// transport flags (truncated / stopped / notice / cutError), and lets the
// user copy a self-contained evidence blob or run a local diagnosis. The
// "Diagnose" button also probes an optional /api/diagnose endpoint when the
// backend ships it; until then it runs entirely client-side (fault-tolerant).
// ─────────────────────────────────────────────────────────────────────
const DEBUG_REMOTE_ENABLED = false;   // flip true once /api/diagnose ships

function openDebug(open) {
  // 2026-10-27: the debug drawer became a full page tab (memory-page paradigm).
  // open/close routes through showTab; kept as an API so tests and hash deep-links work.
  if (open) { renderDebug(); renderGatewayDebug(); renderBugBox(); renderRecycle(); applyDebugSubTab(); showTab("debug"); }
  else if (tab === "debug") showTab("chat");
}

function debugFlagTexts(m) {
  const f = [];
  if (m.clientError) f.push(t("debug.flag.client"));
  if (m.error && !m.clientError) f.push("请求/传输错误: " + m.error);
  if (m.truncated) f.push("连接被切断（传输层）");
  if (m.stopped) f.push("主动停止");
  if (m.notice) f.push("可恢复中断: " + (m.notice.code || "") + " " + (m.notice.message || ""));
  if (m.cutError) f.push("断流: " + m.cutError);
  return f;
}

// ── Step4-E: render reconciliation ───────────────────────────────────────────────
// Compare the EXACT model output (raw content deltas) against what the bubble actually
// rendered. Markdown, code fences, proposal/next-steps/plan blocks and HTML are stripped
// from both sides so the check is robust to faithful rendering; it only flags genuine loss
// (a delta dropped / the renderer eating visible text), never formatting differences.
function normalizeForReconcile(s) {
  if (!s) return "";
  let x = String(s);
  x = x.replace(/```(?:proposal|nextsteps|plan)[\s\S]*?```/g, " ");  // structured blocks are moved out of the bubble
  x = x.replace(/```[\s\S]*?```/g, " ");                              // code fences (rendered as <pre>, symmetric)
  x = x.replace(/`([^`]*)`/g, "$1");                                   // inline code markers
  x = x.replace(/[>*_~#]/g, "");                                       // markdown emphasis/heading/blockquote markers
  x = x.replace(/^\s*[-*+]\s+/gm, "");                                // list bullets (rendered without the marker)
  x = x.replace(/<[^>]+>/g, " ");                                      // any HTML tags
  x = x.replace(/\s+/g, " ").trim();
  return x;
}

function reconcileRender(rawContent, renderedText) {
  const raw = normalizeForReconcile(rawContent);
  const ren = normalizeForReconcile(renderedText);
  if (!raw) return { status: "ok", rawLen: 0, renderLen: ren.length, missing: 0 };
  if (ren.includes(raw)) return { status: "ok", rawLen: raw.length, renderLen: ren.length, missing: 0 };
  // Not contained: measure how much of the tail is genuinely missing (tolerate tiny normalization gaps).
  let i = 0; const n = Math.min(raw.length, ren.length);
  while (i < n && raw[i] === ren[i]) i++;
  const missing = raw.length - i;
  const THRESHOLD = 12;                                                // tolerate only tiny tail gaps from normalization
  if (missing <= THRESHOLD) return { status: "ok", rawLen: raw.length, renderLen: ren.length, missing };
  return { status: "diverged", rawLen: raw.length, renderLen: ren.length, missing, at: i };
}

function renderDebug() {
  const list = $("debug-list"); if (!list) return;
  const d = window.__strataDebug;
  const live = (busy && busy.msg) ? busy.msg : null;
  const liveCap = d && d.current ? d.current() : null;
  const items = [];
  if (live && liveCap) {
    items.push({ kind: "live",
      msg: t("debug.title") + "：已收 " + liveCap.chunkIndex + " 分块 / " + liveCap.bytes + " 字节"
        + (liveCap.errors.length ? "，已捕获 " + liveCap.errors.length + " 处前端异常" : "") });
  }
  const msgs = (typeof messages !== "undefined") ? messages : [];
  for (let i = msgs.length - 1; i >= 0 && items.length < 40; i--) {
    const m = msgs[i];
    if (!m || m.role !== "assistant") continue;
    const errs = m._clientErrors || [];
    const flags = debugFlagTexts(m);
    // Step4-E: a diverged render reconciliation is itself an anomaly worth surfacing.
    const verdict = m._renderVerdict;
    const reconFlag = (verdict && verdict.status === "diverged") ? t("debug.flag.recon") : null;
    const allFlags = reconFlag ? flags.concat(reconFlag) : flags;
    if (!errs.length && !allFlags.length) continue;
    items.push({ kind: "turn", idx: i, errs, flags: allFlags, stats: m.stats, verdict });
  }
  if (!items.length) { list.innerHTML = `<p class="muted small">${esc(t("debug.none"))}</p>`; return; }
  list.innerHTML = items.map((it) => {
    if (it.kind === "live") return `<div class="debug-item debug-item--live"><b>${esc(it.msg)}</b></div>`;
    const head = `<div class="debug-item__head">回合 #${it.idx} ${it.flags.map((f) => `<span class="badge badge--ws">${esc(f)}</span>`).join("")}</div>`;
    const errHtml = it.errs.map((e) => `<div class="debug-err"><div class="debug-err__msg">${esc(e.phase)} · ${esc(e.msg)}</div>`
      + `<div class="debug-err__meta">第 ${e.chunkIndex} 分块 / 约 ${e.bytes} 字节 · ${new Date(e.ts).toLocaleTimeString()}</div>`
      + `<pre class="debug-err__stack">${esc(e.stack || "")}</pre></div>`).join("");
    const reconHtml = (it.verdict && it.verdict.status === "diverged")
      ? `<div class="debug-err__meta debug-recon">${esc(t("debug.recon.diverged", { raw: it.verdict.rawLen, ren: it.verdict.renderLen, miss: it.verdict.missing }))}</div>` : "";
    const statHtml = it.stats ? `<div class="debug-err__meta">耗时 ${(it.stats.dur != null ? it.stats.dur.toFixed(1) : "-")}s · tokens ${it.stats.completion != null ? it.stats.completion : "-"}</div>` : "";
    return `<div class="debug-item">${head}${errHtml}${reconHtml}${statHtml}</div>`;
  }).join("");
}

function buildDebugEvidence() {
  const d = window.__strataDebug;
  const liveCap = d && d.current ? d.current() : null;
  const msgs = (typeof messages !== "undefined") ? messages : [];
  const snapshot = msgs.filter((m) => m && m.role === "assistant"
      && ((m._clientErrors && m._clientErrors.length) || m.clientError || m.error || m.truncated || m.stopped || m.notice || m.cutError))
    .slice(-10).map((m) => ({
      idx: msgs.indexOf(m), clientError: !!m.clientError, error: m.error || null, truncated: !!m.truncated,
      stopped: !!m.stopped, notice: m.notice || null, cutError: m.cutError || null, rootCause: m.rootCause || null,
      stats: m.stats || null, clientErrors: m._clientErrors || [],
    }));
  return [
    "=== 星云智能体 流式调试证据 ===",
    "time: " + new Date().toISOString(),
    "model: " + (typeof requestModel === "function" ? requestModel() : "?"),
    "live: " + JSON.stringify(liveCap || null),
    "turns: " + JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

async function copyDebugEvidence() {
  const ev = buildDebugEvidence();
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(ev);
    else throw new Error("no clipboard api");
    toast("ok", t("debug.copied"), "", 3000);
  } catch (e) {
    const ta = document.createElement("textarea"); ta.value = ev; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("ok", t("debug.copied"), "", 3000); }
    catch (_) { toast("error", t("debug.copyfail"), "", 4000); }
    ta.remove();
  }
}

async function diagnoseStream() {
  const msgs = (typeof messages !== "undefined") ? messages : [];
  const m = (busy && busy.msg) || msgs.filter((x) => x && x.role === "assistant").pop() || null;
  let verdict;
  if (!m) verdict = t("debug.diag.nomsg");
  else if (m._clientErrors && m._clientErrors.length) {
    const e = m._clientErrors[m._clientErrors.length - 1];
    verdict = t("debug.diag.client", { n: e.chunkIndex, bytes: e.bytes, msg: e.msg, phase: e.phase });
  } else if (m.clientError) verdict = t("debug.diag.clientFallback");
  else if (m.truncated) verdict = t("debug.diag.truncated");
  else if (m.error) verdict = m.rootCause === "client" ? t("debug.diag.clientFallback") : t("debug.diag.error", { msg: m.error });
  else if (m.stopped) verdict = t("debug.diag.stopped");
  else if (m.notice) verdict = t("debug.diag.notice", { code: m.notice.code || "", msg: m.notice.message || "" });
  else verdict = t("debug.diag.clean");
  // Optional server-side diagnosis — only when the backend exposes /api/diagnose.
  if (DEBUG_REMOTE_ENABLED) {
    try {
      const r = await fetchWithRetry("diagnose", { method: "POST", headers: headers(true), body: JSON.stringify({ evidence: buildDebugEvidence() }) }, { retries: 0, base: 200 });
      if (r.ok) { const j = await r.json(); if (j && j.verdict) verdict += "\n\n[服务端] " + j.verdict; }
    } catch (_) { /* backend not ready — local verdict stands */ }
  }
  toast("info", t("debug.verdict"), verdict, 9000);
  const list = $("debug-list");
  if (list) {
    const v = document.createElement("div"); v.className = "debug-item debug-item--verdict";
    v.innerHTML = `<b>${esc(t("debug.verdict"))}</b><pre class="debug-err__stack">${esc(verdict)}</pre>`;
    list.prepend(v);
  }
  return verdict;
}

// ── Step4-D / Step3-B: gateway-side debug ──────────────────────────────────────────
async function fetchAllRequests() {
  try {
    const r = await fetchWithRetry("api/requests", { method: "GET" }, { retries: 0, base: 200 });
    if (!r.ok) return [];
    const j = await r.json();
    return (j && j.requests) || [];
  } catch (_) { return []; }
}

async function fetchLatestRequest() {
  const recs = await fetchAllRequests();
  return recs[0] || null;
}

// Step3-B: turn the per-chunk timeline into a phase waterfall (queue→think→gen→tool→tail).
// Each timeline entry marks the START of a segment whose duration runs until the next entry,
// so phase time is attributed to the event that opens it. The pre-first-byte gap is "queue".
function computeWaterfall(rec) {
  const tl = (rec && rec.chunk_timeline || []).slice().sort((a, b) => a.t - b.t);
  if (tl.length === 0) return null;
  const total = (typeof rec.duration_s === "number" && rec.duration_s > 0) ? rec.duration_s : tl[tl.length - 1].t;
  if (total <= 0) return null;
  const segs = [{ kind: "queue", start: 0, dur: tl[0].t }];
  for (let i = 0; i < tl.length; i++) {
    const t = tl[i].t;
    const dur = ((i + 1 < tl.length ? tl[i + 1].t : total) - t);
    if (dur <= 0) continue;
    const type = tl[i].type;
    let kind = "tail";
    if (type === "thinking") kind = "think";
    else if (type === "content") kind = "gen";
    else if (type === "tool_call" || type === "tool_result" || type === "tool_progress" || type === "mcp") kind = "tool";
    segs.push({ kind, start: t, dur });
  }
  // de-duplicate zero-width (shouldn't happen) and return total for bar scaling
  return { total, segs: segs.filter((s) => s.dur > 0.0001) };
}

function renderWaterfallHtml(wf) {
  if (!wf) return "";
  const fmt = (s) => (s >= 1 ? s.toFixed(2) + "s" : Math.round(s * 1000) + "ms");
  const segs = wf.segs.map((s) => {
    const pct = Math.max(0.5, (s.dur / wf.total) * 100);
    const label = t("debug.wf." + s.kind);
    return `<div class="wf-seg wf-seg--${s.kind}" style="width:${pct}%" title="${esc(label)} ${esc(fmt(s.dur))}"></div>`;
  }).join("");
  const legend = ["queue", "think", "gen", "tool", "tail"].map((k) =>
    `<span class="wf-legend__item"><i class="wf-dot wf-seg--${k}"></i>${esc(t("debug.wf." + k))}</span>`).join("");
  return `<div class="wf"><div class="wf-bar">${segs}</div>` +
         `<div class="wf-meta">${esc(t("debug.wf.total"))} ${esc(fmt(wf.total))}</div>` +
         `<div class="wf-legend">${legend}</div></div>`;
}

async function renderGatewayDebug() {
  const el = $("debug-gw-body"); if (!el) return;
  const recs = await fetchAllRequests();
  if (!recs.length) { el.innerHTML = `<p class="muted small">${esc(t("debug.gw.empty"))}</p>`; return; }
  const latest = recs[0];
  const tl = latest.chunk_timeline || [];
  const counts = {};
  tl.forEach((e) => { counts[e.type] = (counts[e.type] || 0) + 1; });
  const summary = Object.keys(counts).map((k) => `${k}×${counts[k]}`).join("  ");
  const endReason = latest.end_reason || "done";
  const resumable = latest.resumable ? t("debug.gw.resumable") : t("debug.gw.notresumable");
  const wf = computeWaterfall(latest);

  // ── latest turn: detail card + its time waterfall ──
  let html = `<div class="debug-item">
    <div class="debug-item__head">网关侧 · ${esc(latest.path || "")}</div>
    <div class="debug-err__meta">分块 ${tl.length} · 末块 ${esc(latest.last_chunk_type || "-")} · 断点 ${esc(endReason)} · ${resumable}</div>
    <div class="debug-err__meta">${esc(summary)}</div>
    ${wf ? `<div class="debug-gw-sub">${esc(t("debug.wf.title"))}</div>${renderWaterfallHtml(wf)}` : ""}
  </div>`;

  // ── backlog: recent rounds grouped by session (Step3-B) ──
  const grouped = {};
  for (const r of recs) {
    const sid = r.session_id || "—";
    (grouped[sid] = grouped[sid] || []).push(r);
  }
  const sessionIds = Object.keys(grouped);
  let rows = "";
  let shown = 0;
  const MAX_ROWS = 12;
  // newest-first across all, but keep each session's rows together under a header
  for (const sid of sessionIds) {
    const list = grouped[sid].slice().sort((a, b) => (b.started_at || 0) - (a.started_at || 0));
    rows += `<div class="wf-group__head">${esc(t("debug.wf.session"))}: ${esc(sid)}</div>`;
    for (const r of list) {
      if (shown >= MAX_ROWS) break;
      shown++;
      const w = computeWaterfall(r);
      const er = r.end_reason || "done";
      const rcount = (r.chunk_timeline || []).length;
      rows += `<div class="wf-row">
        <div class="wf-row__meta"><span class="wf-row__id">${esc(r.id)}</span>` +
        `<span class="wf-row__er ${r.resumable ? "is-resumable" : ""}">${esc(er)}</span>` +
        `<span class="wf-row__chunks">${rcount} 分块</span></div>
        ${w ? renderWaterfallHtml(w) : `<div class="muted small">${esc(t("debug.wf.notimeline"))}</div>`}
      </div>`;
    }
    if (shown >= MAX_ROWS) break;
  }
  html += `<div class="wf-backlog"><div class="debug-gw-sub">${esc(t("debug.wf.backlog"))}</div>${rows}</div>`;

  el.innerHTML = html;
}

function buildRequestCurl(rec) {
  const path = rec.path || "/v1/chat/completions";
  const body = (rec.input && !rec.input_truncated) ? rec.input : null;
  if (!body) return null;
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  const key = (typeof API_KEY !== "undefined" && API_KEY) ? API_KEY : "<apiKey>";
  // single-quote the body but escape any embedded single quotes for the shell
  const safe = String(body).replace(/'/g, "'\\''");
  return `curl -N -X POST "${origin}${path}" \\\n` +
         `  -H "Content-Type: application/json" \\\n` +
         `  -H "Authorization: Bearer ${key}" \\\n` +
         `  -d '${safe}'`;
}

async function copyRequestCurl() {
  const rec = await fetchLatestRequest();
  if (!rec) { toast("error", t("debug.gw.empty"), "", 3000); return; }
  const curl = buildRequestCurl(rec);
  if (!curl) { toast("error", t("debug.gw.noinput"), "", 3000); return; }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(curl);
    else throw new Error("no clipboard api");
    toast("ok", t("debug.copied"), "", 3000);
  } catch (e) {
    const ta = document.createElement("textarea"); ta.value = curl; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); toast("ok", t("debug.copied"), "", 3000); }
    catch (_) { toast("error", t("debug.copyfail"), "", 4000); }
    ta.remove();
  }
}

// ------------------------------------------------------------------ the sampling drawer
function openDrawer(open) {
  $("drawer").dataset.open = String(open);
  $("drawer").setAttribute("aria-hidden", String(!open));
  $("scrim").hidden = !open;
  if (open) { loadDrawer(); loadShared(); loadMcp(); }
}
function loadDrawer(s = settings) {
  // Per-task: show the ACTIVE task's level, not the global one, so the drawer reflects reality.
  const _tv = sessionThink(activeSession());
  for (const b of $("s-thinking").children) b.setAttribute("aria-checked", String(b.dataset.v === _tv));
  $("s-temp").value = s.temperature; $("s-topp").value = s.top_p; $("s-topk").value = s.top_k;
  $("s-max").value = s.max; $("s-ceiling").value = s.maxCeiling; $("s-seed").value = s.seed;
  $("s-thinkbudget").value = s.thinkBudget; $("s-answerfloor").value = s.answerFloor;
  $("s-autoresumeMax").value = (s.autoresumeMax>0?s.autoresumeMax:24); $("s-emptyRoundMax").value = (s.emptyRoundMax>=0?s.emptyRoundMax:2);
  $("s-show").setAttribute("aria-checked", String(!!s.show));
  $("s-esp").setAttribute("aria-checked", String(s.esp !== false));
  $("esp-row").hidden = !projectionLoaded();
  $("s-mcp").setAttribute("aria-checked", String(s.mcp !== false));
  $("s-share").setAttribute("aria-checked", String(sharedOn));
  $("s-recall").setAttribute("aria-checked", String(s.recall !== false));
  $("s-autolearn").setAttribute("aria-checked", String(!!s.autolearn));
  $("s-automemory").setAttribute("aria-checked", String(!!s.autoMemory));
  $("s-memcompact").setAttribute("aria-checked", String(!!s.memCompactLLM));
  $("s-autocompact").setAttribute("aria-checked", String(s.autocompact !== false));
  $("s-autosteps").setAttribute("aria-checked", String(!!s.autosteps));
  if ($("s-autosteps-rec")) $("s-autosteps-rec").setAttribute("aria-checked", String(s.autostepsRec !== false));
  $("s-autoresume").setAttribute("aria-checked", String(s.autoresume !== false));
  $("s-autofix").setAttribute("aria-checked", String(!!s.autofix));
  $("s-compactpct").value = s.compactPct || 0;
  $("s-compactpct-row").hidden = !s.autocompact;
  $("s-speeddrop").value = s.speedDropPct || 50;
  $("s-targetpct").value = s.compactTarget || 25;
  $("s-precondmax").value = (+s.precondenseMax >= 1) ? +s.precondenseMax : 2;
  $("s-archiveon").setAttribute("aria-checked", String(s.archiveOn !== false));
  renderArchiveManager();   // fire-and-forget: refresh the cold-archive panel
  $("s-cnthink").setAttribute("aria-checked", String(!!s.cnThink));
  $("s-stepsfold").setAttribute("aria-checked", String(s.stepsFold !== false));
  $("s-designlang").value = s.designLang || "auto";
  $("s-persona").value = s.persona || "";
  renderSeedNote();               // "this turn used 823741" only shows while the field is empty
  outputs();
}
// "Use for other apps too": the server keeps these settings as every client's defaults (GET/POST /settings)
let sharedOn = false;
async function loadShared() {
  try {
    const r = await fetch("settings", {headers: headers()});
    if (r.ok) sharedOn = !!(await r.json()).shared;
  } catch (e) { /* an older server: the switch just stays off */ }
  $("s-share").setAttribute("aria-checked", String(sharedOn));
}
function sharedDefaults(s) {
  const d = {reasoning_effort: s.thinking, temperature: +s.temperature};
  if (s.thinking && s.thinking !== THINK_AUTO) {
    const b = (s.thinkBudget && +s.thinkBudget > 0) ? +s.thinkBudget : thinkingBudget(s.thinking);
    if (b) d.reasoning_budget_tokens = b;
  }
  if (s.answerFloor && +s.answerFloor > 0) d.answer_floor_tokens = +s.answerFloor;
  if (+s.temperature > 0) Object.assign(d, {top_p: +s.top_p, top_k: +s.top_k});
  if (s.seed) d.seed = +s.seed;
  if (s.max) d.max_tokens = +s.max;
  if (projectionLoaded()) d.experimental_speed_projection = s.esp !== false;
  return d;
}
async function saveShared(on, s) {
  const r = await fetch("settings", {method: "POST", headers: headers(true),
                                      body: JSON.stringify({defaults: on ? sharedDefaults(s) : null})});
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { msg = (await r.json()).error.message || msg; } catch (e) { /* not json */ }
    throw new Error(msg);
  }
  sharedOn = !!(await r.json()).shared;
}
// the engine was started with the experimental-speed-projection control vector (INFO cvec=...)
function projectionLoaded() {
  const c = lastMetrics && lastMetrics.engine ? lastMetrics.engine.cvec : 0;
  return !!c && c !== "0";
}
function outputs() {
  const tempV = +$("s-temp").value;
  $("o-temp").textContent = tempV === 0 ? "0 · greedy" : tempV.toFixed(2);
  $("o-topp").textContent = (+$("s-topp").value).toFixed(2);
  $("o-topk").textContent = $("s-topk").value;
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  $("o-thinking").textContent = thinkOutput(sel && sel.dataset.v);
  for (const id of ["s-topp", "s-topk"]) $(id).disabled = tempV === 0;
  const cp = +$("s-compactpct").value;
  $("o-compactpct").textContent = cp === 0 ? t("drawer.compactpct.auto") : cp + "%";
  $("s-compactpct").disabled = !settings.autocompact;
  const sd = +$("s-speeddrop").value;
  $("o-targetpct").textContent = (+(+$("s-targetpct").value) || 25) + "%";
  $("o-precondmax").textContent = (+(+$("s-precondmax").value) || 2);
  $("o-speeddrop").textContent = sd + "%";
  $("s-speeddrop").disabled = !settings.autocompact || settings.compactPct > 0;   // pinned threshold = pure window rule, speed channel sleeps
}
for (const b of $("s-thinking").children) b.onclick = () => { for (const x of $("s-thinking").children) x.setAttribute("aria-checked", String(x === b)); outputs(); };
for (const id of ["s-temp", "s-topp", "s-topk", "s-compactpct", "s-targetpct", "s-speeddrop", "s-precondmax"]) $(id).oninput = outputs;
$("s-show").onclick = () => $("s-show").setAttribute("aria-checked", String($("s-show").getAttribute("aria-checked") !== "true"));
$("s-esp").onclick = () => $("s-esp").setAttribute("aria-checked", String($("s-esp").getAttribute("aria-checked") !== "true"));
$("s-mcp").onclick = () => $("s-mcp").setAttribute("aria-checked", String($("s-mcp").getAttribute("aria-checked") !== "true"));
$("s-share").onclick = () => $("s-share").setAttribute("aria-checked", String($("s-share").getAttribute("aria-checked") !== "true"));
$("s-recall").onclick = () => $("s-recall").setAttribute("aria-checked", String($("s-recall").getAttribute("aria-checked") !== "true"));
$("s-autolearn").onclick = () => $("s-autolearn").setAttribute("aria-checked", String($("s-autolearn").getAttribute("aria-checked") !== "true"));
$("s-automemory").onclick = () => $("s-automemory").setAttribute("aria-checked", String($("s-automemory").getAttribute("aria-checked") !== "true"));
$("s-memcompact").onclick = () => $("s-memcompact").setAttribute("aria-checked", String($("s-memcompact").getAttribute("aria-checked") !== "true"));
$("s-autocompact").onclick = () => $("s-autocompact").setAttribute("aria-checked", String($("s-autocompact").getAttribute("aria-checked") !== "true"));
$("s-archiveon").onclick = () => $("s-archiveon").setAttribute("aria-checked", String($("s-archiveon").getAttribute("aria-checked") !== "true"));
$("s-autosteps").onclick = () => $("s-autosteps").setAttribute("aria-checked", String($("s-autosteps").getAttribute("aria-checked") !== "true"));
$("s-autosteps-rec").onclick = () => { const on = $("s-autosteps-rec").getAttribute("aria-checked") !== "true"; $("s-autosteps-rec").setAttribute("aria-checked", String(on)); const pv = $("s-autosteps-rec").closest(".toggle-row").querySelector(".st-check__preview"); if (pv) pv.setAttribute("data-state", on ? "on" : "off"); };
$("s-autoresume").onclick = () => $("s-autoresume").setAttribute("aria-checked", String($("s-autoresume").getAttribute("aria-checked") !== "true"));
$("s-autofix").onclick = () => $("s-autofix").setAttribute("aria-checked", String($("s-autofix").getAttribute("aria-checked") !== "true"));
$("s-cnthink").onclick = () => $("s-cnthink").setAttribute("aria-checked", String($("s-cnthink").getAttribute("aria-checked") !== "true"));
$("s-stepsfold").onclick = () => $("s-stepsfold").setAttribute("aria-checked", String($("s-stepsfold").getAttribute("aria-checked") !== "true"));
$("s-reset").onclick = () => loadDrawer(DEFAULTS);
// "Pin this seed": one click turns the last random seed into the fixed one (field + saved settings),
// so the next turn replays the same sampling. Clearing the field afterwards goes back to random.
$("seed-lock").onclick = () => {
  if (lastSeedUsed == null) return;
  $("s-seed").value = lastSeedUsed;
  settings.seed = String(lastSeedUsed);
  store.set("sampling", settings);
  renderSeedNote();
  toast("success", t("toast.seed.locked.title"), t("toast.seed.locked.msg", {n: lastSeedUsed}));
};
$("s-apply").onclick = async () => {
  const sel = [...$("s-thinking").children].find((b) => b.getAttribute("aria-checked") === "true");
  // Per-task: pin it on the ACTIVE task (so this task keeps it) AND keep it as the global default,
  // which is what brand-new tasks inherit -- one action, both effects, instead of a silent global.
  const _tm = normThink(sel && sel.dataset.v) || "high";
  const _ts = activeSession();
  if (_ts) { _ts.thinking = _tm; saveSessions(); renderSessions(); }
  settings = {thinking: _tm, temperature: +$("s-temp").value, top_p: +$("s-topp").value,
              top_k: +$("s-topk").value, max: $("s-max").value.trim(), maxCeiling: $("s-ceiling").value.trim(), seed: $("s-seed").value.trim(),
              thinkBudget: $("s-thinkbudget").value.trim(), answerFloor: $("s-answerfloor").value.trim(),
              show: $("s-show").getAttribute("aria-checked") === "true",
              esp: $("s-esp").getAttribute("aria-checked") === "true",
              mcp: $("s-mcp").getAttribute("aria-checked") === "true",
              recall: $("s-recall").getAttribute("aria-checked") === "true",
              autolearn: $("s-autolearn").getAttribute("aria-checked") === "true",
              autoMemory: $("s-automemory").getAttribute("aria-checked") === "true",
              memCompactLLM: $("s-memcompact").getAttribute("aria-checked") === "true",
              autocompact: $("s-autocompact").getAttribute("aria-checked") === "true",
              autosteps: $("s-autosteps").getAttribute("aria-checked") === "true",
              autostepsRec: $("s-autosteps-rec") ? $("s-autosteps-rec").getAttribute("aria-checked") === "true" : true,
              autoresume: $("s-autoresume").getAttribute("aria-checked") === "true",
              autofix: $("s-autofix").getAttribute("aria-checked") === "true",
              compactPct: +$("s-compactpct").value,
              speedDropPct: +$("s-speeddrop").value,
              compactTarget: +$("s-targetpct").value,
              precondenseMax: (+(+$("s-precondmax").value) || 2) >= 1 ? +(+$("s-precondmax").value) : 2,
              autoresumeMax: ((Number($("s-autoresumeMax").value) || 24) >= AUTO_RESUME_FLOOR ? (Number($("s-autoresumeMax").value) || 24) : 24), emptyRoundMax: (parseInt($("s-emptyRoundMax").value,10)>=0?parseInt($("s-emptyRoundMax").value,10):2),   // 2026-11 plan-A: below the floor -> back to the default
              archiveOn: $("s-archiveon").getAttribute("aria-checked") === "true",
              cnThink: $("s-cnthink").getAttribute("aria-checked") === "true",
              stepsFold: $("s-stepsfold").getAttribute("aria-checked") === "true",
              designLang: $("s-designlang").value || "auto",
              persona: $("s-persona").value.trim()};
  store.set("sampling", settings);
  const share = $("s-share").getAttribute("aria-checked") === "true";
  openDrawer(false);
  if (share || sharedOn) {
    try {
      await saveShared(share, settings);
      toast("success", t("toast.sampling.saved.title"),
            share ? t("toast.sampling.share.msg") : t("toast.sampling.unshare.msg"));
    } catch (e) {
      toast("error", t("toast.sampling.partial.title"), e.message, 6000);
    }
    return;
  }
  toast("success", t("toast.sampling.saved.title"),
        settings.temperature === 0 ? t("toast.sampling.greedy.msg") : "");
};
$("sampling-btn").onclick = () => openDrawer(true);
$("drawer-close").onclick = () => openDrawer(false);
$("scrim").onclick = () => openDrawer(false);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("drawer").dataset.open === "true") openDrawer(false); });
// Step1-G: debug drawer controls
$("debug-copy").onclick = () => copyDebugEvidence();
$("debug-diagnose").onclick = () => diagnoseStream();
$("debug-curl").onclick = () => copyRequestCurl();

// debug sub-tabs: independent state, same visual paradigm as the memory page
let debugSubTab = "bugbox";
function applyDebugSubTab(){
  const cur = debugSubTab || "live";
  for (const b of document.querySelectorAll(".db-subtab")) b.setAttribute("aria-selected", String(b.dataset.db === cur));
  for (const c of document.querySelectorAll(".db-tabpanel")) c.classList.add("is-active");   // anchor nav: all panels stay shown; the sub-tab is the highlight, not a hide-switch
}
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest(".db-subtab");
  if (!b) return;
  debugSubTab = b.dataset.db; applyDebugSubTab();
  const card = document.querySelector('.db-tabpanel[data-db="' + b.dataset.db + '"]');
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });   // anchor nav: scroll to the section
});
// Layer 4 action wiring: event delegation on the debug drawer for every [data-bugact] control.
if ($("bugbox-expandall")) $("bugbox-expandall").onclick = () => bugBoxExpandAll(true);
if ($("bugbox-foldall")) $("bugbox-foldall").onclick = () => bugBoxExpandAll(false);

// One-shot physical merge of same-signature rows already sitting in the box (the capture-time
// signature merge only protects FUTURE triggers; the existing pile predates it). Writes the
// localStorage mirror only -- the gateway JSONL stays the append-only archive, untouched.
function _bugboxMergeDups() {
  const all = bugBoxEntries();
  const bySig = new Map(); const keep = [];
  for (const e of all) {
    const sig = bugBoxSigKey(e);
    let g = bySig.get(sig);
    if (!g) { g = Object.assign({}, e); g.count = (e.count || 1); bySig.set(sig, g); keep.push(g); }
    else { g.count = (g.count || 1) + (e.count || 1); if (e.ts > g.ts) g.ts = e.ts; }   // rep row shows the newest ts
  }
  const saved = all.length - keep.length;   // rows physically folded away
  if (saved <= 0) { toast("info", t("debug.bugbox.mergedup"), t("debug.bugbox.noopen")); return; }
  bugBoxSave(keep);
  renderBugBox();
  toast("success", t("debug.bugbox.mergedup"), t("debug.bugbox.mergedup.done", { n: saved }));
}

function _bugboxClearAll() {
  const all = bugBoxEntries();
  if (!all.length) { toast("info", t("debug.bugbox.clearall"), t("debug.bugbox.empty")); return; }
  if (typeof window.confirm === "function") {
    try { if (!window.confirm(t("debug.bugbox.clearall.confirm", {n: all.length}))) return; } catch (e) { /* jsdom: ignore */ }
  }
  const backup = all.slice();
  bugBoxSave([]);
  renderBugBox();
  toast("info", t("debug.bugbox.clearall"), t("debug.bugbox.clearall.done", {n: backup.length}), 5000, {label: t("toast.undo"), run: () => { bugBoxSave(backup); renderBugBox(); }});
}
if ($("bugbox-mergedup")) $("bugbox-mergedup").onclick = _bugboxMergeDups;
if ($("bugbox-clearall")) $("bugbox-clearall").onclick = _bugboxClearAll;
function _bugboxManualAdd(){
  const m=$("bugbox-addmodal"); if (!m) return;
  const ti=$("bugbox-am-title"), de=$("bugbox-am-desc"), no=$("bugbox-am-note");
  ti.value=""; de.value=""; no.value="";         // fresh form each open
  m.hidden=false; ti.focus();
}

if ($("bugbox-addman")) $("bugbox-addman").onclick = _bugboxManualAdd;

// Manual-add card modal: collect three fields in ONE form (replaces the 3x window.prompt UX).
function _bugboxAddModalClose(){ const m=$("bugbox-addmodal"); if(m) m.hidden=true; }
async function _bugboxAddModalSubmit(){
  try { await Promise.all(pendingPastes); } catch(e){}
  const title=(($("bugbox-am-title").value)||"").trim();
  if (!title){ toast("info", t("debug.bugbox.addman"), t("debug.bugbox.empty")); return; }
  const descHtml=($("bugbox-am-desc").innerHTML)||"";   // CE -> rich text incl. pasted thumbnails
  const descText=($("bugbox-am-desc").textContent||"").trim();
  const note=($("bugbox-am-note").value||"").trim();
  let msg=title; if (descText) msg += " \u2014 "+descText; if (note) msg += " ["+note+"]";
  const hasImg=/<img[\s>]/i.test(descHtml);
  let msgHtml="";
  if (hasImg){ msgHtml = esc(title) + (sanitizeHtml(descHtml)? " \u2014 "+sanitizeHtml(descHtml):"") + (note? " ["+esc(note)+"]":""); }
  const rec = {
    ts: Date.now(), sig: msg, count: 1, kind: "bug:manual", status: "open", origin: "ui-manual",
    sourceTab: (typeof tab !== "undefined" ? tab : null), session: (typeof activeId !== "undefined" ? activeId : null), msg, stack: "", msgHtml,
    mTitle: title, mDescHtml: hasImg? sanitizeHtml(descHtml): descText, mNote: note,
  };
  bugBoxSave(bugBoxEntries().concat([rec]).slice(-BUGBOX_MAX));
  try { postQuiet("api/interrupt-log", { entry: rec }); } catch (e) {}
  renderBugBox(); _bugboxAddModalClose();
  toast("success", t("debug.bugbox.addman"), t("debug.bugbox.addman.done"));
}
if ($("bugbox-am-ok")) $("bugbox-am-ok").onclick = _bugboxAddModalSubmit;
let _editingTs=null;   // modal opened to EDIT an existing manual row (null => create)
function openAddModalForEdit(ts){
  const e=bugBoxFindByTs(ts); if(!e) return;
  _editingTs=String(ts);
  $("bugbox-am-title").value=(e.mTitle!=null?e.mTitle:(e.msg||""));
  const de=$("bugbox-am-desc"); if(/<img/i.test(e.mDescHtml||"")) de.innerHTML=sanitizeHtml(e.mDescHtml); else de.textContent=(e.mDescHtml||"");
  $("bugbox-am-note").value=(e.mNote!=null?e.mNote:"");
  $("bugbox-addmodal").hidden=false; $("bugbox-am-title").focus();
}

async function _bugboxPasteImg(e){
  const cd=e.clipboardData||window.clipboardData; if(!cd) return;
  let files=[...(cd.files||[])].filter(f=>f&&f.type&&f.type.startsWith("image/"));
  if(!files.length&&typeof cd.items==="object") files=[...cd.items].filter(it=>it&&it.kind==="file"&&it.type&&it.type.startsWith("image/")).map(it=>(typeof it.getAsFile==="function"?it.getAsFile():null)).filter(Boolean);
  if(!files.length) return; e.preventDefault();
  const box=$("bugbox-am-desc"); for(const f of files){ const dataUrl=await new Promise(r=>{const rd=new FileReader();rd.onload=()=>r(String(rd.result));rd.readAsDataURL(f);});
    const nm=f.name||"pasted"; const span=document.createElement("span"); span.className="ce-thumb"; span.setAttribute("contenteditable","false"); span.title=nm;
    span.innerHTML='<span class="ce-thumb__box"><img class="inline-ce-img" src="'+dataUrl+'" alt="'+esc(nm)+'"></span>'; box.appendChild(span);
  }
}
if ($("bugbox-am-desc")) $("bugbox-am-desc").addEventListener("paste",(e)=>_bugboxPasteImg(e));
if ($("bugbox-am-cancel")) $("bugbox-am-cancel").onclick = _bugboxAddModalClose;
if ($("bugbox-addmodal-close")) $("bugbox-addmodal-close").onclick = _bugboxAddModalClose;
if ($("bugbox-addmodal")) $("bugbox-addmodal").addEventListener("click", (e)=>{ if(e.target===$("bugbox-addmodal")) _bugboxAddModalClose(); });

if ($("bugbox-search")) {
    $("bugbox-search").addEventListener("input", () => renderBugBox());
    $("bugbox-search").addEventListener("compositionend", () => renderBugBox());   // IME: CJK filter must refresh on commit
}
if ($("bugbox-filter")) $("bugbox-filter").addEventListener("change", () => renderBugBox());

// Manual entry points for the bug-box autofix. The edge-triggered loop (autofixTick on
// setBusy(false)) is unchanged -- it still drives "fix the next one when a turn ends idle".
// These buttons add a deterministic "do it now" trigger so the user does not have to wait on
// an edge or a reload. They reuse existing helpers (bugBoxEntries / pushBugFix / setBugStatus),
// so no new fix logic is introduced.
let _autofixPollTimer = null;
function _autofixFixOneNow(){
  const open = bugBoxEntries().filter((x) => !x.status || x.status === "open").sort((a, b) => a.ts - b.ts);
  if (!open.length){ toast("info", t("debug.bugbox.fixone"), t("debug.bugbox.noopen")); return; }
  pushBugFix(String(open[0].ts));   // pushBugFix guards busy, marks fixing, and sends
}
function _autofixPollTick(){
  if (busy) return;                                  // idle-slot discipline: never interrupt a live task
  const open = bugBoxEntries().filter((x) => !x.status || x.status === "open").sort((a, b) => a.ts - b.ts);
  if (!open.length){ _autofixStopPoll(); return; }    // box drained -> auto-stop
  pushBugFix(String(open[0].ts));
}
function _autofixSetStopVisible(on){
  const s = $("bugbox-stopall"); const f = $("bugbox-fixall");
  if (s) s.style.display = on ? "" : "none";
  if (f) f.style.display = on ? "none" : "";
}
function _autofixStartPoll(){
  if (_autofixPollTimer) return;
  toast("success", t("debug.bugbox.fixall"), t("debug.bugbox.fixallstarted"));
  _autofixSetStopVisible(true);
  _autofixPollTimer = setInterval(_autofixPollTick, 1500);
  _autofixPollTick();
}
function _autofixStopPoll(){
  if (_autofixPollTimer){ clearInterval(_autofixPollTimer); _autofixPollTimer = null; }
  _autofixSetStopVisible(false);
}
if ($("bugbox-fixone")) $("bugbox-fixone").onclick = () => _autofixFixOneNow();
if ($("bugbox-fixall")) $("bugbox-fixall").onclick = () => _autofixStartPoll();
if ($("bugbox-stopall")) $("bugbox-stopall").onclick = () => _autofixStopPoll();

// Bound once on the container so it survives renderBugBox re-renders.
const _bugDrawerEl = $("view-debug");
if (_bugDrawerEl && !_bugDrawerEl._bugWired) {
  _bugDrawerEl._bugWired = true;
  _bugDrawerEl.addEventListener("click", (e) => {
    const more0 = e.target.closest && e.target.closest("[data-bugmore]");
    if (more0) { BUGBOX_SHOW_LIMIT += 50; renderBugBox(); return; }   // perf: load-more (mirrors KB_SHOW_LIMIT)
    // ACTION BUTTONS live INSIDE the toggleable row, so match them FIRST. A click on a button must run
    // its action (copy / diagnose / push / dismiss) — not merely toggle the row. The old order matched
    // the row container first and returned, silently swallowing every in-row button click.
    const btn = e.target && e.target.closest ? e.target.closest("[data-bugact]") : null;
    if (btn) {
      const ts = btn.dataset.bugts;
      if (ts != null) {
        const act = btn.dataset.bugact;
        if (act === "copy") copyBugEvidence(ts);
        else if (act === "diagnose") diagnoseBugCard(ts);
        else if (act === "push") pushBugFix(ts);
        else if (act === "dismiss") dismissBug(ts);
        else if (act === "edit") openAddModalForEdit(ts);
      }
      return;   // a button click never toggles the row
    }
    if (e.target.closest && e.target.closest(".ce-thumb")) return;   // 2026-11-XX: a click on an inline thumbnail must NOT fold the row (double-click opens the viewer); guard before the toggle match.
    const row0 = e.target.closest && e.target.closest("[data-bugtoggle]");
    if (row0) { const key = row0.getAttribute("data-bugtoggle"); if (bugBoxExpanded.has(key)) bugBoxExpanded.delete(key); else bugBoxExpanded.add(key); expandSetSave('strata.bugBoxExpanded', bugBoxExpanded); renderBugBox(); return; }   // default-collapsed rows expand on click (persisted)
  });
}


// ------------------------------------------------------------------ start
setBusy(false);
renderChat();
const startQuestion = new URLSearchParams(location.search).get("q");   // /?q=... starts a chat (a shortcut)
if (startQuestion) history.replaceState(null, "", location.pathname + location.hash);
loadHealth().then(loadMcp).then(() => { if (startQuestion) { ceSetText($("input"), startQuestion); send(); } });
showTab(location.hash.slice(1) || "chat");
poll();

// ------------------------------------------------------------------ images (POST /v1/images/generations)
$("img-form").onsubmit = async (ev) => {
  ev.preventDefault();
  const prompt = $("img-prompt").value.trim();
  if (!prompt) return;
  const body = {prompt, size: $("img-size").value, response_format: "b64_json"};
  if ($("img-seed").value !== "") body.seed = Number($("img-seed").value);
  $("img-go").disabled = true;
  const t0 = performance.now();
  $("img-hint").textContent = t("img.generating");
  try {
    const r = await fetch("v1/images/generations", {method: "POST", headers: headers(true), body: JSON.stringify(body)});
    const j = await r.json();
    if (!r.ok) throw new Error((j.error && j.error.message) || r.statusText);
    for (const d of j.data) {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = "data:image/png;base64," + d.b64_json;
      img.alt = prompt;
      const cap = document.createElement("figcaption");
      cap.textContent = `${j.size}, seed ${d.seed}, ${((performance.now() - t0) / 1000).toFixed(0)} s: ${prompt}`;
      fig.append(img, cap);
      $("img-results").prepend(fig);
    }
    $("img-hint").textContent = t("img.done");
  } catch (e) {
    $("img-hint").textContent = "";
    toast("error", t("toast.noimage.title"), String(e.message || e), 8000);
  } finally {
      $("img-go").disabled = false;
  }
};

// ------------------------------------------------------------------ P3-2: Schedule panel
async function loadSchedule() {
  if (!mcpInfo.tools) return;
  const list = $("schedule-list");
  try {
    // schedule/list answers with one JSON object per line (or "no schedule entries")
    const text = await mcpText("schedule", "list", {});
    if (!text || text === "no schedule entries") {
      list.innerHTML = '<div class="sched-row muted">' + t("sched.none") + '</div>';
      return;
    }
    const entries = text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line); } catch (e) { return null; } }).filter(Boolean);
    if (!entries.length) { list.innerHTML = '<div class="sched-row muted">' + t("sched.none") + '</div>'; return; }
    list.innerHTML = entries.map((e) => `<div class="sched-row">` +
      `<span class="sched-row__name" title="${esc(e.task || "")}">${esc(e.name)}</span>` +
      `<span class="sched-row__trigger">${esc(e.trigger)}</span>` +
      `<span class="sched-row__next">${esc(e.next)}</span>` +
      `<span class="sched-row__status${e.last_run ? (e.last_run.ok ? " ok" : " fail") : ""}">${e.last_run ? (e.last_run.ok ? "✓" : "✗") : "–"}</span>` +
      `<button class="st-btn st-btn--icon st-btn--icon-sm" data-sched-del="${esc(e.name)}" aria-label="${esc(t("attach.remove"))}" title="${esc(t("attach.remove"))}">${icon("trash")}</button></div>`).join("");
  } catch (e) { list.innerHTML = '<div class="sched-row muted">' + t("sched.loadfailed") + '</div>'; }
}

$("schedule-panel").addEventListener("click", async (e) => {
  const del = e.target.closest("[data-sched-del]");
  if (del) {
    const nm = del.dataset.schedDel;
    if (!confirm(t("sched.del.confirm", {nm}))) return;
    try {
      await mcpCall("schedule", "remove", {name: nm});   // throws when the tool fails
      loadSchedule();
    } catch (e2) { toast("error", t("toast.removefailed.title"), e2.message, 4000); }
  }
});

$("schedule-add").onclick = () => { $("sched-modal").hidden = false; $("sched-name").focus(); };
$("sched-close").onclick = () => { $("sched-modal").hidden = true; };
$("sched-modal").addEventListener("click", (e) => { if (e.target.id === "sched-modal") $("sched-modal").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sched-modal").hidden) $("sched-modal").hidden = true; });

$("sched-apply").onclick = async () => {
  const name = $("sched-name").value.trim();
  const task = $("sched-task").value.trim();
  const mode = $("sched-mode").value;
  const value = $("sched-value").value.trim();
  if (!name || !task || !value) { toast("warn", t("toast.fillall.title"), t("toast.fillall.msg")); return; }
  const args = {name, task};
  if (mode === "every_minutes") args.every_minutes = parseInt(value, 10);
  else if (mode === "every_hours") args.every_hours = parseInt(value, 10);
  else if (mode === "daily_at") args.daily_at = value;
  else if (mode === "at") args.at = value;
  try {
    const msg = await mcpText("schedule", "add", args) || "Added";
    toast("success", t("toast.schedadded.title"), msg);
    $("sched-modal").hidden = true;
    $("sched-name").value = ""; $("sched-task").value = ""; $("sched-value").value = "";
    loadSchedule();
  } catch (e2) { toast("error", t("toast.addfailed.title"), e2.message, 4000); }
};

// Trigger placeholder updates on mode change
$("sched-mode").addEventListener("change", () => {
  const ph = {every_minutes: "30", every_hours: "6", daily_at: "09:00", at: "2026-10-20T09:00"};
  $("sched-value").placeholder = ph[$("sched-mode").value] || "";
});

// Load schedule panel on startup (after MCP info is available)
loadSchedule();

// ================================================================== P4-3: Right-click context menu on messages & tool blocks
// The CSS (.st-ctx-menu) already exists; this wires the element + behaviour.
// NOTE: the sidebar tree uses its own reusable `popMenu` (same styles, different owner), so this one is msgCtxMenu.
const msgCtxMenu = document.createElement("div");
msgCtxMenu.id = "ctx-menu-msg";
msgCtxMenu.className = "st-ctx-menu";
msgCtxMenu.hidden = true;
document.body.appendChild(msgCtxMenu);

function closeCtxMenu() { msgCtxMenu.hidden = true; }

function openCtxMenu(x, y, items) {
  msgCtxMenu.innerHTML = "";
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    if (it.danger) b.className = "danger";
    b.innerHTML = (it.icon ? icon(it.icon, "st-icon st-icon--sm") : "") + `<span>${esc(it.label)}</span>`;
    b.onclick = () => { closeCtxMenu(); it.run(); };
    msgCtxMenu.appendChild(b);
  }
  msgCtxMenu.hidden = false;
  const r = msgCtxMenu.getBoundingClientRect();
  msgCtxMenu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  msgCtxMenu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}

function deleteMessage(i) {
  if (busy && busy.msg === messages[i]) { toast("warn", t("toast.busy.title"), t("toast.busy.msg")); return; }
  if (typeof window.confirm === "function") {
    try { if (!window.confirm(t("ctx.delete.confirm"))) return; } catch (e) { /* jsdom: ignore */ }
  }
  const removed = messages[i];
  messages.splice(i, 1);
  saveChat();
  renderChat();
  toast("info", t("toast.msgdeleted.title"), "", 5000, {label: t("toast.undo"), run: () => { messages.splice(i, 0, removed); saveChat(); renderChat(); }});
}

$("chat").addEventListener("contextmenu", (e) => {
  const msgNode = e.target.closest(".st-msg");
  if (!msgNode) return;                     // default menu outside messages
  e.preventDefault();
  const i = +msgNode.dataset.i;
  const m = messages[i];
  if (!m) return;
  const items = [];
  const selTxt = (window.getSelection && window.getSelection().toString() || "").trim();
  if (selTxt) items.push({label: t("ctx.copy.selection"), icon: "copy", run: () => copyText(selTxt)});   // selection first: it is what the user highlighted
  const toolEl = e.target.closest(".tool-call");
  if (toolEl) {
    const k = +toolEl.dataset.tool;
    // `tool`, not `t` — `t` is the i18n helper and this block needs it for the labels below.
    const tool = m.tools && m.tools[k];
    if (tool) {
      const args = tool.arguments == null ? "" : JSON.stringify(tool.arguments, null, 2);
      const res = tool.result != null ? tool.result : "";
      const name = tool.tool || tool.name || "";
      if (args) items.push({label: t("ctx.copy.args"), icon: "copy", run: () => copyText(args)});
      if (res) items.push({label: t("ctx.copy.result"), icon: "copy", run: () => copyText(res)});
      if (name) items.push({label: t("ctx.copy.name"), icon: "copy", run: () => copyText(name)});
      items.push({label: tool.open ? t("ctx.collapse") : t("ctx.expand"), icon: "chevron",
                  run: () => { tool.open = !tool.open; updateAssistant(msgNode, m, !!busy && busy.msg === m); }});
    }
  } else if (m.role === "user") {
    items.push({label: t("ctx.copy"), icon: "copy", run: () => copyText(m.text)});
    items.push({label: t("ctx.edit"), icon: "edit", run: () => openEditModal(i)});
    items.push({label: t("ctx.delete"), icon: "trash", danger: true, run: () => deleteMessage(i)});
  } else {
    items.push({label: t("ctx.copy.answer"), icon: "copy", run: () => copyText(m.text)});
    items.push({label: t("ctx.regen"), icon: "regenerate", run: () => doRegenerate(i)});
    items.push({label: t("ctx.delete"), icon: "trash", danger: true, run: () => deleteMessage(i)});
  }
  if (items.length) openCtxMenu(e.clientX, e.clientY, items);
});
document.addEventListener("click", (e) => { if (!msgCtxMenu.contains(e.target)) closeCtxMenu(); });
document.addEventListener("scroll", closeCtxMenu, true);
window.addEventListener("resize", closeCtxMenu);

// ================================================================== P4-4: Keyboard shortcuts — single source for the hints bar + global bindings
const SHORTCUTS = [
  {combo: "Enter", i18n: "kbd.send"},
  {combo: "Shift+Enter", i18n: "kbd.newline"},
  {combo: "/", i18n: "kbd.commands"},
  {combo: "Ctrl+K", i18n: "kbd.newchat", run: () => { if (!busy) $("new-btn").click(); }},
  {combo: "Ctrl+L", i18n: "kbd.clear", run: () => { ceSetText($("input"), ""); $("input").focus(); }},
  {combo: "Esc", i18n: "kbd.close"},
  {combo: "Drop", i18n: "kbd.drop"},
];
function renderKbdHints() {
  const el = $("kbd-hints");
  if (!el) return;
  el.innerHTML = SHORTCUTS.map((s) => `<span class="kbd-hints__item"><kbd>${esc(s.combo)}</kbd> ${esc(t(s.i18n))}</span>`).join("");
}
// P4-4b: the 7-item hints bar is collapsed into a popover — open it from the "?" button or the "?" key,
// close it with Esc or an outside click. Guard the "?" key so it still types normally inside the input.
function toggleKbdHints(force) {
  const el = $("kbd-hints"); if (!el) return;
  const open = force != null ? force : !el.classList.contains("open");
  el.classList.toggle("open", open);
}
function bindKbdHints() {
  const btn = $("kbd-help");
  if (btn) btn.onclick = (e) => { e.stopPropagation(); toggleKbdHints(); };
  document.addEventListener("click", (e) => {
    const el = $("kbd-hints");
    if (el && el.classList.contains("open") && !el.contains(e.target) && e.target.id !== "kbd-help") toggleKbdHints(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { toggleKbdHints(false); return; }
    if (e.key !== "?" || e.metaKey || e.ctrlKey) return;
    const ae = document.activeElement;
    if (ae && (ae.id === "input" || ae.tagName === "TEXTAREA" || isCE(ae))) return;   // let "?" type normally (incl. contenteditable inputs)
    e.preventDefault();
    toggleKbdHints();
  });
}
function bindGlobalKeys() {
  document.addEventListener("keydown", (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && (e.key === "k" || e.key === "K")) { e.preventDefault(); if (!busy) $("new-btn").click(); return; }
    if (meta && (e.key === "l" || e.key === "L")) { e.preventDefault(); ceSetText($("input"), ""); $("input").focus(); return; }
  });
}

// ================================================================== Config fallback: /config.json can seed the API key when the browser has none
async function applyConfigFallback() {
  try {
    const r = await fetch("config.json", {cache: "no-store"});
    if (!r.ok) return;
    const cfg = await r.json();
    if (cfg.apiKey && !store.get("apikey", "")) {
      store.set("apikey", cfg.apiKey);
      const ak = $("api-key");
      if (ak) ak.value = cfg.apiKey;
    }
  } catch (e) { /* config.json not served in this mode — ignore */ }
}

// ================================================================== Language switching
// applyI18n() (inside i18n.js) already refreshed every static [data-i18n] node.
// Everything app.js *renders* has to be repainted here, because those strings were
// baked into the DOM at the old language. Message content is user/model data and is
// deliberately left alone — only labels, hints and the chrome around them change.
document.addEventListener("strata:langchange", () => {
  // If i18n.js never loaded, there is nothing to repaint — bail out quietly so a
  // translation-layer failure can't take the rest of the UI down with it.
  if (!window.i18n) return;
  renderKbdHints();
  renderMcp();
  if (lastMetrics) render(lastMetrics);
  if (typeof renderChat === "function" && messages.length) renderChat();
  if (typeof renderSessions === "function") renderSessions();
  if (typeof renderKb === "function") renderKb();
  if (typeof renderSchedule === "function") renderSchedule();
  if (typeof renderAttachments === "function") renderAttachments();
  if (typeof renderRulesBanner === "function") renderRulesBanner();     // banner labels + merge count
  if (typeof renderDesignBanner === "function") renderDesignBanner();
  if (typeof loadConfig === "function" && tab === "about") loadConfig();
  if (tab === "spark") renderSpark();       // labels in the list are baked at render time
  // admin.js repaints the Tools tab itself; it listens to the same event.
  // refresh the health-derived subtitle, which embeds the model name
  $("chat-empty-sub").textContent = t("chat.empty.sub.model", {model: health.model});
  $("attach-btn").title = health.images ? t("chat.attach.images") : t("chat.attach");
});

// --- wire the two switchers (header button + About select) ---
(function bindLanguageControls() {
  const btn = $("lang-btn");
  if (btn) btn.onclick = () => window.i18n && window.i18n.toggleLang();
  const sel = $("lang-select");
  if (sel) sel.onchange = () => window.i18n && window.i18n.setLang(sel.value);
  if (window.i18n) window.i18n.syncSwitchers();
})();

// --- P4-3 / P4-4 init ---
renderKbdHints();
bindGlobalKeys();
bindKbdHints();
bindInlineThumbDelete();   // composer #input is static in index.html -> wire its inline-thumbnail delete now (the modal side is wired from openEditModal once #edit-area exists)
bindSparks();
applyConfigFallback();
// first paint of the static markup into the saved language
if (window.i18n) window.i18n.applyI18n();
// the model list lives on the server; the chip appears as soon as it answers
loadModels();
// pull the live idle-timeout ceiling so the tool timer matches the backend watchdog (no-op if 404)
refreshIdleTimeout();


// ------------------------------------------------------------------ memory sub-tabs
// knowledge / rules / notes / global: show one panel at a time (delegated click;
// the panel DOM is filled by renderMemory() and only its visibility toggles here).
// Memory page is now a vertical stack: all category cards visible at once, each collapsible
// to just its title row (the sub-tabs scroll to / expand the target card). Collapse state is
// persisted in localStorage (key strata.memCollapse) so it survives reloads.
var memCollapsed = {};
try { memCollapsed = JSON.parse(localStorage.getItem("strata.memCollapse") || "{}") || {}; } catch (e) { memCollapsed = {}; }
function applyMemSubTab(){
  for (const c of document.querySelectorAll(".mem-tabpanel")){
    c.classList.add("is-active");
    c.classList.toggle("is-collapsed", !!memCollapsed[c.dataset.mem]);
  }
  for (const b of document.querySelectorAll(".mem-subtab")) b.setAttribute("aria-selected", "false");
}
// delegated click: a card title row toggles collapse; a sub-tab scrolls to + expands its card.
document.addEventListener("click", (e) => {
  const head = e.target.closest && e.target.closest(".mem-tabpanel>.req-head");
  if (head){
    if (e.target.closest && e.target.closest("button,input,label,select,a")) return;   // interactive controls operate themselves, never fold the card
    const card = head.closest(".mem-tabpanel"); const key = card.dataset.mem;
    memCollapsed[key] = !memCollapsed[key];
    try { localStorage.setItem("strata.memCollapse", JSON.stringify(memCollapsed)); } catch (e2) {}
    card.classList.toggle("is-collapsed", !!memCollapsed[key]);
    return;
  }
  const b = e.target.closest && e.target.closest(".mem-subtab");
  if (!b) return;
  const card = document.querySelector('.mem-tabpanel[data-mem="' + b.dataset.mem + '"]');
  if (card){ if (memCollapsed[b.dataset.mem]){ memCollapsed[b.dataset.mem] = false; try { localStorage.setItem("strata.memCollapse", JSON.stringify(memCollapsed)); } catch (e2) {} } card.classList.remove("is-collapsed"); card.scrollIntoView({behavior:"smooth", block:"start"}); }
});
applyMemSubTab();  // first paint: every card shows, restored to its saved collapse state
// B1 two-state preview for the recommended-only sub-checkbox: highlights which tier is active.
// ON = recommended only (checkbox checked); OFF = recommended + normal (checkbox unchecked).
// Text lives on the two data-i18n spans (filled by applyI18n); this only flips data-state.

// Cold-start sweep: an idle-only loop driven purely by the busy->idle edge never fires on a
// fresh load (busy starts null, so no edge is ever crossed). Re-run the autofix check once at
// boot; it carries its own guards (autofix on + idle + at least one open), so it stays a no-op
// when those aren't met -- this only closes the "ready but never crossed an edge" dead zone.
setTimeout(autofixTick, 0);

// Source-of-truth reconciliation (方案1): the array is what gets SENT. Whatever dropped a chip
// from the DOM -- hover button, Backspace on a focused chip, OR the browser's own native
// Backspace delete of a contenteditable=false atomic chip (which never routes through our
// handler and never splices the array) -- the array must end up matching the DOM. Drop every
// array entry whose pid is no longer present in the box. Idempotent for our own paths.
function reconcileArray(box) {
  const isModal = box.id === "edit-area";
  const list = isModal ? editAttachments : attachments;
  const present = new Set([].slice.call(box.querySelectorAll("[data-pid]")).map((n) => n.getAttribute("data-pid")));
  // A chip may also be represented only by an [img:N] text anchor (insertPlaceholder fallback when
  // there is no url to thumbnail). That is still "present on screen", so it must NOT be dropped.
  const txt = box.textContent || "";
  let am;
  const are = /\[img:(\d+)\]/g;
  while ((am = are.exec(txt))) present.add(am[1]);
  for (let k = list.length - 1; k >= 0; k--) { if (!present.has(String(list[k].pid))) list.splice(k, 1); }
}
// Double-safety net (方案2): when the browser removes an inline chip from the DOM on its own
// (native Backspace on a contenteditable=false atomic node), splice the array to match.
function attachChipObserver(box) {
  if (!box || box._chipObsBound) return;
  const mo = new MutationObserver(() => reconcileArray(box));
  mo.observe(box, { childList: true, subtree: true });
  box._chipObsBound = true;
}

// ============================ garbage recycle (debug page card) ============================
// Sends to the REAL Windows Recycle Bin via the backend (/api/recycle, Shell.Application COM).
// Never a physical delete: scan candidates, send checked to the bin, restore to origin, audit.
const RECYCLE_LIST_LIMIT = 30;   // perf: rows per card before load-more (mirrors KB_SHOW_LIMIT)
let recycleBinData = [], recycleAuditData = [];
let recycleBinLimit = RECYCLE_LIST_LIMIT, recycleAuditLimit = RECYCLE_LIST_LIMIT;
function populateRecycleControls() {
  const sel = $("recycle-ws");
  if (sel) {
    const seen = [];
    for (const s of sessions) { const w = s.workspace; if (w && !seen.some((x) => x.toLowerCase() === w.toLowerCase())) seen.push(w); }
    const cur = (activeSession() || {}).workspace;
    if (cur && !seen.some((x) => x.toLowerCase() === cur.toLowerCase())) seen.push(cur);
    sel.innerHTML = '<option value="__this__">' + esc(t("recycle.scope.this")) + '</option>' + seen.map((w) => '<option value="' + esc(w) + '">' + esc(w) + '</option>').join("");
    sel.value = store.get("recycle.ws", "__this__");
    if (sel.selectedIndex < 0) sel.value = "__this__";
  }
  const rs = $("recycle-retention");
  if (rs) { rs.value = String(store.get("recycle.retention", 72)); if (rs.selectedIndex < 0) rs.value = "72"; }
  const savedCats = store.get("recycle.cats", null);
  if (sel && Array.isArray(savedCats)) document.querySelectorAll(".recycle-cat").forEach((c) => { c.checked = savedCats.indexOf(c.dataset.cat) >= 0; });
}
function resolveRecycleWs(s) {
  const sel = $("recycle-ws");
  const v = sel ? sel.value : "__this__";
  if (v && v !== "__this__") return v.replace(/\/$/, "");
  return (s && s.workspace) ? s.workspace.replace(/\/$/, "") : "";
}
function recycleCheckedCats() {
  const boxes = document.querySelectorAll(".recycle-cat");
  if (!boxes.length) return null;
  const on = Array.from(boxes).filter((c) => c.checked).map((c) => c.dataset.cat);
  return on.length ? on : [];
}
function recycleRetentionH() {
  const rs = $("recycle-retention");
  return rs ? parseInt(rs.value, 10) || 72 : 72;
}
async function renderRecycle() {
  const box = $("recycle-list"); if (!box) return;
  const s = activeSession();
  populateRecycleControls();
  const ws = resolveRecycleWs(s);
  if (!ws) { box.innerHTML = '<div class="muted small">' + esc(t("recycle.no_ws")) + '</div>'; return; }
  box.dataset.ws = ws;
  const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws, categories: recycleCheckedCats(), retention_hours: recycleRetentionH()})});
  const j = await r.json();
  if (j.error) { box.innerHTML = '<div class="muted small">' + esc(t("recycle.err")) + '</div>'; return; }
  const cands = j.candidates || [];
  if (!cands.length) { box.innerHTML = '<div class="muted small">' + esc(t("recycle.empty")) + '</div>'; }
  else {
    box.innerHTML = '<div class="mem-kb-bar"><label class="spark-toolbar__check"><input type="checkbox" id="recycle-selall"><span>' + esc(t("recycle.sel.all")) + '</span></label><span class="spacer"></span><span class="muted small" id="recycle-selcount"></span></div>'
      + cands.map((c) => {
        const wb = c.whitelisted;
        return '<div class="mem-kb-item"><label class="kb-source" style="display:flex;align-items:center;gap:6px">'
          + '<input type="checkbox" class="recycle-ck" data-path="' + esc(c.path) + '" data-size="' + (c.size || 0) + '"' + (wb ? " disabled" : "") + '>'
          + '<span class="kb-source__name" title="' + esc(c.path) + '">' + esc(c.name) + '</span>'
          + '<span class="muted small">' + esc(c.source) + ' - ' + (c.size/1024).toFixed(1) + ' KB' + (wb ? ' - ' + esc(t("recycle.whitelisted")) : '') + '</span></label></div>';
      }).join("");
  }
  renderRecycleBin(ws);
  renderRecycleAudit(ws);
  updateRecycleSel();
}
async function renderRecycleBin(ws) {
  if (!$("recycle-bin")) return;
  const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "scan", workspace: ws})});
  const j = await r.json();
  recycleBinData = (j && j.in_bin) || [];
  paintRecycleBin();
}
function paintRecycleBin() {
  const box = $("recycle-bin"); if (!box) return;
  box.hidden = false;
  const head = '<div class="req-head"><span class="card-title">' + esc(t("recycle.bin.title")) + '</span></div>';
  if (!recycleBinData.length) { box.innerHTML = head + '<div class="muted small">' + esc(t("recycle.bin.empty")) + '</div>'; return; }
  const shown = recycleBinData.slice(0, recycleBinLimit);
  box.innerHTML = head + shown.map((p) => {
    const name = p.split(/[\\/]/).pop();
    return '<div class="mem-kb-item"><div class="kb-source" style="display:flex;align-items:center;gap:6px"><span class="kb-source__name" title="' + esc(p) + '">' + esc(name) + '</span>'
      + '<button class="st-btn st-btn--ghost st-btn--sm" data-recycle-restore="' + esc(name) + '">' + esc(t("recycle.restore")) + '</button></div></div>';
  }).join("") + recycleMoreBtn("bin", shown.length, recycleBinData.length);
}
async function renderRecycleAudit(ws) {
  if (!$("recycle-audit")) return;
  const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "audit", workspace: ws})});
  const j = await r.json();
  recycleAuditData = (j && j.audit) || [];
  paintRecycleAudit();
}
function paintRecycleAudit() {
  const box = $("recycle-audit"); if (!box) return;
  box.hidden = false;
  const head = '<div class="req-head"><span class="card-title">' + esc(t("recycle.audit.title")) + '</span></div>';
  if (!recycleAuditData.length) { box.innerHTML = head + '<div class="muted small">' + esc(t("recycle.audit.empty")) + '</div>'; return; }
  const rows = recycleAuditData.slice().reverse().slice(0, recycleAuditLimit);
  box.innerHTML = head + '<table class="st-table"><tbody>' + rows.map((e) => {
    const d = new Date((e.ts||0)*1000);
    return '<tr><td>' + esc(e.action) + '</td><td>' + esc(e.name||"") + '</td><td class="num">' + esc(d.toLocaleString()) + '</td></tr>';
  }).join("") + '</tbody></table>' + recycleMoreBtn("audit", rows.length, recycleAuditData.length);
}
function recycleMoreBtn(which, shown, total) {
  if (shown >= total) return "";
  return '<div style="margin-top:6px"><button class="st-btn st-btn--ghost st-btn--sm" data-recycle-more="' + which + '">'
    + esc(t("debug.bugbox.more", {n: total - shown})) + '</button></div>';
}
function recycleMore(which) {
  if (which === "bin") { recycleBinLimit += 30; paintRecycleBin(); }
  else { recycleAuditLimit += 30; paintRecycleAudit(); }
}
function recycleChecked() { return Array.from(document.querySelectorAll(".recycle-ck:checked")).map((c) => c.dataset.path); }
function fmtBytesSel(n) { return n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
function updateRecycleSel() {
  const boxes = document.querySelectorAll(".recycle-ck");
  const checked = document.querySelectorAll(".recycle-ck:checked");
  const el = $("recycle-selcount");
  if (el) {
    let bytes = 0;
    checked.forEach((c) => { bytes += parseInt(c.dataset.size || "0", 10) || 0; });
    el.textContent = checked.length + " " + t("recycle.selected")
      + (checked.length ? " · " + fmtBytesSel(bytes) : "");
  }
  // three-state select-all (spark precedent updateSelAllState): denominator = actionable rows
  const selall = $("recycle-selall");
  if (selall) {
    const total = document.querySelectorAll(".recycle-ck:not(:disabled)").length;
    selall.checked = total > 0 && checked.length === total;
    selall.indeterminate = checked.length > 0 && checked.length < total;
  }
}
if ($("recycle-ws")) $("recycle-ws").onchange = () => { store.set("recycle.ws", $("recycle-ws").value); renderRecycle(); };
if ($("recycle-retention")) $("recycle-retention").onchange = () => { store.set("recycle.retention", parseInt($("recycle-retention").value, 10) || 72); renderRecycle(); };
if ($("recycle-chips")) $("recycle-chips").addEventListener("change", (e) => {
  if (!e.target.classList.contains("recycle-cat")) return;
  store.set("recycle.cats", Array.from(document.querySelectorAll(".recycle-cat")).filter((c) => c.checked).map((c) => c.dataset.cat));
  renderRecycle();
});
if ($("recycle-scan")) $("recycle-scan").onclick = () => renderRecycle();
if ($("recycle-audit-refresh")) $("recycle-audit-refresh").onclick = () => { const ws = ($("recycle-list")||{}).dataset && $("recycle-list").dataset.ws; if (ws) renderRecycleAudit(ws); };
if ($("recycle-list")) $("recycle-list").addEventListener("change", (e) => {
  if (e.target.id === "recycle-selall") { document.querySelectorAll(".recycle-ck:not(:disabled)").forEach((c) => { c.checked = e.target.checked; }); }
  updateRecycleSel();
});
if ($("recycle-audit")) $("recycle-audit").addEventListener("click", (e) => {
  const mb = e.target.closest("[data-recycle-more]"); if (mb) recycleMore(mb.dataset.recycleMore);
});
let recycleJobId = null, recyclePollTimer = null;
function recycleProgressUi(show) {
  const row = $("recycle-progress-row"); if (!row) return;
  row.style.display = show ? "flex" : "none";
  if (!show) { const b = $("recycle-progress-bar"); if (b) b.style.width = "0%"; const tx = $("recycle-progress-text"); if (tx) tx.textContent = ""; const st = $("recycle-stop"); if (st) { st.disabled = false; } recycleJobId = null; }
}
function recycleSetProgress(done, total) {
  const b = $("recycle-progress-bar"); if (b) b.style.width = (total ? Math.round(done * 100 / total) : 0) + "%";
  const tx = $("recycle-progress-text"); if (tx) tx.textContent = t("recycle.progress").replace("{done}", String(done)).replace("{total}", String(total));
}
function recycleStopPoll() { if (recyclePollTimer) { clearTimeout(recyclePollTimer); recyclePollTimer = null; } }
async function recyclePollProgress() {
  if (!recycleJobId) return;
  let j;
  try {
    const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "progress", job_id: recycleJobId})});
    j = await r.json();
  } catch (e) { return; }
  if (!j || j.error) { recycleProgressUi(false); return; }
  recycleSetProgress((j.done || 0) + (j.skipped || 0) + (j.failed || 0) + (j.cancelled || 0), j.total || 0);
  if (j.finished) {
    recycleStopPoll();
    const msg = t("recycle.done").replace("{n}", String(j.done || 0))
      + ((j.failed || 0) ? t("recycle.failed").replace("{n}", String(j.failed)) : "")
      + ((j.cancelled || 0) ? t("recycle.cancelled").replace("{n}", String(j.cancelled)) : "");
    if (typeof toast === "function") toast(msg);
    recycleProgressUi(false);
    renderRecycle();
    return;
  }
  recyclePollTimer = setTimeout(recyclePollProgress, 400);
}
if ($("recycle-stop")) $("recycle-stop").onclick = async () => {
  if (!recycleJobId) return;
  const st = $("recycle-stop"); if (st) { st.disabled = true; st.textContent = t("recycle.stopping"); }
  try { await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "cancel", job_id: recycleJobId})}); } catch (e) {}
};
if ($("recycle-trash-sel")) $("recycle-trash-sel").onclick = async () => {
  const paths = recycleChecked(); if (!paths.length) return;
  if (!confirm(t("recycle.confirm").replace("{n}", String(paths.length)))) return;
  const ws = $("recycle-list").dataset.ws;
  const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "trash", workspace: ws, paths})});
  const j = await r.json();
  if (j && j.job_id) {           // large batch: background job -> show progress + stop, poll
    recycleJobId = j.job_id; recycleProgressUi(true); recycleSetProgress(0, j.total || paths.length);
    const st = $("recycle-stop"); if (st) { st.disabled = false; st.textContent = t("recycle.stop"); }
    recyclePollTimer = setTimeout(recyclePollProgress, 400);
    return;
  }
  if (typeof toast === "function") toast(j && j.trashed ? t("recycle.done").replace("{n}", String(j.trashed.length)) : t("recycle.none"));
  renderRecycle();
};
if ($("recycle-bin")) $("recycle-bin").addEventListener("click", async (e) => {
  const mb = e.target.closest("[data-recycle-more]"); if (mb) { recycleMore(mb.dataset.recycleMore); return; }
  const b = e.target.closest("[data-recycle-restore]"); if (!b) return;
  const ws = $("recycle-list").dataset.ws;
  const r = await fetch("api/recycle", {method: "POST", headers: headers(true), body: JSON.stringify({action: "restore", workspace: ws, paths: [b.dataset.recycleRestore]})});
  const j = await r.json();
  if (typeof toast === "function") toast(j && j.restored && j.restored.length ? t("recycle.restored") : t("recycle.restorefail"));
  renderRecycle();
});

// ---- ROOT-CAUSE A migration (2026-11-01, one-time, idempotent) -------------
// Historical spark notes (created before the data-pid inline-thumbnail anchor existed) store
// their image as a BARE img (valid src, NO data-pid anchor) in s.html. The list renders it fine
// via innerHTML, but sparkToPush only counts [data-pid] anchors, so such a note pushes text-only
// and the chat bubble drops the image (the reported "list shows, bubble drops" bug). We add the
// missing data-pid anchor to each bare img (sparkToPush accepts data-pid directly on an IMG),
// so the anchor is present and the bubble re-attaches. Purely additive: it changes nothing about
// notes that already have the anchor. Runs once at boot; re-running on already-migrated notes is
// a no-op. Gate: tests/test_spark_datapid_migrate.mjs.
function migrateSparkDataPid() {
  const arr = getSparks();
  let changed = 0;
  for (const s of arr) {
    if (!s || !s.html) continue;
    const d = document.createElement("div");
    d.innerHTML = s.html;
    let n = 0;
    d.querySelectorAll("img").forEach((img) => {
      if (img.hasAttribute("data-pid") || (img.closest && img.closest("[data-pid]"))) return; // already anchored
      n++;
      img.setAttribute("data-pid", "mig" + n);   // unique within the note; sparkToPush accepts pid on an IMG
    });
    if (n) { s.html = d.innerHTML; changed++; }
  }
  if (changed) setSparks(arr);
  return changed;
}
try { migrateSparkDataPid(); } catch (e) { /* localStorage read failed: skip migration this boot */ }
