#!/usr/bin/env node
// smoke_web.js — 闭源构建的前端冒烟：证明【混淆后的】 dist/web 里没有语法错误。
//
// 为什么需要它（配方第四节列的待办）：esbuild --minify 对极端写法偶发误处理，
// 而产物里的 app.js 已是不可读的一行代码，一旦语法坏了，用户看到的是"白屏"，
// 且 CI 里前面几步全是绿的。这一步把"白屏"提前变成 CI 的红。
//
// 只做一件事、且只做能被机器判定的那一件：**编译**每个 .js（vm.Script = 只 parse
// 不执行），语法错即 exit 1。不执行页面逻辑（那需要 DOM，属于 browser__sim 的职责，
// 不在闭源 CI 的依赖面里）。
//
// 额外覆盖两件事，都是"零成本、真实有效"的检查：
//   1) index.html 里 <script src="x.js"> 引用的每个文件必须真实存在（防止混淆步骤
//      只处理了一半，或文件名对不上导致 404 —— 同样表现为白屏）；
//   2) 至少有一个 .js 被确认为"已混淆"（首行极长 / 无换行），否则说明这一步其实在
//      测明文源码，保护形同虚设。
//
// 用法： node scripts/smoke_web.js <distWebDir>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.argv[2];
if (!dir) { console.error('usage: node smoke_web.js <distWebDir>'); process.exit(2); }
const abs = path.resolve(dir);
if (!fs.existsSync(abs)) { console.error('not found: ' + abs); process.exit(2); }

function walk(d, cb) {
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, cb); else cb(p);
  }
}

const problems = [];
let jsCount = 0, minifiedSeen = 0;

// 1) 语法：对每个 .js 做只编译不执行的 parse（vm.Script 语法错会 throw）
walk(abs, (file) => {
  if (!file.toLowerCase().endsWith('.js')) return;
  jsCount++;
  const code = fs.readFileSync(file, 'utf8');
  // 混淆特征：minify 后几乎没有换行、首行极长
  const firstLine = code.split('\n')[0] || '';
  if (firstLine.length > 500) minifiedSeen++;
  try {
    new vm.Script(code, { filename: file });
  } catch (e) {
    problems.push('SYNTAX ' + path.relative(abs, file) + ': ' + e.message);
  }
});

// 2) index.html 引用的每个本地 .js / .css 必须存在
const indexHtml = path.join(abs, 'index.html');
if (fs.existsSync(indexHtml)) {
  const html = fs.readFileSync(indexHtml, 'utf8');
  const re = /<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;
  let m, refs = 0;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (/^(https?:|data:|\/\/|#)/i.test(raw)) continue;   // 外部/内联资源不管
    const clean = raw.split('?')[0].split('#')[0];
    if (!clean) continue;
    refs++;
    // Map the ref the way the server does. index.html references assets as
    // 'web/app.js' on purpose (the 8080 host path form); _serve_static strips that
    // prefix (http_server.py: 'clean.startswith("web/")' -> rel = clean[4:]). The
    // smoke must follow the SAME mapping or it reports a perfectly good build as
    // MISSING -- which is exactly what the first CI run did (7/7 'missing', while
    // the parse stage was green).
    let rel = clean;
    if (rel.startsWith('web/')) rel = rel.slice(4);
    if (process.env.SMOKE_WEB_LEGACY === '1') rel = clean;   // pre-fix behaviour, for the differential lock
    const target = path.resolve(abs, rel);
    if (!fs.existsSync(target)) problems.push('MISSING ' + raw + ' (referenced by index.html)');
  }
  console.log('index.html: checked ' + refs + ' local asset ref(s)');
} else {
  problems.push('NO-INDEX index.html not found in ' + abs);
}

// 3) 必须确认真的在测混淆产物，而不是明文源码
if (jsCount === 0) problems.push('NO-JS no .js files under ' + abs);
if (jsCount > 0 && minifiedSeen === 0) {
  problems.push('NOT-MINIFIED none of the ' + jsCount + ' js file(s) looks minified '
    + '— the smoke is running against plaintext source, the obfuscation step is suspect');
}

console.log('smoke_web: parsed ' + jsCount + ' js file(s), ' + minifiedSeen + ' look minified');
if (problems.length) {
  for (const p of problems) console.error('  FAIL ' + p);
  console.error('SMOKE-WEB: RED (' + problems.length + ' problem(s))');
  process.exit(1);
}
console.log('SMOKE-WEB: GREEN');
