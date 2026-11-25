/* i18n regression tests — static key hygiene + runtime switching.
 *
 * The failure mode this guards against is silent: a typo'd key renders the raw key
 * (or blanks a label), and a key added to only one language shows up in the other as
 * English text inside a Chinese UI. Both are invisible until someone looks closely,
 * so they are asserted here instead.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

// jsdom lives in the managed workspace, not next to this test.
const require = createRequire("E:/Nebula/NebulaBaize/");

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "serve", "web");
const read = (f) => readFileSync(join(WEB, f), "utf8");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "OK  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) FAILURES.push(label);
};

/* ── Load i18n.js in a sandbox (it expects browser globals) ────────────────── */
function loadI18n(storageSeed = null) {
  const mem = storageSeed ? new Map(Object.entries(storageSeed)) : new Map();
  const sandbox = {
    window: {},
    console,
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
    },
    document: { documentElement: {}, querySelectorAll: () => [] },
    CustomEvent: class { constructor(n, o) { this.type = n; this.detail = o && o.detail; } },
    Array, Object, String, JSON, Math, Error, RegExp, Map, Set, Symbol, Boolean, Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("i18n.js"), sandbox);
  return { i18n: sandbox.window.i18n, mem };
}

/* ═══════════════════════════ 1. dictionary hygiene ═══════════════════════════ */
console.log("=== 1. 字典键完备性 ===");
const { i18n } = loadI18n();
const dict = i18n._dict;
const zhKeys = Object.keys(dict.zh);
const enKeys = Object.keys(dict.en);

/* cfg.* keys translate the SERVER's run-config help text (GET /config). The English
 * UI reads the server text directly (app.js cfgHelp()), so the en dictionary
 * deliberately carries no cfg.* keys — exempt the prefix from the parity rule.
 * The exemption is a prefix match, so new backend keys are covered automatically. */
const SERVER_SOURCED = (k) => k.startsWith("cfg.") || k.startsWith("rt.");
const zhOwn = zhKeys.filter((k) => !SERVER_SOURCED(k));

check("两种语言键数一致（扣除服务端文案键）", zhOwn.length === enKeys.length,
      `zh(own)=${zhOwn.length} en=${enKeys.length}`);
const missingEn = zhKeys.filter((k) => !(k in dict.en) && !SERVER_SOURCED(k));
const missingZh = enKeys.filter((k) => !(k in dict.zh));
check("en 无缺失键", missingEn.length === 0, missingEn.slice(0, 5).join(", "));
check("zh 无缺失键", missingZh.length === 0, missingZh.slice(0, 5).join(", "));

const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const badPh = zhOwn.filter((k) => ph(dict.zh[k]) !== ph(dict.en[k]));
check("占位符在两种语言中一致", badPh.length === 0, badPh.slice(0, 3).join(", "));
const emptyZh = zhKeys.filter((k) => !String(dict.zh[k]).trim());
const emptyEn = enKeys.filter((k) => !String(dict.en[k]).trim());
check("无空翻译", emptyZh.length === 0 && emptyEn.length === 0,
      [...emptyZh, ...emptyEn].slice(0, 3).join(", "));

/* ═══════════════════ 2. every key used by the markup exists ═══════════════════ */
console.log("\n=== 2. HTML 引用的键都存在 ===");
const html = read("index.html");
const used = new Set();
for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
for (const m of html.matchAll(/data-i18n-html="([^"]+)"/g)) used.add(m[1]);
for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
  for (const pair of m[1].split(",")) {
    const parts = pair.split(":");
    if (parts.length === 2) used.add(parts[1].trim());
  }
}
const undefinedKeys = [...used].filter((k) => !(k in dict.zh));
check("data-i18n* 引用的键均已定义", undefinedKeys.length === 0, undefinedKeys.join(", "));

/* ═══════════ 3. the textContent trap: no marked node has element children ═══════════ */
console.log("\n=== 3. textContent 陷阱（标记节点不得含子元素）===");
const { JSDOM } = require("jsdom");
const staticDom = new JSDOM(html);
const trapped = [];
for (const el of staticDom.window.document.querySelectorAll("[data-i18n]")) {
  const kids = [...el.childNodes].filter((n) => n.nodeType === 1);
  if (kids.length) trapped.push(`${el.tagName.toLowerCase()}["${el.getAttribute("data-i18n")}"] -> ${kids.map((k) => k.tagName.toLowerCase()).join(",")}`);
}
check("data-i18n 节点无子元素（否则会抹掉图标/链接）", trapped.length === 0, trapped.slice(0, 4).join(" | "));

/* ══════════════ 4. keys referenced from JS exist in the dictionary ══════════════ */
console.log("\n=== 4. JS 中 t()/i18n: 引用的键都存在 ===");
/* Strip comments before scanning: code examples written inside comments (e.g.
 * `t("key")` in an explanatory note) look exactly like real call sites. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

/* Any quoted string starting with a known namespace counts as a key reference. This
 * catches all three call shapes uniformly — t("x.y"), i18n: "x.y", and the
 * ["css-class", "x.y"] tuples in MCP_STATE — without a regex per shape.
 * The namespace list mirrors the dictionary's own prefixes; a key typo'd into a new
 * namespace would otherwise escape this check entirely. */
