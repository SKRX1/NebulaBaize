/* 随机种子的"实际用了多少"必须可见（2026-10-20）。

背景：抽屉里「随机种子」留空 = 随机，可是**这一轮到底随机出了多少**在界面上无处可查。引擎
（`serve/server.py`）只在请求里带 `seed=N`（N>0）时才把种子交给采样器，**从来不在回复里回显**；
种子小于等于 0 或缺失，引擎自己编一个，客户端永远看不见。所以"运行时随机出的种子"只能由**发出
请求的一方**决定 —— 前端抽，前端才知道。

实测（8080，temperature 1.2/1.3）：同一种子 + 同一上下文状态 → 逐字相同的回复；不同种子 → 不同
回复；所以展示出来的数字就是"想复现这一轮时该填回去的数字"。

本测试锁住的契约（真 index.html + 真 i18n.js + 真 app.js，打桩 fetch 驱动真流式循环）：
  1. 字段留空 → 每轮请求体里都带一个**正整数种子**，两轮不同（真随机，不是固定默认值）；
  2. 该数字出现在这一轮的统计脚注里（`.stat--seed`），且与请求体 / localStorage 完全一致；
  3. 字段填了 → 请求体固定用它，脚注显示同一个数字（图标为 pin 而非 refresh）；
  4. 老会话（stats 里没有 seed）不渲染芯片，不出现空壳；
  5. 点芯片 → 复制到剪贴板（要的就是"粘回去复现"）；
  6. 抽屉里的「本轮随机：N」+「固定用这个」一键把 N 变成固定种子（输入框 + 已存设置同步）；
  7. 种子的抽取范围必须落在引擎接受的区间（>0 且 int32 内），否则引擎会当"未设置"。

Run: node tests/test_seed_display.mjs
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const FAILURES = [];
const check = (label, cond, extra = "") => {
  console.log("  " + (cond ? "OK   " : "FAIL ") + label + (extra ? "  " + extra : ""));
  if (!cond) FAILURES.push(label);
};

const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
const doc = win.document;

win.TextDecoder = TextDecoder;
win.TextEncoder = TextEncoder;
win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", {
    configurable: true,
    value: { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 4294967296); return a; } },
  });
}

/* ── 请求体录制 + 一条健康的 SSE 流 ─────────────────────────────────────────── */
const bodies = [];          // every POST to v1/chat/completions
const copied = [];          // clipboard.writeText arguments
const enc = new TextEncoder();

Object.defineProperty(win.navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (t) => { copied.push(String(t)); } },
});

function healthyStream() {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                              usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } })}\n\n`,
    "data: [DONE]\n\n",
  ].map((c) => enc.encode(c));
  let i = 0;
  return {
    ok: true, status: 200,
    body: { getReader: () => ({ read: () => (i < chunks.length
      ? Promise.resolve({ value: chunks[i++], done: false })
      : Promise.resolve({ value: undefined, done: true })) }) },
  };
}

win.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.endsWith("v1/chat/completions")) {
    bodies.push(opts.body ? JSON.parse(opts.body) : null);
    return healthyStream();
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = {
  streamAssistant, pickSeed, renderStats, msgEl, renderSeedNote,
  setSeed: (v) => { settings.seed = v; },
  seedNow: () => settings.seed,
  lastSeedUsed: () => lastSeedUsed,
  newTurn: (text) => { messages = [{ role: "user", text, time: Date.now() }]; },
  msgs: () => messages,
};`);
const api = win.__api;

const isPosInt32 = (n) => Number.isInteger(n) && n > 0 && n <= 2147483647;
const chip = (m, i) => {
  const el = api.msgEl(m, i);
  doc.getElementById("chat").appendChild(el);
  api.renderStats(el, m, false);
  return el.querySelector(".stat--seed");
};

/* ═══════════ 1. 抽取的种子必须落在引擎接受的区间 ═══════════ */
console.log("\n=== 1: pickSeed() 的范围与随机性 ===");
{
  const draws = Array.from({ length: 300 }, () => api.pickSeed());
  check("300 次全部是正整数", draws.every(isPosInt32),
        `min=${Math.min(...draws)} max=${Math.max(...draws)}`);
  check("没有 0/负数（引擎会把 seed<=0 当未设置）", draws.every((n) => n > 0));
  check("确实在随机（300 次里去重 > 290）", new Set(draws).size > 290, `unique=${new Set(draws).size}`);
}

