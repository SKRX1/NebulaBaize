/* 代码块要像正经代码卡片那样显示（语法高亮 + 语言标签 + 复制），思考和正文一致（2026-10-20）。

背景：`codeBlock()` 一直是「深色卡片 + 语言名 + 复制按钮」，但**只有白字**——所有 token 一个颜色；
而**思考区**（`.st-collapse__body.thinking`）根本不是代码卡片，`patchThink` 直接 `textContent = src`，
模型在思考里贴的 ```js 片段就是一大坨等宽纯文本。用户截图要的就是编辑器那种风格。

本测试锁住的契约（真 index.html + 真 i18n.js + 真 app.js）：
  1. 高亮真的分了类：关键字/字符串/数字/注释/函数名/运算符各有 span；
  2. 字符串里的 `//` 不能被当成注释（分支顺序：字符串先于注释）；
  3. 语言家族：py 的 `#` 注释、html 的 `<!-- -->` 与标签、js 的 `//` 与块注释；
  4. 高亮只包装、不改文本：把 span 全部剥掉后必须与源码逐字相同（复制按钮依赖
     `pre.textContent`，这也是所有读取正文的测试的前提）；
  5. 代码里出现 `<img onerror>` 之类必须被转义（高亮不能开 XSS 口子）；
  6. `codeBlock()` 结构：`.st-code__lang` 显示语言（缺省 code）+ `[data-code-copy]` + `<pre>`；
  7. 正文 markdown 围栏走同一条路（`markdown("```js…")` 里就有 hl-kw）；
  8. 思考区：围栏代码渲染成真 `.st-code`，散文仍是 `.st-think__txt`（保留换行），
     流式中**未闭合**的围栏也要当代码块渲染（不能先当散文、收尾再跳一下）；
  9. 折叠时的单行摘要 `thinkPeek` 要跳过代码块，不能拿 `const opt = …` 当摘要。

Run: node tests/test_code_style.mjs
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
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval((fs.readFileSync(path.join(WEB, "app_utils.js"), "utf8") + "\n" + fs.readFileSync(path.join(WEB, "app.js"), "utf8")) + `
;window.__api = { hl, hlFamily, codeBlock, markdown, thinkRich, thinkPeek, thinkNode, patchThink };`);
const api = win.__api;

// strip the highlight spans and hand the text back: proves hl() is pure wrapping, never editing
const plain = (frag) => { const d = doc.createElement("div"); d.innerHTML = frag; return d.textContent; };
const box = (frag) => { const d = doc.createElement("div"); d.innerHTML = frag; return d; };

/* ═══════════ 1. js：每个 token 类别都要有自己的 span ═══════════ */
console.log("\n=== 1: js 高亮分类 ===");
{
  const src = `// note\nconst n = 42;\nfunction go(a) { return "hi" + a === b && c; }`;
  const out = api.hl(src, "js");
  check("关键字 const 走 hl-kw", /<span class="hl-kw">const<\/span>/.test(out));
  check("关键字 function/return 也走 hl-kw", /hl-kw">function</.test(out) && /hl-kw">return</.test(out));
  check("数字走 hl-num", /hl-num">42</.test(out));
  check("字符串走 hl-str", /hl-str">&quot;hi&quot;<\/span>/.test(out));
  check("注释走 hl-com", /hl-com">\/\/ note</.test(out), out.slice(0, 60));
  check("函数名 go( 走 hl-fn", /hl-fn">go</.test(out));
  check("运算符 === / && 走 hl-op", /hl-op">===</.test(out) && /hl-op">&amp;&amp;</.test(out));
  // `map` / `range` 之类跨语言通用词必须留在调用色，不能被共享关键字表吃掉
  const calls = api.hl("const xs = arr.map(fn).filter(Boolean);", "js");
  check("arr.map( 仍是 hl-fn 而非 hl-kw", /hl-fn">map</.test(calls) && !/hl-kw">map</.test(calls), calls.slice(0, 80));
  check("纯文本不被吞：逐字回放等于源码", plain(out) === src, JSON.stringify(plain(out).slice(0, 30)));
}

/* ═══════════ 2. 分支顺序：字符串优先于注释 ═══════════ */
console.log("\n=== 2: 字符串里的 // 不是注释 ===");
{
  const src = `const url = "http://x/y"; // real comment`;
  const out = api.hl(src, "js");
  const comments = out.match(/hl-com/g) || [];
  check("只有 1 个注释 span（URL 里的 // 不算）", comments.length === 1, `count=${comments.length}`);
  check("URL 整段在该 str span 里", /hl-str">&quot;http:\/\/x\/y&quot;<\/span>/.test(out), out.slice(0, 120));
  check("真正的注释仍被识别", /hl-com">\/\/ real comment</.test(out));
}

/* ═══════════ 3. 语言家族 ═══════════ */
console.log("\n=== 3: py / html / 未知语言 ===");
{
  check("py 归 hash 家族", api.hlFamily("python") === "hash" && api.hlFamily("py") === "hash");
  check("html 归 html 家族", api.hlFamily("html") === "html");
  check("js/ts/json 归 c 家族", api.hlFamily("js") === "c" && api.hlFamily("ts") === "c" && api.hlFamily("json") === "c");
  check("没有语言名 → c 家族兜底", api.hlFamily("") === "c" && api.hlFamily("weirdlang") === "c");

  const py = api.hl(`# c\ndef f(x):\n    return "#not comment"`, "py");
  check("py 的 # 是注释", /hl-com"># c</.test(py));
  check("py 字符串里的 # 不是注释", (py.match(/hl-com/g) || []).length === 1);
  check("py 关键字 def/return 命中", /hl-kw">def</.test(py) && /hl-kw">return</.test(py));

  const h = api.hl(`<!-- hi -->\n<div class="a">x</div>`, "html");
  check("html 注释 <!-- --> 命中", /hl-com">&lt;!-- hi --&gt;</.test(h));
  check("html 标签命中 hl-tag", /hl-tag">&lt;div</.test(h));
  check("html 属性值仍是字符串", /hl-str">&quot;a&quot;/.test(h));
  check("html 逐字回放", plain(h) === `<!-- hi -->\n<div class="a">x</div>`);
}

/* ═══════════ 4. 安全：高亮不能开转义口子 ═══════════ */
console.log("\n=== 4: 转义 ===");
{
  const evil = `const s = "<img src=x onerror=alert(1)>";`;
  const out = api.hl(evil, "js");
  check("没有裸 <img 标签", !/<img/i.test(out), out.slice(0, 80));
  check("尖括号被转义", out.includes("&lt;img"));
  check("文本仍逐字一致", plain(out) === evil);
  const d = box(out);
  check("注入的元素不存在", d.querySelector("img") === null);
}

/* ═══════════ 5. codeBlock 结构与复制契约 ═══════════ */
console.log("\n=== 5: codeBlock 结构 ===");
{
  const code = `const a = 1;\nconsole.log(a);`;
  const d = box(api.codeBlock("js", code));
  const card = d.querySelector(".st-code");
  check("有 .st-code 卡片", !!card);
  check("有语言标签 .st-code__lang 且文本为 js", card.querySelector(".st-code__lang").textContent === "js");
  check("有复制按钮 [data-code-copy]", !!card.querySelector("[data-code-copy]"));
  check("pre.textContent 与源码逐字相同（复制靠它）",
        card.querySelector("pre").textContent === code, JSON.stringify(card.querySelector("pre").textContent.slice(0, 20)));
  check("卡片里有高亮 span", !!card.querySelector("pre .hl-kw"));
  const noLang = box(api.codeBlock("", "x"));
  check("没有语言名 → 标签显示 code", noLang.querySelector(".st-code__lang").textContent === "code");
  const d2 = box(api.codeBlock("js", "a\nb"));
  check("代码换行不被折叠（pre 内是原文）", d2.querySelector("pre").textContent === "a\nb");
  // 超大粘贴：不配色（避免一帧卡死），但文本必须一模一样、照样能复制
  const huge = "const a = 1;\n".repeat(6000);
  const big = api.hl(huge, "js");
  check("超过 60KB 不配色（性能护栏）", !/hl-kw/.test(big) && big.length > 0, `len=${big.length}`);
  check("超大代码文本不变形", plain(big) === huge);
}

/* ═══════════ 6. 正文 markdown 围栏也走同一套 ═══════════ */
console.log("\n=== 6: 正文围栏 → 高亮卡片 ===");
{
  const md = api.markdown("先看代码：\n```js\nconst a = 1;\n```\n结束");
  const d = box(md);
  check("正文里出现 .st-code", !!d.querySelector(".st-code"));
  check("正文代码有高亮", !!d.querySelector(".hl-kw"));
  check("正文代码 pre 文本正确", d.querySelector("pre").textContent === "const a = 1;",
        JSON.stringify(d.querySelector("pre").textContent));
}

/* ═══════════ 7. 思考区：围栏 → 代码卡片，散文保留换行 ═══════════ */
console.log("\n=== 7: thinkRich 拆分 ===");
{
  const src = "我先读一下这个函数。\n多一行。\n```js\nconst opt = p.options[oi];\n```\n然后确认。";
  const d = box(api.thinkRich(src));
  check("散文进 .st-think__txt", d.querySelectorAll(".st-think__txt").length === 2,
        `count=${d.querySelectorAll(".st-think__txt").length}`);
  check("代码进 .st-code", d.querySelectorAll(".st-code").length === 1);
  check("代码块语言是 js", d.querySelector(".st-code__lang").textContent === "js");
  check("代码块内容正确", d.querySelector(".st-code pre").textContent.trim() === "const opt = p.options[oi];");
  check("散文里保留换行", /多一行。/.test(d.querySelector(".st-think__txt").textContent));
  check("散文里的 ``` 标记不残留", !/```/.test(d.textContent), JSON.stringify(d.textContent.slice(0, 40)));
  check("代码块前后顺序正确（散文 → 代码 → 散文）",
        d.children[0].className === "st-think__txt" && d.children[1].className === "st-code");

  const live = box(api.thinkRich("想一下\n```py\ndef f():\n    return 1"));
  check("流式中未闭合的围栏也渲染成代码卡片", !!live.querySelector(".st-code"));
  check("未闭合时内容就是已到的部分", /def f\(\):/.test(live.querySelector(".st-code pre").textContent));

  const noCode = box(api.thinkRich("只有想法，没有代码。"));
  check("没有围栏时不出 .st-code", noCode.querySelectorAll(".st-code").length === 0);
  check("没有围栏时仍是 pre-wrap 文本块", noCode.querySelector(".st-think__txt").textContent === "只有想法，没有代码。");
}

/* ═══════════ 8. 折叠摘要跳过代码 ═══════════ */
console.log("\n=== 8: thinkPeek 跳过代码块 ===");
{
  const src = "```js\nconst opt = (oi != null && p.options && p.options[oi]) ? p.options[oi] : null;\n```\n这一改要小心空数组。";
  const peek = api.thinkPeek(src);
  check("摘要取散文而不是代码", peek.startsWith("这一改要小心"), JSON.stringify(peek));
  const onlyCode = api.thinkPeek("```js\nconst a = 1;\n```");
  check("整段是代码时不崩（返回代码兜底）", typeof onlyCode === "string" && onlyCode.length > 0, JSON.stringify(onlyCode));
}

/* ═══════════ 9. patchThink 真的把富内容写进 .thinking ═══════════ */
console.log("\n=== 9: patchThink 落到 DOM ===");
{
  const src = "读一下。\n```js\nconst a = 1; // x\n```";
  const node = api.thinkNode(src, "th0");
  doc.getElementById("chat").appendChild(node);
  api.patchThink(node, src, { thinkOpen: {} }, "th0", true);
  const body = node.querySelector(".st-collapse__body.thinking");
  check("思考 body 里有代码卡片", !!body.querySelector(".st-code"), body.innerHTML.slice(0, 60));
  check("思考 body 里有散文块", !!body.querySelector(".st-think__txt"));
  check("思考 body 里代码有高亮", !!body.querySelector(".hl-kw"));
  check("思考 body 文本仍包含原文片段", body.textContent.includes("const a = 1;"));

  const folded = api.thinkNode("x", "th1");
  doc.getElementById("chat").appendChild(folded);
  api.patchThink(folded, "```js\nconst z = 2;\n```", { thinkOpen: { th1: false } }, "th1", false);
  check("折叠时不渲染 body（省开销）", folded.querySelector(".st-collapse__body").innerHTML === "");
}

console.log(`\n${FAILURES.length ? "FAILURES:\n - " + FAILURES.join("\n - ") : "REGRESSION: ALL GREEN"}`);
process.exit(FAILURES.length ? 1 : 0);