const NS = "tab|hdr|side|chat|kbd|img|mon|metric|adm|about|drawer|ws|sched|appr|ctx|cmd|toast|unit|mcp|lang|attach|cfg|rt|design|insp|kb|mem|nav|nextsteps|req|rules|stat|tool";
const KEY_RE = new RegExp(`"((?:${NS})\\.[\\w.]+)"`, "g");
// localStorage keys (store.get/set("side.w") etc.) look exactly like i18n keys to the
// regex above but are NOT translations, so collect and exclude them from the check.
const STORAGE_RE = /(?:store\.(?:get|set)\(\s*|wKey:\s*|cKey:\s*)"([^"]+)"/g;
const jsFiles = ["app.js", "admin.js", "i18n.js"];
const jsUsed = new Set();
const storageKeys = new Set();
const dynamicPrefixes = new Set();
for (const f of jsFiles) {
  const src = stripComments(read(f));
  for (const m of src.matchAll(STORAGE_RE)) storageKeys.add(m[1]);
  for (const m of src.matchAll(KEY_RE)) {
    // t("mcp.state." + status) is a legitimate dynamic key: the literal is only a
    // prefix, never a key on its own. Skip it (trailing dot OR followed by `+`).
    const after = src.slice(m.index + m[0].length);
    if (m[1].endsWith(".") || /^\s*\+/.test(after)) { dynamicPrefixes.add(m[1]); continue; }
    jsUsed.add(m[1]);
  }
}
const jsMissing = [...jsUsed].filter((k) => !(k in dict.zh) && !storageKeys.has(k));
check("JS 引用的键均已定义", jsMissing.length === 0, jsMissing.join(", "));

const orphans = zhKeys.filter((k) => !SERVER_SOURCED(k) && !used.has(k) && !jsUsed.has(k));
console.log(`  （提示）定义了但未被引用: ${orphans.length} 个${orphans.length ? " -> " + orphans.slice(0, 6).join(", ") : ""}`);

/* ══════════════════════ 5. runtime: default zh, switch, persist ══════════════════════ */
console.log("\n=== 5. 运行时行为 ===");
const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1/" });
const w = dom.window;
const store = new Map();
Object.defineProperty(w, "localStorage", {
  value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  configurable: true,
});
w.eval(read("i18n.js"));
const api = w.i18n;

check("默认语言为 zh", api.lang === "zh", `lang=${api.lang}`);
check("t() 返回中文", api.t("tab.chat") === "对话", api.t("tab.chat"));
check("t() 支持插值", api.t("unit.tools", { n: 17 }) === "17 个工具", api.t("unit.tools", { n: 17 }));
check("缺失的键回退为键名（不空白）", api.t("nope.missing.key") === "nope.missing.key");

let events = 0;
let seenLang = null;
w.document.addEventListener("strata:langchange", (e) => { events++; seenLang = e.detail.lang; });

// applyI18n over the static markup
api.applyI18n();
const tabChat = w.document.querySelector("#tab-btn-chat span");
check("静态节点已渲染为中文", tabChat.textContent === "对话", tabChat.textContent);
const sendTitle = w.document.querySelector("#send-btn").getAttribute("aria-label");
check("data-i18n-attr 已应用到属性", sendTitle === "发送", String(sendTitle));

// switch
api.setLang("en");
check("切换后 lang 变化", api.lang === "en", api.lang);
check("切换后静态文本变为英文", w.document.querySelector("#tab-btn-chat span").textContent === "Chat",
      w.document.querySelector("#tab-btn-chat span").textContent);
check("切换后属性变为英文", w.document.querySelector("#send-btn").getAttribute("aria-label") === "Send",
      String(w.document.querySelector("#send-btn").getAttribute("aria-label")));
check("已持久化到 localStorage", store.get("strata.lang") === "en", String(store.get("strata.lang")));
check("派发了 strata:langchange", events === 1 && seenLang === "en", `events=${events} lang=${seenLang}`);
check("<html lang> 已同步", w.document.documentElement.lang === "en", w.document.documentElement.lang);

// switch back, and confirm no event when re-selecting the same language
api.setLang("zh");
check("切回中文生效", w.document.querySelector("#tab-btn-chat span").textContent === "对话");
check("<html lang> 变为 zh-CN", w.document.documentElement.lang === "zh-CN", w.document.documentElement.lang);
const before = events;
api.setLang("zh");
check("重复选择同一语言不重复派发", events === before, `events=${events} (before=${before})`);

// toggleLang
api.setLang("zh");
api.toggleLang();
check("toggleLang 切换到英文", api.lang === "en", api.lang);
api.toggleLang();
check("toggleLang 切回中文", api.lang === "zh", api.lang);

// switcher sync (header button text reflects the *other* language)
const btn = w.document.getElementById("lang-btn");
const sel = w.document.getElementById("lang-select");
check("Header 按钮存在", !!btn);
check("About 下拉存在", !!sel);
api.setLang("zh");
check("中文时按钮显示 EN", btn.textContent === "EN", btn.textContent);
check("中文时下拉选中 zh", sel.value === "zh", sel.value);
api.setLang("en");
check("英文时按钮显示 中", btn.textContent === "中", btn.textContent);
check("英文时下拉选中 en", sel.value === "en", sel.value);

// invalid language is ignored
api.setLang("klingon");
check("非法语言被忽略", api.lang === "en", api.lang);

/* ══════════════════ 6. a saved language is honoured at load ══════════════════ */
console.log("\n=== 6. 启动时读取已保存的语言 ===");
const pre = loadI18n({ "strata.lang": "en" });
check("保存为 en 时启动即为英文", pre.i18n.lang === "en", pre.i18n.lang);
check("且 t() 直接返回英文", pre.i18n.t("tab.chat") === "Chat", pre.i18n.t("tab.chat"));
const garbage = loadI18n({ "strata.lang": "xx-bogus" });
check("无效存档回退到默认 zh", garbage.i18n.lang === "zh", garbage.i18n.lang);

/* ═════════════════════════════════ result ═════════════════════════════════ */
console.log();
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}):`);
  for (const f of FAILURES) console.log("  - " + f);
  process.exit(1);
}
console.log(`I18N TESTS PASSED  ·  ${zhKeys.length} keys × 2 languages`);
