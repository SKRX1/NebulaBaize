// 2026-11-20 ROOT-CAUSE gate for scripts/smoke_web.js (the closed-source CI front-end smoke).
//
// What actually broke in CI (run 44711200649, all three platforms, same step):
//   smoke_web printed "parsed 4 js file(s), 4 look minified" — the PARSE stage was green —
//   then "FAIL MISSING web/app.js (referenced by index.html)" x7 -> SMOKE-WEB: RED.
//   Root cause: index.html references assets as "web/app.js" ON PURPOSE. That is the
//   project's fixed contract: _serve_static strips the "web/" prefix
//   (runtime/http_server.py: `elif clean.startswith("web/")` -> `rel = clean[4:]`).
//   The smoke joined the ref under the web root instead, i.e. <dir>/web/app.js, so every
//   real asset was reported missing. The release artifact was fine; the CHECK was wrong.
//
// The fix maps the ref exactly like the server does, behind an env switch
// (SMOKE_WEB_LEGACY=1) that reproduces the old mapping for THIS differential.
//
// Three locks, each needed on its own:
//   M1 POSITIVE  the server-style layout (refs carry "web/", files sit flat in the root)
//                must be GREEN. Fails before the fix (that is the CI red).
//   M2 DECOY     SMOKE_WEB_LEGACY=1 must be RED with exactly one MISSING per ref.
//                Proves M1's green comes from the mapping fix, not from the check being
//                weakened into nothing.
//   M3 ANTI-DEGRADE a genuinely absent asset must STILL be reported missing under the NEW
//                mapping, and only that one. Without M3 the degenerate "resolve refs to a
//                path that always exists" (or "skip the check") would also pass M1+M2.
//
// The fixture is a hand-built minimal dist tree (no esbuild needed): the unit under test is
// the REF->PATH mapping, not the obfuscator. ASCII-only output (console code pages).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT = path.join(HERE, '..');
const SMOKE = path.join(AGENT, 'scripts', 'smoke_web.js');

const FAILS = [];
const ck = (name, ok, detail = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + ' ' + detail);
  if (!ok) FAILS.push(name);
};

// ---- fixture: index.html refs every asset with the "web/" prefix, files live flat ----
const ASSETS = ['favicon.svg', 'tokens.css', 'app.css', 'app.js'];
function buildFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smokemap-'));
  const html = [
    '<!doctype html><html><head>',
    '<link rel="icon" href="web/favicon.svg">',
    '<link rel="stylesheet" href="web/tokens.css">',
    '<link rel="stylesheet" href="web/app.css">',
    // a query string must be ignored when resolving (the server strips ?query too)
    '<script src="web/app.js?v=build"></script>',
    '</head><body><div id="chat"></div></body></html>',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  fs.writeFileSync(path.join(dir, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'tokens.css'), ':root{--st-x:1}');
  fs.writeFileSync(path.join(dir, 'app.css'), '.a{}');
  // first line must LOOK minified (>500 chars) or the smoke's third lock fires
  fs.writeFileSync(path.join(dir, 'app.js'), '// ' + 'x'.repeat(600) + '\nvar a=1;\n');
  return dir;
}

function runSmoke(dir, env = {}) {
  const r = spawnSync(process.execPath, [SMOKE, dir], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, env),
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const missingOf = (text) =>
  text.split(/\r?\n/).filter((l) => l.includes('MISSING '));

console.log('=== fixture layout: index.html refs "web/*", assets flat in the root ===');
let dir = buildFixture();
try {
  console.log('fixture', dir, 'assets=' + ASSETS.length);

  // ---- M1 POSITIVE ----
  const fix = runSmoke(dir);
  const fixMissing = missingOf(fix.out);
  console.log('M1 exit=' + fix.code + ' missing=' + fixMissing.length);
  fixMissing.forEach((l) => console.log('   |', l.slice(0, 120)));
  ck('M1 the real (server-style) layout must be GREEN', fix.code === 0,
     'exit=' + fix.code + ' (this exact shape was RED in CI run 44711200649)');

  // ---- M2 DECOY: the pre-fix mapping must reproduce the CI red ----
  const legacy = runSmoke(dir, { SMOKE_WEB_LEGACY: '1' });
  const legacyMissing = missingOf(legacy.out);
  console.log('M2 legacy exit=' + legacy.code + ' missing=' + legacyMissing.length);
  legacyMissing.forEach((l) => console.log('   |', l.slice(0, 120)));
  ck('M2 DECOY the old join-under-root mapping is RED again', legacy.code !== 0,
     'exit=' + legacy.code);
  ck('M3 DECOY it reports one MISSING per reference (the check is still real)',
     legacyMissing.length === ASSETS.length,
     'missing=' + legacyMissing.length + ' refs=' + ASSETS.length);
  // the load-bearing single variable is the mapping ONLY: same dir, same parse result
  const bothParsed = /parsed \d+ js file\(s\)/.test(fix.out) && /parsed \d+ js file\(s\)/.test(legacy.out);
  ck('M4 both runs parse the SAME js set (only the ref mapping differs)', bothParsed);

  // ---- M3 ANTI-DEGRADE: a truly missing asset is still caught under the NEW mapping ----
  fs.rmSync(path.join(dir, 'app.css'));
  const gone = runSmoke(dir);
  const goneMissing = missingOf(gone.out);
  console.log('M5 exit=' + gone.code + ' missing=' + goneMissing.length);
  goneMissing.forEach((l) => console.log('   |', l.slice(0, 120)));
  ck('M5 a genuinely deleted asset is STILL reported under the new mapping',
     gone.code !== 0 && goneMissing.length === 1,
     'exit=' + gone.code + ' missing=' + goneMissing.length +
     ' (guards the degenerate "check disabled -> always green")');
  ck('M6 it names exactly the file that is gone, not the other three',
     goneMissing.length === 1 && goneMissing[0].includes('web/app.css'),
     goneMissing[0] ? goneMissing[0].slice(0, 120) : '(none)');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\nSMOKE-MAP: ' + (FAILS.length ? 'RED (' + FAILS.length + ')' : 'ALL GREEN'));
process.exit(FAILS.length ? 1 : 0);
