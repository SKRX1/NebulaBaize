#!/usr/bin/env node
// obfuscate_web.js — 闭源发布专用：对【副本目录】里的前端做 minify/混淆，绝不写回权威源。
//
// 铁律（与 serve/web 唯一真相源一致）：
//   输入 serve/web/ 是明文权威源，本脚本【只读不写】它；
//   先把 serve/web/ 整体复制到 outDir（调用方传 dist/.../web），混淆只在 outDir 内原地进行。
//   因此源码版前端（serve/web/）全程零改动。
//
// 用法： node scripts/obfuscate_web.js <srcWebDir> <outWebDir>
//   例： node scripts/obfuscate_web.js serve/web dist/web
// 行为： src → 递归复制到 out（保持目录结构），再对 out 下每个 .js 用 esbuild --minify 原地覆盖；
//        HTML 里的 <script src="x.js"> 引用的还是同名 .js，故无需改 HTML（同名替换）。
// 注意：本脚本只在 CI/构建阶段对 dist 副本运行，不是对源码的开发期改动。
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('usage: node obfuscate_web.js <srcWebDir> <outWebDir>');
  process.exit(2);
}
if (!fs.existsSync(src)) { console.error('src not found: ' + src); process.exit(2); }
// 防御性卫语句：out 解析后绝不能等于 src，否则就地混淆会污染源。
const srcAbs = path.resolve(src), outAbs = path.resolve(out);
if (srcAbs === outAbs) {
  console.error('refusing to obfuscate in-place: src == out (' + srcAbs + ')');
  process.exit(2);
}

function walk(dir, cb) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

// Windows 上 npx 实为 npx.cmd，spawnSync 不带 shell 无法直接 spawn；
// 用 shell 让 cmd 解析 .cmd。args 仍走数组（Node 自动 quote），input 经 stdin 管道喂给 esbuild。
const ESB_ARGS = ['--yes', 'esbuild', '--minify', '--charset=utf8', '--loader=js', '--target=es2020'];
const WIN32 = process.platform === 'win32';
function minify(code) {
  const r = spawnSync('npx', ESB_ARGS, {
    input: code, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: WIN32,
  });
  if (r.error) return { err: 'spawn error: ' + r.error.message };
  if (r.status !== 0) return { err: 'esbuild exit ' + r.status + ': ' + (r.stderr || '').slice(0, 600) };
  return { ok: true, code: r.stdout };
}

// 1) 复制 src -> out（保持结构）
fs.cpSync(srcAbs, outAbs, { recursive: true });

// 2) 仅对 out 下的 .js 做 minify（esbuild），原地写回 out（不动 src）
let n = 0, failed = null;
walk(outAbs, (file) => {
  if (failed) return;
  if (!file.toLowerCase().endsWith('.js')) return;
  const code = fs.readFileSync(file, 'utf8');
  const r = minify(code);
  if (!r.ok) { failed = file + ': ' + r.err; return; }
  fs.writeFileSync(file, r.code, 'utf8');
  n++;
});
if (failed) { console.error('obfuscate failed: ' + failed); process.exit(1); }
console.log('obfuscated ' + n + ' js file(s) into ' + outAbs + ' (source ' + srcAbs + ' untouched)');