/* ═══════════ 2. 留空 → 每轮一个新种子，且脚注显示的就是它 ═══════════ */
console.log("\n=== 2: 留空 = 每轮随机，脚注显示实际种子 ===");
const seen = [];
for (const tag of ["first", "second"]) {
  api.setSeed("");
  api.newTurn(`turn ${tag}`);
  await api.streamAssistant();
  const body = bodies[bodies.length - 1];
  const m = api.msgs()[api.msgs().length - 1];
  seen.push({ tag, body, m });
  check(`[${tag}] 请求体带 seed=${body && body.seed}`,
        !!body && isPosInt32(body.seed));
  check(`[${tag}] 消息上记下同一个种子`, m.seed === (body && body.seed), `m.seed=${m.seed}`);
  const chipEl = chip(m, 1);
  check(`[${tag}] 脚注渲染出种子芯片`, !!chipEl);
  check(`[${tag}] 芯片数字与请求体一致`,
        !!chipEl && chipEl.dataset.seed === String(body.seed),
        chipEl && chipEl.dataset.seed);
  check(`[${tag}] 芯片用「随机」图标（refresh）`,
        !!chipEl && /#i-refresh(?:["\s])/.test(chipEl.innerHTML), chipEl && chipEl.innerHTML.slice(0, 80));
  check(`[${tag}] 芯片文案带数字`, !!chipEl && chipEl.textContent.includes(String(body.seed)),
        chipEl && chipEl.textContent);
}
check("两轮种子不同（不是写死的默认值）", seen[0].body.seed !== seen[1].body.seed,
      `${seen[0].body.seed} vs ${seen[1].body.seed}`);
{
  const ls = JSON.parse(win.localStorage.getItem("strata.lastSeed") || "null");
  check("localStorage 记下最后一次随机种子（重载后抽屉还能答）",
        !!ls && ls.n === seen[1].body.seed && ls.pinned === false, JSON.stringify(ls));
}

/* ═══════════ 3. 填了种子 → 固定使用，图标变为 pin ═══════════ */
console.log("\n=== 3: 固定种子 = 每轮都用它 ===");
api.setSeed("42");
for (const tag of ["a", "b"]) {
  api.newTurn(`pinned ${tag}`);
  await api.streamAssistant();
  const body = bodies[bodies.length - 1];
  check(`[${tag}] 请求体 seed=42`, body && body.seed === 42, body && String(body.seed));
  const m = api.msgs()[api.msgs().length - 1];
  const chipEl = chip(m, 1);
  check(`[${tag}] 芯片显示 42`, !!chipEl && chipEl.dataset.seed === "42", chipEl && chipEl.textContent);
  check(`[${tag}] 芯片用 pin 图标`, !!chipEl && /#i-pin(?:["\s])/.test(chipEl.innerHTML));
}

/* ═══════════ 4. 点芯片 = 复制（复现的第一步） ═══════════ */
console.log("\n=== 4: 点芯片复制种子 ===");
{
  const chipEl = doc.querySelector(".stat--seed");
  copied.length = 0;
  chipEl.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("复制到的就是种子数字", copied[0] === "42", JSON.stringify(copied));
}

/* ═══════════ 5. 老会话（stats 无 seed）不渲染空壳 ═══════════ */
console.log("\n=== 5: 历史消息没有 seed 时不渲染芯片 ===");
{
  const legacy = { role: "assistant", text: "old", time: 1,
                   stats: { dur: 1.2, prompt: 10, completion: 5, tokS: 9, ctxUsed: 10, ctxMax: 100 } };
  check("没有 .stat--seed", chip(legacy, 2) === null);
}

/* ═══════════ 6. 抽屉：本轮随机 N + 一键固定 ═══════════ */
console.log("\n=== 6: 抽屉里的「本轮随机」与「固定用这个」 ===");
{
  api.setSeed("");
  api.newTurn("drawer case");
  await api.streamAssistant();
  const body = bodies[bodies.length - 1];
  const note = doc.getElementById("seed-note");
  const text = doc.getElementById("seed-note-text");
  const lock = doc.getElementById("seed-lock");
  check("抽屉提示行可见", !!note && note.hidden === false);
  check("提示行写的是本轮实际种子", !!text && text.textContent.includes(String(body.seed)),
        text && text.textContent);
  check("「固定用这个」按钮可见", !!lock && lock.hidden === false);

  lock.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("点一下就把种子填进输入框",
        doc.getElementById("s-seed").value === String(body.seed),
        doc.getElementById("s-seed").value);
  check("设置里也固定了它（下一轮直接用）", api.seedNow() === String(body.seed), api.seedNow());
  const saved = JSON.parse(win.localStorage.getItem("strata.sampling") || "{}");
  check("已写回 localStorage 的采样设置", saved.seed === String(body.seed), JSON.stringify(saved.seed));
  check("固定后按钮自己隐藏（没有可锁的东西了）", lock.hidden === true);

  api.newTurn("after pin");
  await api.streamAssistant();
  check("下一轮请求体用的就是它", bodies[bodies.length - 1].seed === body.seed,
        String(bodies[bodies.length - 1].seed));
}

/* ═══════════ 7. 两种语言的文案都在 ═══════════ */
console.log("\n=== 7: i18n 文案 ===");
{
  const dict = win.i18n._dict;
  for (const k of ["stat.seed", "stat.seed.tip", "drawer.seed.last", "drawer.seed.last.pinned",
                   "drawer.seed.lock", "toast.seed.locked.title", "toast.seed.locked.msg"])
    check(`zh+en 都有 ${k}`, !!dict.zh[k] && !!dict.en[k]);
  check("zh 的 stat.seed 带 {n} 占位", String(dict.zh["stat.seed"]).includes("{n}"));
}

console.log("");
if (FAILURES.length) {
  console.log(`FAILED (${FAILURES.length}): ` + FAILURES.join(" | "));
  process.exit(1);
}
console.log("SEED-DISPLAY: ALL GREEN");
process.exit(0);   // streamAssistant leaves a live-clock interval on the event loop; exit explicitly
