'use strict';
/**
 * Deterministic page runner: load a real HTML page's own <script> blocks into the browser
 * shim (env.cjs), advance N animation frames, optionally inject input, and read back state.
 *
 *   node run.cjs job.json
 *
 * Job (all fields optional except `page` or `script`):
 *   {
 *     "page":      "E:/proj/index.html?demo=0",  // real page; a ?query becomes location.search
 *     "script":    "E:/proj/game.js",            // OR a bare JS file
 *     "params":    {"demo": "0"},                // extra query params
 *     "viewport":  {"width": 960, "height": 640},
 *     "seed":      12345,                        // seeds Math.random for reproducibility
 *     "steps":     120,                          // frames to run
 *     "dt":        16.6667,                      // virtual ms per frame
 *     "actions":   [{"frame": 0, "type": "click", "target": "btn-start"},
 *                   {"frame": 5, "type": "keydown", "code": "ArrowRight"},
 *                   {"frame": 60, "type": "keyup", "code": "ArrowRight"},
 *                   {"frame": 20, "type": "pointerdown", "x": 480, "y": 600},
 *                   {"frame": 30, "type": "eval", "expr": "state.paused = false"}],
 *     "probes":    [{"name": "score", "expr": "state.score"},
 *                   {"name": "bricks", "expr": "bricks.filter(b=>b.alive).length"}],
 *     "prelude":   "globalThis.myApi = {};",     // escape hatch for a global the shim lacks
 *     "console_limit": 200
 *   }
 *
 * Output: a short human summary, then one line `__SIM__<json>` for the Python caller.
 *
 * Run errors never change the exit code: a page that throws still produces a well-formed
 * report (`ok:false` + errors), because the whole point is to *see* what a page did.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeEnv, PLACEHOLDER_PNG } = require('./env.cjs');

const MAX_ELEMENTS = 3000;
const MAX_TEXT = 2000;

// ── job loading ───────────────────────────────────────────────────────────────────────────

let job;
try {
  job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
} catch (e) {
  emit(blankReport(`cannot read job file: ${e.message}`));
  process.exit(0);
}

// `%` escaping from a JSON round trip is a classic source of "file not found".
const pageRef = job.page || job.script || '';

// ── HTML scanning ─────────────────────────────────────────────────────────────────────────

/** Parse the attributes of one opening tag: id / class / width / height / style / text. */
function parseAttrs(text) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(text))) {
    out[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
  }
  return out;
}

/** Collect `<tag ...>` occurrences so getElementById()/querySelector() find real elements. */
function scanElements(html) {
  const els = [];
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '');
  const re = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)\/?>/g;
  let m;
  while ((m = re.exec(stripped)) && els.length < MAX_ELEMENTS) {
    const tag = m[1].toLowerCase();
    if (tag === 'br' || tag === 'meta' || tag === 'link' || tag === 'hr' || tag === 'img' || tag === 'input') continue;
    els.push({ tag, attrs: parseAttrs(m[2] || '') });
  }
  return els;
}

