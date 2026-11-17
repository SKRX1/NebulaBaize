/* 生成一张真实渲染的预览图（真 CSS + 真 app.js 输出），只用于人工核对样式。 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");

const dom = new JSDOM(fs.readFileSync(path.join(WEB, "index.html"), "utf8"),
  { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
if (typeof win.cancelAnimationFrame !== "function") win.cancelAnimationFrame = (id) => clearTimeout(id);
win.localStorage.setItem("strata.lang", "en");
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + `
;window.__api = { codeBlock, thinkRich, markdown };`);
const api = win.__api;

const js = [
  'const opt = (oi != null && p.options && p.options[oi]) ? p.options[oi]',
  '  : (p.options ? p.options.find((o) => o.verdict === "推荐") : null);',
  '// 注释：只认「推荐」这一档，其余保持中性',
  'function pick(list, keepIf = (x) => x.net > 0) {',
  '  return list.filter(keepIf).map((x) => x.label).join(", ");',
  '}',
  'const CONF = { low: 1024, medium: 4096, high: 32768, ratio: 0.75 };',
].join("\n");

const py = [
  'def rank(items, floor=0.0):',
  '    """keep only the ones that are worth doing"""',
  '    good = [x for x in items if x.gain - x.risk > floor]',
  '    return sorted(good, key=lambda x: -x.gain)',
].join("\n");

const think = "先确认这一点：推荐项的判定只读 verdict，不看 pros/cons 的长度。\n"
  + "```js\n" + js + "\n```\n所以 UI 只需要把「推荐」标绿，其余保持中性即可。";

const answer = "改法如下，先看代码：\n```js\n" + js + "\n```\n再看 Python 版本：\n```py\n" + py + "\n```\n"
  + "行内 `const` 与 **加粗** 都不受影响。";

const card = (theme) => `
<section class="pv" data-theme="${theme}">
  <div class="pv__label">主题：${theme}</div>
  <details class="st-collapse st-think" data-state="live" open>
    <summary><span class="st-think__title">深度思考</span>
      <span class="st-think__peek muted">先确认这一点：推荐项的判定只读 verdict，不看 pros/cons 的长度。</span>
      <span class="st-think__chars muted small">${think.length} 字符</span></summary>
    <div class="st-collapse__body thinking">${api.thinkRich(think)}</div>
  </details>
  <div class="st-bubble">${api.markdown(answer)}</div>
</section>`;

const page = `<!doctype html><html lang="zh-CN" data-theme="dark"><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${WEB.replace(/\\/g, "/")}/tokens.css">
<link rel="stylesheet" href="file://${WEB.replace(/\\/g, "/")}/components.css">
<link rel="stylesheet" href="file://${WEB.replace(/\\/g, "/")}/app.css">
<style>
  body{margin:0;padding:18px;background:var(--st-bg);font-family:var(--st-font)}
  .pv{padding:14px 16px 18px;margin:0 0 22px;border-radius:16px;background:var(--st-surface);border:1px solid var(--st-line)}
  .pv[data-theme="light"]{--st-bg:#f5f6f8;--st-surface:#fff;--st-surface-2:#f3f5f7;--st-ink:#1d2125;--st-ink-muted:#5b6570;
    --st-line:#e2e6ea;--st-line-soft:#eceff2;--st-code-bg:#1b1f23;--st-accent:#2f7fed;--st-accent-ink:#fff;--st-warn:#b8791a}
  .pv__label{font:600 12px/1 var(--st-font);color:var(--st-ink-muted);margin:0 0 10px;letter-spacing:.04em}
  .st-bubble{padding:4px 2px}
</style></head><body>
${card("dark")}${card("light")}
</body></html>`;

const sprite = fs.readFileSync(path.join(WEB, "sprite.svg"), "utf8");
// 把外部雪碧图内联进页面，这样 <use href="web/sprite.svg#i-copy"> 在离线预览里也能画出复制图标
const inlined = page.replace(/href="web\/sprite\.svg#/g, 'href="#');
const out = path.join(HERE, "code_preview.html");
fs.writeFileSync(out, inlined.replace("<body>", `<body><div style="display:none">${sprite}</div>`), "utf8");
console.log(out);
process.exit(0);
