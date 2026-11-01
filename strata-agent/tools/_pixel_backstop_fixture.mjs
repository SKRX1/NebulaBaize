// Pixel-backstop fixture (called by tests/test_closeout_pixel.py via node).
// jsdom renders the REAL DOM via the REAL functions (same setup as the green mechanism gate
// test_closeout_backstop.mjs), writes STATIC snapshots (inline real CSS, immediate-execution
// computed-style probe). Edge (driven by the gate) then screenshots each snapshot and reads the
// probe back via --dump-dom. arg1 = out dir. Prints a jsdom-layer truth line per scene.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire("C:/Users/sk/.workbuddy/binaries/node/workspace/");
const { JSDOM } = require("jsdom");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..", "serve", "web");
const OUTDIR = process.argv[2] || path.join(HERE, "_pixel_measure_out");
fs.mkdirSync(OUTDIR, { recursive: true });

const html0 = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
const dom = new JSDOM(html0, { url: "http://127.0.0.1:8765/", runScripts: "outside-only" });
const win = dom.window, doc = win.document;
win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder; win.AbortController = AbortController;
win.matchMedia = () => ({ matches: false, media: "", onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
if (typeof win.requestAnimationFrame !== "function") win.requestAnimationFrame = (cb) => setTimeout(() => cb(win.performance.now()), 0);
win.localStorage.setItem("strata.lang", "zh");
if (!win.crypto || typeof win.crypto.getRandomValues !== "function") {
  Object.defineProperty(win, "crypto", { configurable: true, value: { getRandomValues: (a) => { for (let i=0;i<a.length;i++) a[i]=Math.floor(Math.random()*4294967296); return a; } } });
}
win.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
win.eval(fs.readFileSync(path.join(WEB, "i18n.js"), "utf8"));
win.eval(fs.readFileSync(path.join(WEB, "app.js"), "utf8") + ';window.__api={renderNextSteps,msgEl};');
const api = win.__api;

const TOKENS = fs.readFileSync(path.join(WEB, "tokens.css"), "utf8");
const APPCSS = fs.readFileSync(path.join(WEB, "app.css"), "utf8");

function renderBox(mIn) {
  const m = { role: "assistant", text: "x", time: Date.now(), ...mIn };
  const el = api.msgEl(m, 0);
  doc.getElementById("chat").appendChild(el);
  api.renderNextSteps(el, m);
  return el.querySelector(".next-steps");
}
// Scenes mirror the mechanism-gate differential contract.
const scenes = {
  A: renderBox({ steps: [], plan: [{ label: "1", done: true }, { label: "2", done: true }] }),
  C: renderBox({ steps: [], proposals: [{ id: "p1", title: "t", verified: true, dismissed: false, options: [] }] }),
  B: renderBox({ steps: [] }),
};

function snapshot(boxOuter) {
  return `<!doctype html>\n<html data-theme="light"><head><meta charset="utf-8"><title>BASE</title>
<style>${TOKENS}\n${APPCSS}
body{background:#ffffff;margin:0;padding:40px;}</style></head>
<body><div style="max-width:520px">${boxOuter}</div>
<script>
var box=document.querySelector('.next-steps');
var rem=box&&box.querySelector('.next-steps__reminder');
function vis(n){if(!n)return 'MISSING';var c=getComputedStyle(n);var r=n.getBoundingClientRect();
  var ok=c.display!=='none'&&c.visibility!=='hidden'&&parseFloat(c.opacity)>0.02&&r.width>0&&r.height>0;
  return ok?'VISIBLE':'HIDDEN';}
document.title='PROBE::'+JSON.stringify({box_hidden:box?box.hidden:'NOBOX',box_vis:vis(box),reminder:rem?vis(rem):'NONE'});
<\/script></body></html>`;
}

for (const scene of ["A", "C", "B"]) {
  const box = scenes[scene];
  fs.writeFileSync(path.join(OUTDIR, `snap_${scene}.html`), snapshot(box ? box.outerHTML : "<div>NOBOX</div>"));
  console.log(`jsdom ${scene}: box=${box?('hidden='+box.hidden):'NOBOX'} reminder=${box?(box.querySelector('.next-steps__reminder')?'PRESENT':'NONE'):'NOBOX'}`);
}
console.log("SNAPSHOTS_WRITTEN", OUTDIR);
process.exit(0);   // app.js boots timers/rAF -> Node event loop never drains without this