/** Collect the page's own scripts, in document order. */
function scanScripts(html, baseDir) {
  const re = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const attrs = parseAttrs(m[1] || '');
    const type = (attrs.type || '').toLowerCase();
    if (type && !/javascript|ecmascript|^module$/.test(type)) continue;   // JSON-LD, templates
    if (type === 'module') {
      out.push({ skip: 'type="module" (ES modules are not supported by the sim)', src: attrs.src || '' });
      continue;
    }
    if (attrs.src) {
      let p = attrs.src.startsWith('http')
        ? null
        : path.resolve(baseDir, attrs.src.replace(/^\//, ''));
      // Same-origin fallback: a src carrying the served mount prefix (e.g. "web/foo.js") is
      // resolved by the real server as docroot + stripped-first-segment. The sim's baseDir IS
      // that docroot, so when the plain relative resolve misses AND the src has a leading dir
      // segment, strip it and re-resolve against baseDir -- mirrors _serve_static byte-for-byte.
      if (p && !fs.existsSync(p) && !attrs.src.startsWith('http')) {
        const bare = attrs.src.replace(/^\//, '');
        const slash = bare.indexOf('/');
        if (slash >= 0) {
          const stripped = path.resolve(baseDir, bare.slice(slash + 1));
          if (fs.existsSync(stripped)) p = stripped;
        }
      }
      if (!p || !fs.existsSync(p)) { out.push({ skip: `external script not fetched: ${attrs.src}` }); continue; }
      out.push({ code: fs.readFileSync(p, 'utf8'), filename: p });
      continue;
    }
    const code = m[2] || '';
    if (code.trim()) out.push({ code, filename: `${job.page || 'page'}#inline` });
  }
  return out;
}

// ── report helpers ────────────────────────────────────────────────────────────────────────

/** Turn any page value into JSON-safe output (functions/cycles/getters must not explode). */
function describe(v, depth) {
  const d = depth || 0;
  if (v === undefined) return '__undefined__';
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number') return Number.isFinite(v) ? v : String(v);
  if (t === 'boolean') return v;
  if (t === 'string') return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) + '…' : v;
  if (t === 'bigint' || t === 'symbol') return String(v);
  if (t === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (d > 3) return Array.isArray(v) ? `[Array(${v.length})]` : '[Object]';
  try {
    if (Array.isArray(v)) return v.slice(0, 60).map((x) => describe(x, d + 1));
    if (v instanceof Date) return v.toISOString();
    const out = {};
    const keys = Object.keys(v);
    let n = 0;
    for (const k of keys) {
      if (++n > 40) { out['…'] = `${keys.length} keys total`; break; }
      try { out[k] = describe(v[k], d + 1); } catch (e) { out[k] = `[getter threw: ${e.message}]`; }
    }
    return out;
  } catch (e) {
    return `[unreadable: ${e.message}]`;
  }
}

function emit(report) {
  const lines = [];
  if (report.fatal) {
    lines.push(`error: ${report.fatal}`);
  } else {
    lines.push(`ok=${report.ok ? 'yes' : 'no'} frames=${report.frames} ` +
               `virtual=${Math.round(report.virtual_ms)}ms draws=${report.draws} ` +
               `timers=${report.timers_run} console=${report.console.length} ` +
               `errors=${report.errors.length} (real ${report.elapsed_ms}ms)`);
    const pk = Object.keys(report.probes || {});
    if (pk.length) {
      lines.push('probes:');
      for (const k of pk) lines.push(`  ${k} = ${compact(report.probes[k])}`);
    }
    if (report.console.length) {
      lines.push(`console (${report.console.length}):`);
      for (const c of report.console.slice(0, 40)) lines.push(`  [${c.level}] ${c.text}`);
      if (report.console.length > 40) lines.push(`  … ${report.console.length - 40} more`);
    }
    if (report.errors.length) {
      lines.push('errors:');
      for (const e of report.errors.slice(0, 10)) lines.push(`  ! [${e.where}] ${e.kind === 'sandbox_gap' ? 'SandboxGap: ' : ''}${e.message}`);
    }
    if (report.warnings.length) {
      lines.push('warnings:');
      for (const w of report.warnings.slice(0, 10)) lines.push(`  ~ ${w}`);
    }
    if (report.stub_calls && report.stub_calls.length) {
      lines.push(`auto-stubbed (no-op, ${report.stub_calls.length}): ${report.stub_calls.map((s) => `${s.name}×${s.count}`).join(', ')}`);
    }
  }
  process.stdout.write(lines.join('\n') + '\n');
  process.stdout.write('__SIM__' + JSON.stringify(report) + '\n');
}

function compact(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────

const startedAt = Date.now();

/** A report skeleton with every key emit() reads -- used on the fatal early-exit paths. */
function blankReport(fatal) {
  return { ok: false, fatal, mode: '', page: '', frames: 0, dt: 1000 / 60, virtual_ms: 0,
           draws: 0, timers_run: 0, elapsed_ms: 0, console: [], errors: [], warnings: [],
           probes: {}, stub_calls: [], storage: {}, supported_globals: [] };
}

const report = blankReport(null);
report.page = pageRef;
let ENV_API = null;      // the env api, so finish() can pull stats without threading it

// A page that produces an unhandled rejection (e.g. its fetch) must not kill the process --
// it is data about the page, not a simulator failure.
const unhandled = [];
process.on('unhandledRejection', (r) => {
  unhandled.push({ where: 'promise', name: (r && r.name) || 'UnhandledRejection',
                   message: String((r && r.message) || r) });
});

function classify(err, where) {
  const msg = String((err && err.message) || err);
  const name = (err && err.name) || 'Error';
  const rec = { where, name, message: msg, kind: 'error' };
  const isProbe = String(where || '').startsWith('probe:') || String(where || '').startsWith('action:');
  if (name === 'ReferenceError') {
    const m = /^([\w$]+) is not defined$/.exec(msg);
    if (m) {
      rec.kind = 'sandbox_gap';
      rec.missing = m[1];
      // A probe/action is OUR expression, not the page's code: the identifier may simply be
      // a typo or a name that only exists inside a function scope. Different advice.
      rec.message = isProbe
        ? `\`${m[1]}\` is not defined at page top level -- probes can only read globals and ` +
          `page-level const/let (a name declared inside a function is invisible), or the sim ` +
          `does not provide it. Supported globals are listed in supported_globals.`
        : `the page needs global \`${m[1]}\`, which the sim does not implement. If it is a ` +
          `browser API, pass it in the job's "prelude" (e.g. "globalThis.${m[1]} = {...};"). ` +
          `If the page has a typo, fix the page.`;
    }
  } else if (name === 'TypeError') {
    const m = /^(.+?) is not a function$/.exec(msg);
    if (m) rec.kind = 'not_a_function';
  } else if (name === 'SyntaxError') {
    rec.kind = 'syntax';
  }
  if (err && err.stack) {
    const line = String(err.stack).split('\n').find((l) => /:\d+:\d+/.test(l));
    if (line) rec.at = line.trim().slice(0, 200);
  }
  return rec;
}

function main() {
  // ---- resolve the target ------------------------------------------------------------
  let html = '';
  let baseDir = process.cwd();
  let mode = 'page';
  if (!pageRef) {
    report.fatal = 'job must carry "page" (a .html path) or "script" (a .js path)';
    return finish();
  }
  const qIdx = pageRef.indexOf('?');
  const filePart = qIdx >= 0 ? pageRef.slice(0, qIdx) : pageRef;
  const queryPart = qIdx >= 0 ? pageRef.slice(qIdx + 1) : '';
  const abs = path.isAbsolute(filePart) ? filePart : path.resolve(process.cwd(), filePart);
  if (!fs.existsSync(abs)) {
    report.fatal = `page not found: ${abs}`;
    return finish();
  }
  baseDir = path.dirname(abs);
  report.page = abs;

  const params = new URLSearchParams(queryPart || '');
  for (const [k, v] of Object.entries(job.params || {})) params.set(k, String(v));
  const search = params.toString() ? '?' + params.toString() : '';

  const env = makeEnv({
    viewport: job.viewport, seed: job.seed,
    search, href: 'file:///' + abs.replace(/\\/g, '/'),
    pathname: '/' + path.basename(abs), consoleLimit: job.console_limit,
  });
  ENV_API = env;
  report.dt = dtOf(job);
  report.supported_globals = env.supportedGlobals();

  if (/\.html?$/i.test(abs)) {
    html = fs.readFileSync(abs, 'utf8');
    for (const spec of scanElements(html)) env.addElement(spec);
  } else {
    mode = 'script';
    html = '';
  }

  // ---- vm context --------------------------------------------------------------------
  const sandbox = env.window;
  const ctx = vm.createContext(sandbox, { name: 'nebula-sim' });
  // Deterministic randomness *inside* the realm (host Math is shared, the vm's is not).
  try { vm.runInContext('Math.random = __rand;', ctx); } catch (_) { /* pre-ES5 host */ }
  // Inline handlers (onclick=... parsed from innerHTML/attrs) need a factory that runs
  // INSIDE the realm so the generated body can see window/document/etc. The host Node
  // scope has none of those.
  try {
    const maker = vm.runInContext('(function (body) { try { return new Function(body); } catch (e) { return null; } })', ctx);
    sandbox.__inlineFnMaker = maker;
    sandbox.document.__env.__inlineFnMaker = maker;
  } catch (_) { /* pre-ES5 host */ }

  const runSource = (code, filename) => {
    try {
      vm.runInContext(code, ctx, { filename, displayErrors: true });
      return true;
    } catch (e) {
      report.errors.push(classify(e, filename));
      return false;
    }
  };

  report.mode = mode;
  if (job.prelude) runSource(String(job.prelude), '<prelude>');

  // ---- run the page's scripts --------------------------------------------------------
  if (mode === 'page') {
    const scripts = scanScripts(html, baseDir);
    report.warnings.push(...scripts.filter((s) => s.skip).map((s) => s.skip));
    for (const s of scripts) {
      if (s.skip) continue;
      // A browser abandons only the script that threw, then keeps running the following ones;
      // mirroring that matters because the next <script> often reports the real state.
      runSource(s.code, s.filename);
    }
  } else {
    runSource(fs.readFileSync(abs, 'utf8'), abs);
  }

  // ---- advance frames, applying scripted input ---------------------------------------
  const dt = dtOf(job);
  const steps = Math.max(0, Math.min(Number(job.steps) || 0, 20000));
  const actions = (job.actions || []).slice().sort((a, b) => (a.frame || 0) - (b.frame || 0));
  const byFrame = new Map();
  for (const a of actions) {
    const f = Math.max(0, Math.min(Number(a.frame) || 0, steps - 1));
    if (!byFrame.has(f)) byFrame.set(f, []);
    byFrame.get(f).push(a);
  }

  const runAction = (a) => {
    try {
      if (a.type === 'keydown' || a.type === 'keyup') env.dispatchKey(a.type, a.code || 'KeyA');
      else if (a.type === 'click' || a.type === 'tap') env.dispatchClick(a.target);
      else if (a.type === 'pointerdown' || a.type === 'pointerup' || a.type === 'pointermove') {
        env.dispatchPointer(a.type, Number(a.x) || 0, Number(a.y) || 0, a.target);
      } else if (a.type === 'mousedown' || a.type === 'mouseup' || a.type === 'mousemove') {
        env.dispatchPointer(a.type.replace('mouse', 'pointer'), Number(a.x) || 0, Number(a.y) || 0, a.target);
      } else if (a.type === 'eval') {
        vm.runInContext(String(a.expr || ''), ctx, { filename: '<action>' });
      } else if (a.type === 'wait') {
        // no-op marker: the frame itself is the wait
      } else {
        report.warnings.push(`unknown action type: ${a.type}`);
      }
    } catch (e) {
      report.errors.push(classify(e, `action:${a.type}@${a.frame}`));
    }
  };

  for (let f = 0; f < steps; f++) {
    for (const a of byFrame.get(f) || []) runAction(a);
    env.stepFrame(dt);
  }

  // ---- probes ------------------------------------------------------------------------
  let probes = job.probes || [];
  if (!Array.isArray(probes)) {
    probes = Object.entries(probes).map(([name, expr]) => ({ name, expr }));
  }
  probes = probes.map((p) => (typeof p === 'string' ? { name: p, expr: p } : p));
  for (const p of probes) {
    const name = p.name || String(p.expr || '');
    const expr = p.expr === undefined ? name : p.expr;
    try {
      let val;
      try { val = vm.runInContext('(' + expr + ')', ctx, { filename: '<probe>' }); }
      catch (e) {
        if (e && e.name === 'SyntaxError') val = vm.runInContext(String(expr), ctx, { filename: '<probe>' });
        else throw e;
      }
      report.probes[name] = describe(val, 0);
    } catch (e) {
      report.errors.push(classify(e, `probe:${name}`));
      report.probes[name] = `[probe failed: ${e.message}]`;
    }
  }

  // ---- tail timers (a page may schedule work for after the last frame) ---------------
  return env.finish().then(() => finish());
}

function finish() {
  if (ENV_API) {
    const st = ENV_API.state;
    report.frames = st.frames;
    report.virtual_ms = st.now;
    report.draws = st.draws;
    report.timers_run = st.timersRun;
    report.console = st.console;
    report.errors.push(...st.errors);
    report.warnings.push(...st.warnings);
    report.storage = ENV_API.readStorage();
    report.stub_calls = [...st.stub.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  }
  report.errors.push(...unhandled);
  report.elapsed_ms = Date.now() - startedAt;
  report.ok = !report.fatal && report.errors.length === 0;
  // The supported-global list is only *useful* when something is missing; shipping it on
  // every call would bloat the tool result for no reason.
  if (!report.errors.some((e) => e.kind === 'sandbox_gap')) report.supported_globals = [];
  emit(report);
}

/** dt per frame: honour job.dt (ms) or default to 60fps. */
function dtOf(j) {
  const v = Number(j && j.dt);
  return v > 0 && v < 10000 ? v : 1000 / 60;
}

// Nothing else may write to stdout: the last line is the machine-readable report.
const _rc = main();
if (_rc && typeof _rc.then === 'function') _rc.catch((e) => { report.errors.push(classify(e, 'runner')); finish(); });
